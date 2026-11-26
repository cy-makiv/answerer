# Answerer

Point your phone camera at a question, tap, and get the answer in seconds.

The whole app is a few static files (HTML, CSS, JavaScript). There's no server. Your phone sends the photo straight to Claude using your own Anthropic API key, which is saved only on your phone.

- Live rear-camera view with a framing guide. Tap the shutter (or anywhere on the picture).
- Zoom with a pinch or the 1× / 2× / 3× buttons. The camera's own zoom is used where the browser allows it, otherwise the zoom is digital. The zoomed view inside the frame is what gets sent.
- Only the area inside the frame is sent, resized to at most 1280px. Fewer pixels means fewer tokens and a faster answer.
- The answer streams in as it is written. It starts with the answer itself, then a short explanation.
- The screen shows how long the answer took: time to the first word, and time until it finished.
- If live camera access isn't available, the camera button opens the phone's own camera or photo picker instead.

## Put it on your phone with GitHub Pages

1. **Make sure Pages is available for this repo.** GitHub Pages is free for **public** repos. A **private** repo needs a paid GitHub plan (Pro, Team or Enterprise). The code holds no secrets, so making the repo public is safe. Either way, the Pages site itself is public: anyone with the link can open the page, but it does nothing without an API key.
2. In the repo on GitHub, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch that has this code and the **/ (root)** folder, then click **Save**.
3. After a minute or so, Pages shows your link: `https://<your-username>.github.io/answerer/`.
4. Open that link on your phone:
   - **iPhone:** in Safari, tap **Share → Add to Home Screen**.
   - **Android:** in Chrome, tap **⋮ → Add to Home screen** (or **Install app**).
5. Open the app from the home screen, paste your API key into Settings, then tap **Allow** when it asks for the camera.

### Use a dedicated API key

Create a separate key for this app at [console.anthropic.com](https://console.anthropic.com) and set a monthly spend limit on it. The key is stored in your phone's browser storage, so anyone who can unlock your phone could get to it. If that ever happens, you can delete this one key without affecting anything else.

## Run it only on your own computer (nothing online)

```bash
npm start        # serves the folder on http://localhost:8080
```

Open `http://<your-computer's-LAN-IP>:8080` on your phone while it's on the same Wi-Fi. Phones only allow the live camera view on HTTPS, so over plain http you use the camera button. It opens the phone's camera app: take the photo and the answer comes back the same way.

## Settings (on the phone, gear icon)

| Setting | Default | What it does |
|---|---|---|
| API key | – | Your Anthropic API key. Checked when you save it. |
| Thinking | Low | How much Claude thinks before answering. Low is fastest. Medium is better at hard math. |
| Fast mode | Off | Answers write out up to ~2.5× faster, but cost **2× as much** ($8 / $40 per million input/output tokens instead of $4 / $20). If fast mode is busy, the request falls back to normal speed. |

## How it's built

- `index.html`, `style.css`, `app.js`: the app, with no build step.
- `vendor/anthropic-sdk.mjs`: the official `@anthropic-ai/sdk`, bundled for the browser. Rebuild it with `npm install && npm run build:vendor`.
- Requests use Claude Opus 5.5 with streaming, low effort by default, and a short-answer system prompt. They also turn on server-side refusal fallback (`fallbacks: "default"`): if the model declines a request, the API runs it again on a fallback model in the same stream.
