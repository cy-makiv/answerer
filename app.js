import Anthropic from "./vendor/anthropic-sdk.mjs";

const MODEL = "claude-opus-5-5";

// Long side of the image sent to Claude. Fewer pixels = fewer input tokens = faster answer,
// while 1280px still keeps normal printed text readable.
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.85;

const $ = (id) => document.getElementById(id);
const video = $("video");
const frozen = $("frozen");
const guide = $("guide");
const canvas = $("canvas");
const sheet = $("sheet");
const statusEl = $("status");
const timingEl = $("timing");
const answerEl = $("answer");
const shutter = $("shutter");
const torchBtn = $("torch");
const fileInput = $("file");
const camError = $("camera-error");
const camErrorText = $("camera-error-text");

let stream = null;
let controller = null;
let torchOn = false;

// ---------- Camera ----------

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError(
      window.isSecureContext
        ? "This browser can't open the camera. Use the photo button below."
        : "Live camera needs HTTPS. Use the photo button below, or open this page over https://.",
      false,
    );
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    camError.hidden = true;
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() ?? {};
    if (caps.focusMode?.includes("continuous")) {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    torchBtn.hidden = !caps.torch;
    track.addEventListener("ended", () => { stream = null; });
  } catch (err) {
    const denied = err?.name === "NotAllowedError";
    showCameraError(
      denied
        ? "Camera permission was denied. Allow it in your browser settings, or use the photo button below."
        : "Couldn't start the camera. Use the photo button below.",
      true,
    );
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  torchOn = false;
  torchBtn.classList.remove("on");
}

function showCameraError(text, canRetry) {
  camErrorText.textContent = text;
  $("retry-camera").hidden = !canRetry;
  camError.hidden = false;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera();
  else if (!stream) startCamera();
});

$("retry-camera").addEventListener("click", startCamera);

torchBtn.addEventListener("click", async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    torchBtn.classList.toggle("on", torchOn);
  } catch {}
});

// ---------- Capture ----------

// Crop the live video to the on-screen guide frame (plus a small margin), then downscale.
function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const v = video.getBoundingClientRect();
  const g = guide.getBoundingClientRect();
  // The video is drawn with object-fit: cover, so map screen coords back to video pixels.
  const scale = Math.max(v.width / vw, v.height / vh);
  const offX = (v.width - vw * scale) / 2;
  const offY = (v.height - vh * scale) / 2;
  const margin = g.width * 0.04;

  const sx = clamp((g.left - v.left - margin - offX) / scale, 0, vw);
  const sy = clamp((g.top - v.top - margin - offY) / scale, 0, vh);
  const ex = clamp((g.right - v.left + margin - offX) / scale, 0, vw);
  const ey = clamp((g.bottom - v.top + margin - offY) / scale, 0, vh);

  return drawScaled(video, sx, sy, ex - sx, ey - sy);
}

