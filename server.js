import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.ANSWERER_MODEL || "claude-opus-5-5";
// "low" keeps thinking short, which is most of the wait on a quick question.
const EFFORT = process.env.ANSWERER_EFFORT || "low";
// Fast mode: up to ~2.5x faster output at 2x the token price. Opt in with ANSWERER_FAST_MODE=1.
const FAST_MODE = /^(1|true|yes)$/i.test(process.env.ANSWERER_FAST_MODE || "");

const SYSTEM = `You look at a photo taken with a phone camera and answer the question shown in it.

Speed matters more than anything else: the person is waiting with their phone in hand.

Rules:
- Start with the answer itself on the first line. No preamble, no restating the question.
- For multiple choice, give the letter/number and the option text, e.g. "C) 1945".
- For math, give the final result first, then at most 3 short lines of working.
- After the answer, add at most two short sentences of explanation, only if they help.
- If several questions are visible, answer each one on its own line, numbered as in the image.
- If the photo is blurry or cut off but you can still make out the question, answer it.
- If there is no question in the image, briefly say what you see and suggest aiming at the question.
- Plain text only: no Markdown, no LaTeX, no headings. Use unicode symbols (×, ÷, √, ², π) for math.`;

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Access code: when set, every answer request must carry it, so a leaked link can't spend your API credits.
const ACCESS_CODE = (process.env.ANSWERER_ACCESS_CODE || "").trim();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const ACCESS_CODE_HASH = ACCESS_CODE ? sha256(ACCESS_CODE) : null;

// Slow down guessing: at most MAX_FAILS wrong codes per IP per window.
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
const failures = new Map(); // ip -> { count, resetAt }

function codeMatches(code) {
  return typeof code === "string" && crypto.timingSafeEqual(sha256(code.trim()), ACCESS_CODE_HASH);
}

function requireAccessCode(req, res, next) {
  if (!ACCESS_CODE_HASH) return next();
  const now = Date.now();
  let entry = failures.get(req.ip);
  if (entry && entry.resetAt <= now) {
    failures.delete(req.ip);
    entry = undefined;
  }
  if (entry && entry.count >= MAX_FAILS) {
    res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
    res.status(429).json({ error: "Too many wrong codes. Try again in a few minutes." });
    return;
  }
  if (codeMatches(req.get("x-access-code"))) return next();
  if (!entry) failures.set(req.ip, (entry = { count: 0, resetAt: now + FAIL_WINDOW_MS }));
  entry.count++;
  res.status(401).json({ error: "Wrong access code.", codeRequired: true });
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of failures) if (e.resetAt <= now) failures.delete(ip);
}, FAIL_WINDOW_MS).unref();

const client = new Anthropic({ maxRetries: 1 });

const app = express();
app.disable("x-powered-by");
// Behind one proxy (Render, Railway, a tunnel), so req.ip is the phone's address, not the proxy's.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
app.use(express.static(path.join(here, "public"), { maxAge: "1h" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, codeRequired: Boolean(ACCESS_CODE_HASH) });
});

// Lets the phone check a code once, before the first photo, instead of failing mid-question.
app.post("/api/unlock", requireAccessCode, (_req, res) => {
  res.status(204).end();
});

function parseImage(body) {
  const raw = typeof body?.image === "string" ? body.image : "";
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(raw);
  if (!match || !MEDIA_TYPES.has(match[1])) return null;
  return { mediaType: match[1], data: match[2] };
}

function startStream(image, speed) {
  return client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    // On a safety decline, the API re-runs the request on a fallback model in the same stream.
    fallbacks: "default",
    output_config: { effort: EFFORT },
    ...(speed ? { speed } : {}),
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
          { type: "text", text: "Answer the question in this photo." },
        ],
      },
    ],
  });
}

// Check the code before reading the (up to 10 MB) body.
app.post("/api/answer", requireAccessCode, express.json({ limit: "10mb" }), async (req, res) => {
  const image = parseImage(req.body);
  if (!image) {
    res.status(400).json({ error: "Send { image: 'data:image/jpeg;base64,...' }" });
    return;
  }

  const started = Date.now();
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx etc.)
  res.flushHeaders();
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  let stream;
  let sentText = false;
  let firstTokenMs = null;
  res.on("close", () => {
    if (!res.writableFinished) stream?.abort(); // user cancelled / retook the photo
  });

  const run = async (speed) => {
    stream = startStream(image, speed);
    stream.on("text", (t) => {
      if (firstTokenMs === null) firstTokenMs = Date.now() - started;
      sentText = true;
      send({ t });
    });
    return stream.finalMessage();
  };

  try {
    let message;
    try {
      message = await run(FAST_MODE ? "fast" : undefined);
    } catch (err) {
      // Fast mode has its own rate limit; fall back to standard speed rather than fail.
      if (FAST_MODE && !sentText && err instanceof Anthropic.RateLimitError) {
        message = await run(undefined);
      } else {
        throw err;
      }
    }

    if (message.stop_reason === "refusal") {
      send({ error: "This question couldn't be answered. Try another photo." });
    } else if (message.stop_reason === "max_tokens") {
      send({ t: "\n…(answer cut off)" });
    }
    const totalMs = Date.now() - started;
    console.log(
      `answer: first token ${firstTokenMs ?? "-"}ms, total ${totalMs}ms, ` +
        `in ${message.usage.input_tokens} / out ${message.usage.output_tokens} tokens, speed ${message.usage.speed ?? "standard"}`,
    );
    send({ done: true, firstTokenMs, totalMs });
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) return;
    console.error("answer failed:", err);
    let msg = "Something went wrong. Try again.";
    if (err instanceof Anthropic.AuthenticationError) msg = "Server API key is missing or invalid.";
    else if (err instanceof Anthropic.RateLimitError) msg = "Too many requests right now. Try again in a moment.";
    else if (err instanceof Anthropic.BadRequestError) msg = "The photo couldn't be processed. Try again.";
    else if (err instanceof Anthropic.APIConnectionError) msg = "Couldn't reach the AI service. Check the connection.";
    else if (err instanceof Anthropic.APIError && err.status >= 500) msg = "The AI service is busy. Try again.";
    if (!res.writableEnded) send({ error: msg });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// Phone browsers only allow camera access on HTTPS (or localhost).
// Set HTTPS_KEY and HTTPS_CERT to serve HTTPS directly, e.g. with a mkcert certificate.
let server;
if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
  server = https.createServer(
    { key: fs.readFileSync(process.env.HTTPS_KEY), cert: fs.readFileSync(process.env.HTTPS_CERT) },
    app,
  );
} else {
  server = http.createServer(app);
}
server.keepAliveTimeout = 65_000;

server.listen(PORT, () => {
  const scheme = server instanceof https.Server ? "https" : "http";
  console.log(`Answerer on ${scheme}://localhost:${PORT}  (model ${MODEL}, effort ${EFFORT}, fast mode ${FAST_MODE ? "on" : "off"})`);
  if (!ACCESS_CODE_HASH) {
    console.warn("Warning: no ANSWERER_ACCESS_CODE set - anyone with the link can use your API key.");
  }
});
