# Answerer

Point your phone camera at a question, tap, and get the answer in seconds.

- Live rear-camera view with a framing guide. Tap the shutter (or anywhere on the picture).
- Only the area inside the frame is sent, resized to at most 1280px. Fewer pixels means fewer tokens and a faster answer.
- The answer streams in as it is written. It starts with the answer itself, then a short explanation.
- No live camera (no HTTPS, or permission denied)? The camera button opens the phone's own camera or photo picker instead.
- The screen shows how long the answer took: time to the first word, and time until it finished.

## Run it

Needs Node 18+ and an Anthropic API key.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start            # http://localhost:3000
```

### Opening it on your phone

Phone browsers only allow live camera access on **HTTPS** (or `localhost`). Choose one:

1. **Tunnel (easiest):** `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`), then open the `https://` URL on your phone.
2. **Local HTTPS:** create a certificate for your computer's LAN IP with [mkcert](https://github.com/FiloSottile/mkcert), then run
   `HTTPS_KEY=key.pem HTTPS_CERT=cert.pem npm start` and open `https://<your-lan-ip>:3000`.
3. **Deploy** it to any Node host (Render, Railway, Fly.io, …). Set `ANTHROPIC_API_KEY` there.

Over plain `http://` on your LAN the page still works, but only through the photo button.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Required. |
| `PORT` | `3000` | Port to listen on. |
| `ANSWERER_MODEL` | `claude-opus-5-5` | Claude model to use. |
| `ANSWERER_EFFORT` | `low` | How much the model thinks: `low`, `medium`, `high`, `xhigh`, `max`. `low` is fastest; raise it if hard math or logic questions come back wrong. |
| `ANSWERER_FAST_MODE` | off | `1` turns on fast mode: up to ~2.5× faster output at **2× the token price** ($8 / $40 per million input/output tokens instead of $4 / $20). If fast mode is rate-limited, the request falls back to normal speed. |
| `HTTPS_KEY`, `HTTPS_CERT` | – | Paths to a TLS key and certificate, to serve HTTPS directly. |

## How it's built

- `server.js`: an Express server. `POST /api/answer` takes `{ image: "data:image/jpeg;base64,..." }` and streams back NDJSON lines (`{"t": "..."}` text chunks, then `{"done": true}`, or `{"error": "..."}`). It calls the Claude Messages API through the official `@anthropic-ai/sdk` with streaming, low effort and a short-answer system prompt. It also turns on server-side refusal fallback (`fallbacks: "default"`): if the model declines a request, the API runs it again on a fallback model in the same stream.
- `public/`: the phone UI, in plain HTML, CSS and JavaScript with no build step.

The server logs time to first token, total time and token counts for each answer.