function drawScaled(source, sx, sy, sw, sh) {
  if (sw < 2 || sh < 2) return null;
  const ratio = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  canvas.width = Math.round(sw * ratio);
  canvas.height = Math.round(sh * ratio);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function onShutter() {
  if (!settings.apiKey) {
    showSettings("Add your API key first.");
    return;
  }
  frozen.hidden = true;
  if (!stream) {
    fileInput.click();
    return;
  }
  const dataUrl = captureFrame();
  if (!dataUrl) return;
  navigator.vibrate?.(15);
  flash();
  ask(dataUrl);
}

function flash() {
  video.animate([{ filter: "brightness(1.8)" }, { filter: "brightness(1)" }], { duration: 160 });
}

shutter.addEventListener("click", onShutter);
// Tapping anywhere on the camera view also captures - a bigger target is faster.
video.addEventListener("click", onShutter);
frozen.addEventListener("click", onShutter);
document.addEventListener("keydown", (e) => {
  if ((e.code === "Space" || e.code === "Enter") && e.target === document.body) {
    e.preventDefault();
    onShutter();
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const dataUrl = drawScaled(bitmap, 0, 0, bitmap.width, bitmap.height);
    frozen.src = URL.createObjectURL(file);
    frozen.hidden = false;
    bitmap.close?.();
    if (dataUrl) ask(dataUrl);
  } catch {
    showSheet();
    setError("Couldn't open that image.");
  }
});

// ---------- Settings (stored only on this phone) ----------

const SETTINGS_KEY = "answerer.settings";
const settingsForm = $("settings");
const keyInput = $("api-key");
const effortSelect = $("effort");
const fastCheck = $("fast");
const settingsError = $("settings-error");
const saveBtn = $("save");
const cancelBtn = $("cancel");

let settings = loadSettings();
let client = null;

function loadSettings() {
  const defaults = { apiKey: "", effort: "low", fast: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function storeSettings(next) {
  settings = next;
  client = null;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
}

function getClient() {
  // The key is typed in by the phone's owner and sent only to api.anthropic.com.
  client ??= new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  return client;
}

function showSettings(message = "") {
  keyInput.value = settings.apiKey;
  effortSelect.value = settings.effort;
  fastCheck.checked = settings.fast;
  settingsError.textContent = message;
  cancelBtn.hidden = !settings.apiKey;
  settingsForm.hidden = false;
  if (!settings.apiKey) setTimeout(() => keyInput.focus(), 50);
}

$("open-settings").addEventListener("click", () => showSettings());
cancelBtn.addEventListener("click", () => { settingsForm.hidden = true; });

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const apiKey = keyInput.value.trim();
  if (!apiKey) return;
  saveBtn.disabled = true;
  settingsError.textContent = "Checking key…";
  try {
    // Free call that confirms the key works before the first photo.
    await new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 }).models.retrieve(MODEL);
    storeSettings({ apiKey, effort: effortSelect.value, fast: fastCheck.checked });
    settingsError.textContent = "";
    settingsForm.hidden = true;
    keyInput.blur();
  } catch (err) {
    settingsError.textContent =
      err instanceof Anthropic.AuthenticationError ? "That API key was rejected. Check it and try again."
      : err instanceof Anthropic.PermissionDeniedError ? "This key isn't allowed to use Claude Opus 5.5."
      : err instanceof Anthropic.APIConnectionError ? "Couldn't reach Anthropic. Check your connection."
      : `Couldn't check the key: ${err.message || err}`;
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------- Asking ----------

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

let current = null; // the in-flight request, so a new photo can cancel it

function showSheet() {
  sheet.hidden = false;
  sheet.scrollTop = 0;
  document.body.classList.add("answering");
}

function setError(msg) {
  statusEl.textContent = "Error";
  statusEl.classList.add("error");
  answerEl.classList.remove("dots");
  answerEl.classList.add("error");
  answerEl.textContent = msg;
}

function startStream(base64, speed) {
  return getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    // If Claude declines for safety reasons, the API re-runs the request on a fallback model in the same stream.
    fallbacks: "default",
    output_config: { effort: settings.effort },
    ...(speed ? { speed } : {}),
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: "Answer the question in this photo." },
        ],
      },
    ],
  });
}

async function ask(dataUrl) {
  current?.stream?.abort();
  const job = { stream: null };
  current = job;

  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const t0 = performance.now();
  let gotText = false;

  showSheet();
  document.body.classList.add("busy");
  statusEl.classList.remove("error");
  statusEl.textContent = "Reading the question";
  timingEl.textContent = "";
  answerEl.classList.remove("error");
  answerEl.classList.add("dots");
  answerEl.textContent = "";

  const onText = (t) => {
    if (current !== job) return;
    if (!gotText) {
      gotText = true;
      answerEl.classList.remove("dots");
      statusEl.textContent = "Answer";
      timingEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
    }
    answerEl.textContent += t;
  };

  const run = (speed) => {
    job.stream = startStream(base64, speed);
    job.stream.on("text", onText);
    return job.stream.finalMessage();
  };

  try {
    let message;
    try {
      message = await run(settings.fast ? "fast" : undefined);
    } catch (err) {
      // Fast mode has its own rate limit; fall back to normal speed rather than fail.
      if (settings.fast && !gotText && current === job && err instanceof Anthropic.RateLimitError) {
        message = await run(undefined);
      } else {
        throw err;
      }
    }
    if (current !== job) return;
    if (message.stop_reason === "refusal") {
      setError("This question couldn't be answered. Try another photo.");
    } else if (!gotText) {
      setError("No answer came back. Try again.");
    } else {
      if (message.stop_reason === "max_tokens") answerEl.textContent += "\n…(answer cut off)";
      timingEl.textContent += ` · done ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    }
  } catch (err) {
    if (current !== job || err instanceof Anthropic.APIUserAbortError) return;
    console.error(err);
    if (err instanceof Anthropic.AuthenticationError) {
      setError("Your API key was rejected.");
      showSettings("Your API key was rejected. Enter a working key.");
    } else if (err instanceof Anthropic.RateLimitError) {
      setError("Too many requests right now. Try again in a moment.");
    } else if (err instanceof Anthropic.BadRequestError) {
      setError(/credit|billing/i.test(err.message) ? "Your Anthropic account is out of credits." : "The photo couldn't be processed. Try again.");
    } else if (err instanceof Anthropic.APIConnectionError) {
      setError(navigator.onLine === false ? "You're offline." : "Couldn't reach Anthropic. Check your connection.");
    } else if (err instanceof Anthropic.APIError && err.status >= 500) {
      setError("Claude is busy right now. Try again.");
    } else {
      setError("Something went wrong. Try again.");
    }
  } finally {
    if (current === job) {
      current = null;
      document.body.classList.remove("busy");
    }
  }
}

if (!settings.apiKey) showSettings();
startCamera();
