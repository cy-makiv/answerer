"use strict";

// Long side of the image sent to the server. Fewer pixels = fewer input tokens = faster answer,
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

// ---------- Asking ----------

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

async function ask(dataUrl) {
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;

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

  const handle = (msg) => {
    if (msg.t) {
      if (!gotText) {
        gotText = true;
        answerEl.classList.remove("dots");
        statusEl.textContent = "Answer";
        timingEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
      }
      answerEl.textContent += msg.t;
    } else if (msg.error) {
      setError(msg.error);
    } else if (msg.done && gotText) {
      timingEl.textContent += ` · done ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    }
  };

  try {
    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server error (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
    if (!gotText && !answerEl.classList.contains("error")) setError("No answer came back. Try again.");
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(navigator.onLine === false ? "You're offline." : err.message || "Network error. Try again.");
  } finally {
    if (controller === ctrl) {
      controller = null;
      document.body.classList.remove("busy");
    }
  }
}

// Open the connection to our server early so the first answer doesn't pay for it.
fetch("/api/health").catch(() => {});
startCamera();
