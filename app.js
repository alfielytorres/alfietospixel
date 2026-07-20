/* VERSIONS EYE — UI wiring: load image/video, build controls,
 * run the effect pipeline (live for video), export PNG / SVG / MOV. */
"use strict";

(() => {
  const MAX_DIM = 1600;        // cap for still images
  const MAX_VIDEO_DIM = 960;   // preview cap so per-frame effects stay realtime
  const MAX_CLIP_SECONDS = 10; // videos are trimmed to their first 10s
  const MAX_FILE_SECONDS = 15; // videos longer than this are rejected outright
  const EXPORT_FPS = 30;
  const SVG_MAX_CELLS = 280;   // grid cap on the long edge for SVG export

  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");

  let mode = "image";          // "image" | "video"
  let sourceImage = null;      // ImageData for image mode
  let seed = (Math.random() * 0xffffffff) >>> 0;
  let renderQueued = false;
  let holdOriginal = false;

  // video state
  let videoEl = null;
  let videoUrl = null;
  let vidRaf = 0;
  let clipEnd = MAX_CLIP_SECONDS;
  const vidCanvas = document.createElement("canvas");
  const vctx = vidCanvas.getContext("2d", { willReadFrequently: true });

  // export state
  let exporting = false;
  let cancelExport = false;
  let recorder = null;
  let recording = false;
  let recChunks = [];

  // ---- effect chain state, built from the registry ----
  const chain = {};
  for (const e of Effects.REGISTRY) {
    chain[e.id] = { enabled: false, params: structuredClone(e.defaults) };
  }
  chain.dither.enabled = true;

  // ---- overlays: ORBS/LINES are full-frame modules that react to the
  // image; STARs are individual draggable sprites ----
  const overlayModules = {
    orbs: { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.orbs.defaults) },
    lines: { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.lines.defaults) },
  };
  let stars = [];
  let dragIdx = -1;

  // live camera state
  let camStream = null;
  let camVideo = null;
  let liveRaf = 0;
  let liveStart = 0;
  let camFacing = "user";
  let liveRecorder = null;
  let liveRecording = false;
  let liveChunks = [];
  let liveRecStart = 0;
  const MAX_LIVE_SECONDS = 15;

  // =====================================================================
  // rendering — image mode
  // =====================================================================

  function render() {
    if (mode !== "image" || !sourceImage || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      let out = sourceImage;
      if (!holdOriginal) {
        out = Effects.apply(sourceImage, chain, seed);
        out = Effects.renderOverlayStack(out, overlayModules, stars, false);
      }
      canvas.width = out.width;
      canvas.height = out.height;
      ctx.putImageData(out, 0, 0);
    });
  }

  // =====================================================================
  // rendering — video mode: live preview, every frame runs the chain
  // =====================================================================

  function frameSeedAt(frameIndex) {
    // deterministic per-frame seed: glitches animate over time, and the
    // offline export reproduces exactly what the preview showed
    return (seed ^ Math.imul(frameIndex + 1, 2654435761)) >>> 0;
  }

  function videoLoop() {
    if (mode !== "video" || !videoEl || exporting) return;
    if (videoEl.readyState < 2) { // no decoded frame yet — don't draw black
      vidRaf = requestAnimationFrame(videoLoop);
      return;
    }
    hideLoader(); // first decodable frame has arrived
    const vw = vidCanvas.width, vh = vidCanvas.height;

    if (videoEl.ended || videoEl.currentTime >= clipEnd) {
      if (recording) stopRecorder();
      videoEl.currentTime = 0;
      if (videoEl.paused) videoEl.play().catch(() => {});
    }

    vctx.drawImage(videoEl, 0, 0, vw, vh);
    if (thumbsStale) { thumbsStale = false; renderLookThumbs(); }
    let frame = vctx.getImageData(0, 0, vw, vh);
    if (!holdOriginal) {
      frame = Effects.apply(frame, chain, frameSeedAt(Math.floor(videoEl.currentTime * EXPORT_FPS)));
      frame = Effects.renderOverlayStack(frame, overlayModules, stars, true);
    }
    if (canvas.width !== vw) canvas.width = vw;
    if (canvas.height !== vh) canvas.height = vh;
    ctx.putImageData(frame, 0, 0);

    if (recording) {
      $("export-video-btn").textContent =
        `REC ${videoEl.currentTime.toFixed(1)}S / ${clipEnd.toFixed(1)}S`;
    }
    vidRaf = requestAnimationFrame(videoLoop);
  }

  function showOriginal(show) {
    holdOriginal = show;
    render(); // video loop picks the flag up on its next frame
  }

  // =====================================================================
  // loading
  // =====================================================================

  function showLoader(text) {
    $("loader-text").textContent = text;
    $("loader").hidden = false;
  }
  function hideLoader() {
    $("loader").hidden = true;
  }

  function enterWorkspace() {
    document.body.classList.add("in-app");
    $("dropzone").hidden = true;
    $("workspace").hidden = false;
    updateModeUI();
    // reveal animation: quick pop + scanline sweep over the fresh canvas
    const wrap = $("canvas-wrap");
    wrap.classList.remove("reveal");
    void wrap.offsetWidth; // restart the animation
    wrap.classList.add("reveal");
    setTimeout(() => wrap.classList.remove("reveal"), 1000);
    firstRunTip();
    thumbsStale = true;
    if (mode === "image") { thumbsStale = false; renderLookThumbs(); }
  }

  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => { t.hidden = true; }, 350);
    }, ms || 3200);
  }

  function firstRunTip() {
    let seen = null;
    try { seen = localStorage.getItem("versions-eye-tip"); } catch { /* private mode */ }
    if (seen) return;
    try { localStorage.setItem("versions-eye-tip", "1"); } catch { /* ignore */ }
    setTimeout(() => toast("tap a look below · hold for original · reroll for a new glitch", 4200), 600);
  }

  function updateModeUI() {
    const isVideo = mode === "video";
    const isLive = mode === "live";
    $("playpause-btn").hidden = !isVideo;
    $("export-video-btn").hidden = !isVideo;
    $("res-wrap").hidden = !isVideo;
    $("playpause-btn").textContent = "PAUSE";
    $("ab-play").hidden = !isVideo;
    $("ab-play").textContent = "PAUSE";
    $("record-btn").hidden = !isLive;
    $("flip-btn").hidden = !isLive;
    $("ab-flip").hidden = !isLive;
    $("ab-export").textContent = isLive ? "RECORD" : "EXPORT";
    $("nv-export").hidden = !(isVideo || isLive);
    $("nv-export").textContent = isLive ? "record" : "export mov";
  }

  function cleanupVideo() {
    cancelAnimationFrame(vidRaf);
    cancelExport = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recording = false;
    exporting = false;
    if (videoEl) videoEl.pause();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoEl = null;
    videoUrl = null;
    $("export-video-btn").disabled = false;
    $("export-video-btn").textContent = "mov";
  }

  function loadFromImageElement(imgEl) {
    cleanupVideo();
    cleanupLive();
    let w = imgEl.naturalWidth || imgEl.width;
    let h = imgEl.naturalHeight || imgEl.height;
    if (!w || !h) return;
    const ratio = Math.min(1, MAX_DIM / Math.max(w, h));
    w = Math.max(1, Math.round(w * ratio));
    h = Math.max(1, Math.round(h * ratio));
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d");
    octx.drawImage(imgEl, 0, 0, w, h);
    sourceImage = octx.getImageData(0, 0, w, h);
    mode = "image";
    enterWorkspace();
    render();
  }

  // =====================================================================
  // LIVE mode — camera + mic through the same effect pipeline, with an
  // optional recording (video + voice) capped at 15 seconds
  // =====================================================================

  function cleanupLive() {
    cancelAnimationFrame(liveRaf);
    if (liveRecorder && liveRecorder.state !== "inactive") {
      try { liveRecorder.stop(); } catch { /* already stopping */ }
    }
    liveRecording = false;
    if (camStream) for (const t of camStream.getTracks()) t.stop();
    camStream = null;
    camVideo = null;
    $("record-btn").textContent = "record";
    $("record-btn").classList.remove("rec-live");
    $("ab-export").classList.remove("rec-live");
  }

  async function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("This browser can't open the camera. Note: camera needs HTTPS.");
      return;
    }
    cleanupVideo();
    cleanupLive();
    showLoader("starting camera…");
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch (e) {
      hideLoader();
      alert("Camera/microphone access was blocked. Allow it in your browser settings and try again.");
      return;
    }
    const v = document.createElement("video");
    v.muted = true; // no feedback loop; the mic track still records
    v.playsInline = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.srcObject = camStream;
    v.addEventListener("loadedmetadata", () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { hideLoader(); cleanupLive(); return; }
      const dimCap = isMobile() ? 640 : MAX_VIDEO_DIM;
      const ratio = Math.min(1, dimCap / Math.max(w, h));
      vidCanvas.width = Math.max(1, Math.round(w * ratio));
      vidCanvas.height = Math.max(1, Math.round(h * ratio));
      camVideo = v;
      mode = "live";
      liveStart = performance.now();
      enterWorkspace();
      v.play().catch(() => {});
      cancelAnimationFrame(liveRaf);
      liveRaf = requestAnimationFrame(liveLoop);
    }, { once: true });
  }

  function liveLoop() {
    if (mode !== "live" || !camVideo) return;
    if (camVideo.readyState < 2) {
      liveRaf = requestAnimationFrame(liveLoop);
      return;
    }
    hideLoader();
    const vw = vidCanvas.width, vh = vidCanvas.height;
    vctx.drawImage(camVideo, 0, 0, vw, vh);
    if (thumbsStale) { thumbsStale = false; renderLookThumbs(); }
    let frame = vctx.getImageData(0, 0, vw, vh);
    if (!holdOriginal) {
      const f = Math.floor(((performance.now() - liveStart) / 1000) * EXPORT_FPS);
      frame = Effects.apply(frame, chain, frameSeedAt(f));
      frame = Effects.renderOverlayStack(frame, overlayModules, stars, true);
    }
    if (canvas.width !== vw) canvas.width = vw;
    if (canvas.height !== vh) canvas.height = vh;
    ctx.putImageData(frame, 0, 0);

    if (liveRecording) {
      const el = (performance.now() - liveRecStart) / 1000;
      const label = `stop ${el.toFixed(1)}s / ${MAX_LIVE_SECONDS}s`;
      $("record-btn").textContent = label;
      $("ab-export").textContent = "STOP " + el.toFixed(0) + "S";
      if (el >= MAX_LIVE_SECONDS) stopLiveRecord();
    }
    liveRaf = requestAnimationFrame(liveLoop);
  }

  function stopLiveRecord() {
    if (liveRecorder && liveRecorder.state !== "inactive") liveRecorder.stop();
  }

  function toggleLiveRecord() {
    if (mode !== "live" || !camStream) return;
    if (liveRecording) { stopLiveRecord(); return; }
    if (typeof MediaRecorder === "undefined") {
      alert("This browser doesn't support recording.");
      return;
    }
    const pick = [
      ["video/mp4;codecs=avc1.64002A", "mov"],
      ["video/mp4", "mov"],
      ["video/webm;codecs=vp9,opus", "webm"],
      ["video/webm;codecs=vp8,opus", "webm"],
      ["video/webm", "webm"],
    ].find(([m]) => MediaRecorder.isTypeSupported(m));
    if (!pick) { alert("No supported recording format found."); return; }
    const [mime, ext] = pick;

    const stream = canvas.captureStream(EXPORT_FPS);
    for (const t of camStream.getAudioTracks()) stream.addTrack(t); // voice in
    liveRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    liveChunks = [];
    liveRecorder.ondataavailable = (e) => { if (e.data.size) liveChunks.push(e.data); };
    liveRecorder.onstop = () => {
      liveRecording = false;
      $("record-btn").textContent = "record";
      $("record-btn").classList.remove("rec-live");
      $("ab-export").textContent = "RECORD";
      $("ab-export").classList.remove("rec-live");
      if (liveChunks.length) {
        deliverFile(new Blob(liveChunks, { type: liveRecorder.mimeType || mime }),
          `versions-eye-live-${Date.now().toString(36)}.${ext}`);
      }
    };
    liveRecorder.start(200);
    liveRecording = true;
    liveRecStart = performance.now();
    $("record-btn").classList.add("rec-live");
    $("ab-export").classList.add("rec-live");
  }

  async function flipCamera() {
    if (mode !== "live") return;
    camFacing = camFacing === "user" ? "environment" : "user";
    await startLive();
  }

  // ---- HEIC (iPhone photos): Safari decodes natively; everywhere else we
  // lazy-load the vendored libheif wasm decoder (only fetched when needed) ----
  let heifModPromise = null;
  function heifModule() {
    if (!heifModPromise) {
      heifModPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/libheif-bundle.js";
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("failed to load HEIC decoder"));
        document.head.appendChild(s);
      }).then(() => (typeof libheif === "function" ? libheif() : libheif));
    }
    return heifModPromise;
  }

  async function loadHeicFile(file) {
    showLoader("DECODING HEIC…");
    try { // native decode first (Safari, some Android)
      const bmp = await createImageBitmap(file);
      loadFromImageElement(bmp);
      hideLoader();
      return;
    } catch { /* fall through to wasm decoder */ }
    try {
      const mod = await heifModule();
      const decoder = new mod.HeifDecoder();
      const images = decoder.decode(await file.arrayBuffer());
      if (!images || !images.length) throw new Error("no image found in HEIC");
      const image = images[0];
      const w = image.get_width(), h = image.get_height();
      const off = document.createElement("canvas");
      off.width = w; off.height = h;
      const octx = off.getContext("2d");
      const id = octx.createImageData(w, h);
      await new Promise((resolve, reject) => {
        image.display(id, (ok) => (ok ? resolve() : reject(new Error("HEIC decode failed"))));
      });
      octx.putImageData(id, 0, 0);
      for (const im of images) { try { im.free(); } catch { /* best effort */ } }
      loadFromImageElement(off);
    } catch (e) {
      console.error(e);
      alert("Couldn't decode this HEIC image in this browser. Try converting it to JPEG/PNG.");
    } finally {
      hideLoader();
    }
  }

  function loadVideoFile(file) {
    cleanupVideo();
    cleanupLive();
    showLoader("LOADING VIDEO…");
    videoUrl = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    // iOS Safari needs the attributes (not just properties) + explicit load()
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.preload = "auto";
    const looksApple = /quicktime|\.mov$|\.m4v$/i.test(file.type + " " + (file.name || ""));
    v.addEventListener("error", () => {
      hideLoader();
      cleanupVideo();
      $("workspace").hidden = true;
      $("dropzone").hidden = false;
      alert(looksApple
        ? "This video can't be decoded by your browser. iPhone videos are often HEVC (H.265), " +
          "which needs Safari or a device with hardware HEVC support — or re-export/convert it " +
          "to H.264 MP4 (on iPhone: Settings → Camera → Formats → Most Compatible)."
        : "This video format can't be decoded by your browser.");
    });
    // Some recordings (e.g. MediaRecorder WebMs) report duration=Infinity at
    // metadata time; seeking far past the end forces the real value.
    const resolveDuration = () => new Promise((resolve) => {
      if (isFinite(v.duration) && v.duration > 0) { resolve(v.duration); return; }
      const finish = () => {
        v.removeEventListener("seeked", finish);
        v.currentTime = 0;
        resolve(isFinite(v.duration) && v.duration > 0 ? v.duration : MAX_CLIP_SECONDS);
      };
      v.addEventListener("seeked", finish, { once: true });
      setTimeout(finish, 3000);
      v.currentTime = 1e7;
    });

    v.addEventListener("loadedmetadata", async () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { hideLoader(); cleanupVideo(); return; }
      const duration = await resolveDuration();
      if (duration > MAX_FILE_SECONDS) {
        hideLoader();
        cleanupVideo();
        $("workspace").hidden = true;
        $("dropzone").hidden = false;
        alert(`This video is ${Math.round(duration)}s long — the limit is ${MAX_FILE_SECONDS}s ` +
          `(and only the first ${MAX_CLIP_SECONDS}s are edited). Trim it and try again.`);
        return;
      }
      clipEnd = Math.min(duration, MAX_CLIP_SECONDS);
      // phones get a lower preview cap so per-frame JS effects stay smooth
      const dimCap = isMobile() ? 640 : MAX_VIDEO_DIM;
      const ratio = Math.min(1, dimCap / Math.max(w, h));
      vidCanvas.width = Math.max(1, Math.round(w * ratio));
      vidCanvas.height = Math.max(1, Math.round(h * ratio));
      videoEl = v;
      mode = "video";
      cancelExport = false;
      enterWorkspace();
      v.play().catch(() => {
        // autoplay refused (e.g. iOS Low Power Mode) — surface the play button
        $("playpause-btn").textContent = "PLAY";
        $("ab-play").textContent = "PLAY";
      });
      cancelAnimationFrame(vidRaf);
      vidRaf = requestAnimationFrame(videoLoop);
    }, { once: true });
    v.src = videoUrl;
    v.load(); // iOS Safari won't fire loadedmetadata for blob URLs without this
  }

  function loadFile(file) {
    if (!file) return;
    const name = (file.name || "").toLowerCase();
    // some platforms hand over HEIC (or files from the share sheet) with an
    // empty/odd MIME type, so sniff the extension too
    const isHeif = /image\/hei[cf]/.test(file.type) || /\.(heic|heif|hif)$/.test(name);
    const isVideo = file.type.startsWith("video/") ||
      (!file.type && /\.(mov|mp4|m4v|webm|mkv)$/.test(name));
    const isImage = file.type.startsWith("image/") ||
      (!file.type && /\.(png|jpe?g|gif|webp|bmp|avif)$/.test(name));
    if (isHeif) { loadHeicFile(file); return; }
    if (isVideo) { loadVideoFile(file); return; }
    if (!isImage) return;
    showLoader("LOADING IMAGE…");
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { loadFromImageElement(img); URL.revokeObjectURL(url); hideLoader(); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      hideLoader();
      // HEIC files sometimes arrive typed as plain image/* — try the decoder
      loadHeicFile(file);
    };
    img.src = url;
  }

  function loadDemo() {
    // synthetic test pattern: gradient sky, sun, grid floor
    const w = 960, h = 640;
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const c = off.getContext("2d");
    const sky = c.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, "#120a2e");
    sky.addColorStop(0.6, "#6a2a8a");
    sky.addColorStop(1, "#ff5e78");
    c.fillStyle = sky;
    c.fillRect(0, 0, w, h * 0.62);
    const sun = c.createRadialGradient(w / 2, h * 0.5, 10, w / 2, h * 0.5, 190);
    sun.addColorStop(0, "#ffd76e");
    sun.addColorStop(0.7, "#ff8a3c");
    sun.addColorStop(1, "rgba(255,138,60,0)");
    c.fillStyle = sun;
    c.beginPath(); c.arc(w / 2, h * 0.5, 190, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#0b0618";
    c.fillRect(0, h * 0.62, w, h * 0.38);
    c.strokeStyle = "#ff2e88";
    c.lineWidth = 2;
    for (let i = 0; i <= 24; i++) { // perspective grid
      const x = (i / 24) * w;
      c.beginPath();
      c.moveTo(w / 2 + (x - w / 2) * 0.08, h * 0.62);
      c.lineTo(x * 2.4 - w * 0.7, h);
      c.stroke();
    }
    for (let i = 0; i < 10; i++) {
      const y = h * 0.62 + Math.pow(i / 10, 1.8) * h * 0.38;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    // bright specular dots so the anamorphic flare has stars to catch
    c.fillStyle = "#ffffff";
    for (const [dx, dy, r] of [[0.18, 0.12, 3], [0.82, 0.2, 4], [0.65, 0.08, 2], [0.32, 0.3, 3]]) {
      c.beginPath(); c.arc(w * dx, h * dy, r, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = "#ffffff";
    c.font = "bold 52px Helvetica, Arial, sans-serif";
    c.textAlign = "center";
    c.fillText("VERSIONS ◉ EYE", w / 2, h * 0.18);
    loadFromImageElement(off);
  }

  // =====================================================================
  // downloads
  // =====================================================================

  function anchorDownload(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0);
  }

  let pendingShare = null; // File waiting for a fresh tap (share needs a user gesture)

  function armShareButton(file) {
    pendingShare = file;
    const btn = $("export-video-btn");
    btn.disabled = false;
    btn.textContent = "TAP TO SHARE";
  }

  // On phones, hand files to the native iOS/Android share sheet so they can
  // go straight to Photos, AirDrop, socials etc.; desktop keeps downloads.
  async function deliverFile(blob, filename) {
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    if (isMobile() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // user closed the sheet
        if (e && e.name === "NotAllowedError") {
          // gesture expired (e.g. after a long render) — ask for one tap
          armShareButton(file);
          return;
        }
        // anything else: fall through to a plain download
      }
    }
    anchorDownload(blob, filename);
  }

  function downloadPng() {
    canvas.toBlob((blob) => deliverFile(blob, `versions-eye-${seed.toString(16)}.png`), "image/png");
  }

  // ---- SVG export: reproduce the preview faithfully. When dither is on
  // we sample on the EXACT dither grid (aligned at 0,0 — every pixel in a
  // dither cell is identical), so the vector output is pixel-perfect
  // against the preview; otherwise a fine uniform grid is used ----
  function exportSvg() {
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    const img = ctx.getImageData(0, 0, w, h).data;

    let cell;
    if (chain.dither.enabled) {
      const px = Math.max(1, Math.round(chain.dither.params.pixelSize));
      cell = px;
      while (Math.max(w, h) / cell > 640) cell += px; // stay aligned to the grid
    } else {
      cell = Math.max(1, Math.ceil(Math.max(w, h) / 480));
    }
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);

    // sample the top-left pixel of each cell (exact for dithered output)
    const grid = new Int32Array(gw * gh);
    const counts = new Map();
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const x = Math.min(w - 1, gx * cell);
        const y = Math.min(h - 1, gy * cell);
        const i = (y * w + x) * 4;
        const c = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
        grid[gy * gw + gx] = c;
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }

    // overlays/gradients can yield thousands of colors — quantize only
    // then, so plain dithered exports stay exact
    if (counts.size > 512) {
      counts.clear();
      for (let k = 0; k < grid.length; k++) {
        const c = grid[k];
        const q = (c & 0xf8f8f8) | ((c >> 5) & 0x070707); // 5 bits/channel
        grid[k] = q;
        counts.set(q, (counts.get(q) || 0) + 1);
      }
    }

    let bg = 0, bgCount = -1;
    for (const [c, n] of counts) if (n > bgCount) { bg = c; bgCount = n; }

    // paths in true pixel units with exact partial edge cells, so the
    // SVG at native size is a 1:1 match with the preview canvas
    const hex = (c) => "#" + c.toString(16).padStart(6, "0");
    const paths = new Map();
    for (let gy = 0; gy < gh; gy++) {
      const y0 = gy * cell;
      const rowH = Math.min(cell, h - y0);
      let runColor = -1, runStart = 0;
      for (let gx = 0; gx <= gw; gx++) {
        const c = gx < gw ? grid[gy * gw + gx] : -1;
        if (c !== runColor) {
          if (runColor >= 0 && runColor !== bg) {
            const x0 = runStart * cell;
            const len = Math.min(gx * cell, w) - x0;
            const d = paths.get(runColor) || [];
            d.push(`M${x0} ${y0}h${len}v${rowH}h-${len}z`);
            paths.set(runColor, d);
          }
          runColor = c;
          runStart = gx;
        }
      }
    }

    let body = `<rect width="${w}" height="${h}" fill="${hex(bg)}"/>`;
    for (const [c, d] of paths) {
      body += `<path fill="${hex(c)}" d="${d.join("")}"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
      `width="${w}" height="${h}" shape-rendering="crispEdges">${body}</svg>`;
    deliverFile(new Blob([svg], { type: "image/svg+xml" }), `versions-eye-${seed.toString(16)}.svg`);
  }

  // =====================================================================
  // video export — offline render via WebCodecs → MP4/MOV container.
  // Frames are seeked one by one, run through the chain at full export
  // resolution, and encoded with exact 30fps timestamps, so the output
  // is always smooth even when effects run slower than realtime.
  // =====================================================================

  function seekTo(t) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000); // seeked can be skipped for tiny deltas
      videoEl.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      videoEl.currentTime = Math.min(t, (videoEl.duration || clipEnd) - 0.001);
    });
  }

  async function pickEncoderConfig(width, height, fps) {
    if (typeof VideoEncoder === "undefined" || typeof Mp4Muxer === "undefined") return null;
    const bitrate = width * height >= 3000 * 1500 ? 40_000_000 : 12_000_000;
    const candidates = [
      // H.264 High profile — L4.2 covers 1080p60, L5.2 covers 4K
      { codec: height > 1200 || width > 2100 ? "avc1.640034" : "avc1.64002A", mux: "avc", ext: "mov", mime: "video/quicktime" },
      { codec: "vp09.00.41.08", mux: "vp9", ext: "mp4", mime: "video/mp4" },
    ];
    for (const c of candidates) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported({
          codec: c.codec, width, height, bitrate, framerate: fps,
        });
        if (supported) return { ...c, bitrate };
      } catch { /* try next codec */ }
    }
    return null;
  }

  async function offlineRender(targetShort) {
    // Frames are processed at PREVIEW resolution so the export looks
    // exactly like what you dialed in (effect params are in pixels —
    // running the chain natively at 1080p/4K changes the look), then
    // upscaled to the target size with hard nearest-neighbor pixels.
    const pw = vidCanvas.width, ph = vidCanvas.height;
    const aspect = pw / ph;
    let ew, eh;
    if (aspect >= 1) { eh = targetShort; ew = Math.round(targetShort * aspect); }
    else { ew = targetShort; eh = Math.round(targetShort / aspect); }
    ew -= ew % 2; eh -= eh % 2;

    const cfg = await pickEncoderConfig(ew, eh, EXPORT_FPS);
    if (!cfg) return false;

    const btn = $("export-video-btn");
    exporting = true;
    cancelExport = false;
    cancelAnimationFrame(vidRaf);
    videoEl.pause();

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: cfg.mux, width: ew, height: eh },
      fastStart: "in-memory",
    });
    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encoderError = e; },
    });
    encoder.configure({ codec: cfg.codec, width: ew, height: eh, bitrate: cfg.bitrate, framerate: EXPORT_FPS });

    // processing canvas at preview size; export canvas at target size
    const pcan = document.createElement("canvas");
    pcan.width = pw; pcan.height = ph;
    const pctx = pcan.getContext("2d", { willReadFrequently: true });
    const ecan = document.createElement("canvas");
    ecan.width = ew; ecan.height = eh;
    const ectx = ecan.getContext("2d");
    ectx.imageSmoothingEnabled = false;

    const totalFrames = Math.max(1, Math.round(clipEnd * EXPORT_FPS));
    let ok = true;
    try {
      for (let i = 0; i < totalFrames; i++) {
        if (cancelExport || encoderError) { ok = false; break; }
        await seekTo(i / EXPORT_FPS);
        pctx.drawImage(videoEl, 0, 0, pw, ph);
        let frame = pctx.getImageData(0, 0, pw, ph);
        frame = Effects.apply(frame, chain, frameSeedAt(i));
        frame = Effects.renderOverlayStack(frame, overlayModules, stars, true);
        pctx.putImageData(frame, 0, 0);
        ectx.drawImage(pcan, 0, 0, ew, eh); // crisp nearest-neighbor upscale
        // mirror progress on the visible canvas at preview size
        if (canvas.width !== pw) { canvas.width = pw; canvas.height = ph; }
        ctx.putImageData(frame, 0, 0);

        const vf = new VideoFrame(ecan, { timestamp: i * 1e6 / EXPORT_FPS, duration: 1e6 / EXPORT_FPS });
        encoder.encode(vf, { keyFrame: i % (EXPORT_FPS * 2) === 0 });
        vf.close();
        while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
        btn.textContent = `RENDERING ${Math.round(((i + 1) / totalFrames) * 100)}% — CLICK TO CANCEL`;
      }
      if (ok) {
        await encoder.flush();
        muxer.finalize();
        deliverFile(new Blob([muxer.target.buffer], { type: cfg.mime }),
          `versions-eye-${seed.toString(16)}.${cfg.ext}`);
      }
    } catch (e) {
      console.error("export failed:", e, encoderError);
      ok = false;
    } finally {
      try { if (encoder.state !== "closed") encoder.close(); } catch { /* already closed */ }
      exporting = false;
      btn.disabled = false;
      btn.textContent = "mov";
      if (videoEl) {
        videoEl.currentTime = 0;
        videoEl.play().catch(() => {});
        vidRaf = requestAnimationFrame(videoLoop);
      }
    }
    return ok;
  }

  // realtime fallback for browsers without WebCodecs: record the preview
  // canvas with MediaRecorder (mp4 where supported, else webm)
  function realtimeRecord() {
    if (typeof MediaRecorder === "undefined") {
      alert("This browser supports neither WebCodecs nor MediaRecorder — video export unavailable.");
      return;
    }
    const pick = [
      ["video/mp4;codecs=avc1.64002A", "mov"],
      ["video/mp4", "mov"],
      ["video/webm;codecs=vp9", "webm"],
      ["video/webm;codecs=vp8", "webm"],
      ["video/webm", "webm"],
    ].find(([m]) => MediaRecorder.isTypeSupported(m));
    if (!pick) { alert("No supported recording format found."); return; }
    const [mime, ext] = pick;

    const btn = $("export-video-btn");
    btn.disabled = true;
    const stream = canvas.captureStream(EXPORT_FPS);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      deliverFile(new Blob(recChunks, { type: recorder.mimeType || mime }),
        `versions-eye-${seed.toString(16)}.${ext}`);
      recording = false;
      btn.disabled = false;
      btn.textContent = "mov";
    };
    const begin = () => {
      videoEl.play().catch(() => {});
      recorder.start(200);
      recording = true;
    };
    if (videoEl.currentTime > 0.05) {
      videoEl.addEventListener("seeked", begin, { once: true });
      videoEl.currentTime = 0;
    } else {
      begin();
    }
  }

  function stopRecorder() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  async function exportVideo() {
    if (pendingShare) { // a finished export is waiting for this fresh tap
      const f = pendingShare;
      pendingShare = null;
      $("export-video-btn").textContent = "mov";
      navigator.share({ files: [f], title: f.name }).catch((e) => {
        if (!e || e.name !== "AbortError") anchorDownload(f, f.name);
      });
      return;
    }
    if (mode !== "video" || !videoEl || recording) return;
    if (exporting) { cancelExport = true; return; } // second click cancels
    const res = $("export-res").value;
    const btn = $("export-video-btn");
    if (res === "preview") {
      realtimeRecord();
      return;
    }
    btn.textContent = "STARTING…";
    const ok = await offlineRender(parseInt(res, 10));
    if (!ok && !cancelExport) {
      // WebCodecs unavailable or codec rejected — fall back to realtime
      realtimeRecord();
    }
  }

  // =====================================================================
  // controls UI
  // =====================================================================

  function fmt(v, p) {
    const num = typeof v === "number" ? (p.step >= 1 ? v : v.toFixed(2)) : v;
    return `${num}${p.unit || ""}`;
  }

  const HEX_RE = /^#?([0-9a-f]{6})$/i;

  function buildColorParam(state, p) {
    const wrap = document.createElement("div");
    wrap.className = "color-row";
    const arr = state.params[p.key];
    for (let ci = 0; ci < p.count; ci++) {
      const item = document.createElement("div");
      item.className = "color-item";
      const cIn = document.createElement("input");
      cIn.type = "color";
      cIn.value = HEX_RE.test(arr[ci] || "") ? arr[ci] : "#000000";
      const tIn = document.createElement("input");
      tIn.type = "text";
      tIn.placeholder = ci < 2 ? "#rrggbb" : "#rrggbb (optional)";
      tIn.maxLength = 7;
      tIn.value = arr[ci] || "";
      cIn.addEventListener("input", () => {
        arr[ci] = cIn.value;
        tIn.value = cIn.value;
        tIn.classList.remove("invalid");
        render();
      });
      tIn.addEventListener("input", () => {
        const raw = tIn.value.trim();
        if (raw === "" && ci >= 2) { // third color is optional
          arr[ci] = "";
          tIn.classList.remove("invalid");
          render();
          return;
        }
        const m = HEX_RE.exec(raw);
        if (m) {
          const v = "#" + m[1].toLowerCase();
          arr[ci] = v;
          cIn.value = v;
          tIn.classList.remove("invalid");
          render();
        } else {
          tIn.classList.add("invalid");
        }
      });
      item.append(cIn, tIn);
      wrap.appendChild(item);
    }
    return wrap;
  }

  function buildControls() {
    const list = $("effect-list");
    list.innerHTML = "";
    for (const e of Effects.REGISTRY) {
      const state = chain[e.id];
      const box = document.createElement("div");
      box.className = "effect" + (state.enabled ? " enabled open" : "");
      box.dataset.effect = e.id;

      const head = document.createElement("div");
      head.className = "effect-head";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "effect-toggle";
      toggle.checked = state.enabled;
      toggle.setAttribute("aria-label", `enable ${e.name}`);
      const name = document.createElement("span");
      name.className = "effect-name";
      name.textContent = e.name;
      const caret = document.createElement("span");
      caret.className = "effect-caret";
      caret.textContent = "▶";
      head.append(toggle, name, caret);

      const body = document.createElement("div");
      body.className = "effect-body";

      for (const p of e.params) {
        const row = document.createElement("div");
        row.className = "param";
        const label = document.createElement("div");
        label.className = "param-label";
        const nameEl = document.createElement("span");
        nameEl.textContent = p.label;
        const valEl = document.createElement("span");
        valEl.className = "value";
        label.append(nameEl, valEl);
        row.appendChild(label);

        if (p.type === "select") {
          const sel = document.createElement("select");
          for (const [val, text] of p.options) {
            const opt = document.createElement("option");
            opt.value = String(val);
            opt.textContent = text;
            sel.appendChild(opt);
          }
          sel.value = String(state.params[p.key]);
          sel.addEventListener("change", () => {
            const raw = sel.value;
            state.params[p.key] = raw === "true" ? true : raw === "false" ? false : raw;
            render();
          });
          row.appendChild(sel);
          valEl.remove();
        } else if (p.type === "colors") {
          row.appendChild(buildColorParam(state, p));
          valEl.remove();
        } else {
          const slider = document.createElement("input");
          slider.type = "range";
          slider.min = p.min; slider.max = p.max; slider.step = p.step;
          slider.value = state.params[p.key];
          valEl.textContent = fmt(state.params[p.key], p);
          slider.addEventListener("input", () => {
            state.params[p.key] = parseFloat(slider.value);
            valEl.textContent = fmt(state.params[p.key], p);
            render();
          });
          row.appendChild(slider);
        }
        body.appendChild(row);
      }

      toggle.addEventListener("change", () => {
        state.enabled = toggle.checked;
        box.classList.toggle("enabled", state.enabled);
        if (state.enabled) box.classList.add("open");
        render();
      });
      head.addEventListener("click", (ev) => {
        if (ev.target === toggle) return;
        box.classList.toggle("open");
      });

      box.append(head, body);
      list.appendChild(box);
    }
  }

  function syncControls() {
    buildControls();
  }

  // =====================================================================
  // overlays UI + canvas dragging
  // =====================================================================

  function addStar() {
    stars.push(structuredClone(Effects.STAR_TYPE.defaults));
    buildStarList();
    updateChips();
    render();
  }

  function buildParamRow(p, get, set) {
    const row = document.createElement("div");
    row.className = "param";
    const label = document.createElement("div");
    label.className = "param-label";
    const nameEl = document.createElement("span");
    nameEl.textContent = p.label;
    const valEl = document.createElement("span");
    valEl.className = "value";
    label.append(nameEl, valEl);
    row.appendChild(label);

    if (p.type === "select") {
      const sel = document.createElement("select");
      for (const [val, text] of p.options) {
        const opt = document.createElement("option");
        opt.value = String(val);
        opt.textContent = text;
        sel.appendChild(opt);
      }
      sel.value = String(get());
      sel.addEventListener("change", () => {
        const raw = sel.value;
        set(raw === "true" ? true : raw === "false" ? false : raw);
        render();
      });
      row.appendChild(sel);
      valEl.remove();
    } else if (p.type === "color") {
      const item = document.createElement("div");
      item.className = "color-item";
      const cIn = document.createElement("input");
      cIn.type = "color";
      cIn.value = get();
      const tIn = document.createElement("input");
      tIn.type = "text";
      tIn.maxLength = 7;
      tIn.value = get();
      cIn.addEventListener("input", () => {
        set(cIn.value); tIn.value = cIn.value;
        tIn.classList.remove("invalid");
        render();
      });
      tIn.addEventListener("input", () => {
        const m = HEX_RE.exec(tIn.value.trim());
        if (m) {
          const v = "#" + m[1].toLowerCase();
          set(v); cIn.value = v;
          tIn.classList.remove("invalid");
          render();
        } else tIn.classList.add("invalid");
      });
      item.append(cIn, tIn);
      row.appendChild(item);
      valEl.remove();
    } else {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = p.min; slider.max = p.max; slider.step = p.step;
      slider.value = get();
      valEl.textContent = fmt(get(), p);
      slider.addEventListener("input", () => {
        set(parseFloat(slider.value));
        valEl.textContent = fmt(get(), p);
        render();
      });
      row.appendChild(slider);
    }
    return row;
  }

  function buildOverlayList() {
    buildOverlayModules();
    buildStarList();
  }

  function buildOverlayModules() {
    const list = $("overlay-module-list");
    list.innerHTML = "";

    // --- ORBS / LINES modules: one toggleable block each, like filters ---
    for (const key of ["orbs", "lines"]) {
      const def = Effects.OVERLAY_MODULES[key];
      const state = overlayModules[key];
      const box = document.createElement("div");
      box.className = "effect" + (state.enabled ? " enabled open" : "");
      box.dataset.overlayModule = key;

      const head = document.createElement("div");
      head.className = "effect-head";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "effect-toggle";
      toggle.checked = state.enabled;
      toggle.setAttribute("aria-label", `enable ${def.name} overlay`);
      const name = document.createElement("span");
      name.className = "effect-name";
      name.textContent = def.name;
      const caret = document.createElement("span");
      caret.className = "effect-caret";
      caret.textContent = "▶";
      head.append(toggle, name, caret);

      const body = document.createElement("div");
      body.className = "effect-body";
      for (const p of def.params) {
        body.appendChild(buildParamRow(p,
          () => state.params[p.key],
          (v) => { state.params[p.key] = v; }));
      }

      toggle.addEventListener("change", () => {
        state.enabled = toggle.checked;
        box.classList.toggle("enabled", state.enabled);
        if (state.enabled) box.classList.add("open");
        render();
      });
      head.addEventListener("click", (ev) => {
        if (ev.target === toggle) return;
        box.classList.toggle("open");
      });
      box.append(head, body);
      list.appendChild(box);
    }
  }

  function buildStarList() {
    const list = $("star-list");
    list.innerHTML = "";
    stars.forEach((o, idx) => {
      const item = document.createElement("div");
      item.className = "overlay-item";
      const head = document.createElement("div");
      head.className = "overlay-head";
      const name = document.createElement("span");
      name.className = "overlay-name";
      name.textContent = `STAR ${idx + 1}`;
      const colorIn = document.createElement("input");
      colorIn.type = "color";
      colorIn.value = o.color;
      colorIn.setAttribute("aria-label", `star ${idx + 1} color`);
      colorIn.addEventListener("input", () => { o.color = colorIn.value; render(); });
      const rm = document.createElement("button");
      rm.className = "overlay-remove";
      rm.type = "button";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `remove star ${idx + 1}`);
      rm.addEventListener("click", () => {
        stars.splice(idx, 1);
        buildStarList();
        updateChips();
        render();
      });
      head.append(name, colorIn, rm);
      item.appendChild(head);
      for (const p of Effects.STAR_TYPE.params) {
        item.appendChild(buildParamRow(p, () => o[p.key], (v) => { o[p.key] = v; }));
      }
      list.appendChild(item);
    });
  }

  function canvasPoint(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
    };
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (!stars.length) return;
    const p = canvasPoint(ev);
    let best = -1, bestD = Infinity;
    stars.forEach((o, i) => {
      const dx = (o.x - p.x) * canvas.width;
      const dy = (o.y - p.y) * canvas.height;
      const d2 = dx * dx + dy * dy;
      const rad = Math.max(40, o.length * 0.45);
      if (d2 < rad * rad && d2 < bestD) { bestD = d2; best = i; }
    });
    dragIdx = best;
    if (dragIdx >= 0) {
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (dragIdx < 0 || !stars[dragIdx]) return;
    const p = canvasPoint(ev);
    stars[dragIdx].x = p.x;
    stars[dragIdx].y = p.y;
    render();
  });
  for (const evName of ["pointerup", "pointercancel"]) {
    canvas.addEventListener(evName, () => { dragIdx = -1; });
  }

  // =====================================================================
  // actions
  // =====================================================================

  function randomizeAll() {
    closeSheet(true);
    seed = (Math.random() * 0xffffffff) >>> 0;
    const rng = Effects.makeRng(seed);
    for (const e of Effects.REGISTRY) {
      const state = chain[e.id];
      state.enabled = rng() < 0.45;
      for (const p of e.params) {
        if (p.type === "select") {
          state.params[p.key] = p.options[Math.floor(rng() * p.options.length)][0];
        } else if (p.type === "colors") {
          state.params[p.key] = Array.from({ length: p.count },
            () => "#" + Math.floor(rng() * 0x1000000).toString(16).padStart(6, "0"));
        } else {
          const span = p.max - p.min;
          let v = p.min + rng() * span;
          if (p.step >= 1) v = Math.round(v);
          else v = Math.round(v / p.step) * p.step;
          state.params[p.key] = parseFloat(v.toFixed(4));
        }
      }
    }
    if (!Effects.REGISTRY.some((e) => chain[e.id].enabled)) {
      chain.slice.enabled = true;
    }
    chain.dither.params.pixelSize = Math.min(chain.dither.params.pixelSize, 8);
    syncControls();
    render();
  }

  function resetAll() {
    closeSheet(true);
    for (const e of Effects.REGISTRY) {
      chain[e.id] = { enabled: false, params: structuredClone(e.defaults) };
    }
    chain.dither.enabled = true;
    stars = [];
    overlayModules.orbs = { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.orbs.defaults) };
    overlayModules.lines = { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.lines.defaults) };
    buildOverlayList();
    syncControls();
    render();
  }

  // =====================================================================
  // event wiring
  // =====================================================================

  const dropzone = $("dropzone");
  dropzone.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest("#demo-btn, #live-btn")) return;
    $("file-input").click();
  });
  $("file-input").addEventListener("change", (ev) => loadFile(ev.target.files[0]));
  $("demo-btn").addEventListener("click", loadDemo);

  for (const evName of ["dragover", "dragenter"]) {
    document.addEventListener(evName, (ev) => {
      ev.preventDefault();
      dropzone.classList.add("dragover");
    });
  }
  for (const evName of ["dragleave", "drop"]) {
    document.addEventListener(evName, (ev) => {
      ev.preventDefault();
      dropzone.classList.remove("dragover");
    });
  }
  document.addEventListener("drop", (ev) => {
    const file = ev.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
  document.addEventListener("paste", (ev) => {
    for (const item of ev.clipboardData?.items || []) {
      if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
        loadFile(item.getAsFile());
        return;
      }
    }
  });

  $("reroll-btn").addEventListener("click", () => {
    seed = (Math.random() * 0xffffffff) >>> 0;
    renderLookThumbs();
    render();
  });
  $("random-btn").addEventListener("click", randomizeAll);
  $("reset-btn").addEventListener("click", resetAll);
  $("download-btn").addEventListener("click", downloadPng);
  $("svg-btn").addEventListener("click", exportSvg);
  $("export-video-btn").addEventListener("click", exportVideo);
  $("new-image-btn").addEventListener("click", () => {
    document.body.classList.remove("in-app");
    cleanupVideo();
    cleanupLive();
    mode = "image";
    $("workspace").hidden = true;
    $("dropzone").hidden = false;
    $("file-input").value = "";
  });
  $("playpause-btn").addEventListener("click", () => {
    if (!videoEl) return;
    if (videoEl.paused) {
      videoEl.play().catch(() => {});
      $("playpause-btn").textContent = "PAUSE";
    } else {
      videoEl.pause();
      $("playpause-btn").textContent = "PLAY";
    }
  });

  const origBtn = $("original-btn");
  origBtn.addEventListener("pointerdown", () => showOriginal(true));
  for (const evName of ["pointerup", "pointerleave", "pointercancel"]) {
    origBtn.addEventListener(evName, () => showOriginal(false));
  }

  $("add-star-btn").addEventListener("click", addStar);

  // =====================================================================
  // LOOKS — one-tap curated presets so the first upload lands somewhere
  // beautiful immediately; everything stays tweakable afterwards
  // =====================================================================

  const LOOKS = {
    "1-BIT":   (c) => { c.dither.enabled = true; Object.assign(c.dither.params, { algorithm: "bayer4", palette: "1-bit", pixelSize: 3 }); },
    "PAPER":   (c) => { c.dither.enabled = true; Object.assign(c.dither.params, { algorithm: "atkinson", palette: "paper", pixelSize: 2, contrast: 1.1 }); },
    "GAMEBOY": (c) => { c.dither.enabled = true; Object.assign(c.dither.params, { algorithm: "bayer4", palette: "gameboy", pixelSize: 4, contrast: 1.15 }); },
    "VAPOR":   (c) => {
      c.dither.enabled = true;
      Object.assign(c.dither.params, { algorithm: "bayer8", palette: "vaporwave", pixelSize: 3 });
      c.rgbshift.enabled = true;
      Object.assign(c.rgbshift.params, { amount: 4, angle: 0 });
    },
    "THERMAL": (c) => { c.dither.enabled = true; Object.assign(c.dither.params, { algorithm: "floyd-serp", palette: "thermal", pixelSize: 2, contrast: 1.2 }); },
    "VHS":     (c) => {
      c.vhs.enabled = true;
      c.rgbshift.enabled = true;
      Object.assign(c.rgbshift.params, { amount: 3, angle: 0 });
    },
    "WRECK":   (c) => {
      c.slice.enabled = true;
      Object.assign(c.slice.params, { slices: 12, intensity: 0.6 });
      c.blocks.enabled = true;
      Object.assign(c.blocks.params, { blocks: 18 });
      c.rgbshift.enabled = true;
      Object.assign(c.rgbshift.params, { amount: 8, angle: 15 });
    },
    "GLOW":    (c, m) => {
      c.posterburn.enabled = true;
      Object.assign(c.posterburn.params, { levels: 7 });
      m.orbs.enabled = true;
      Object.assign(m.orbs.params, { spacing: 12, glow: 0.75, colorMode: "image" });
    },
    "CONTOUR": (c, m) => {
      c.dither.enabled = true;
      Object.assign(c.dither.params, { algorithm: "none", palette: "grayscale", pixelSize: 2, contrast: 1.25 });
      m.lines.enabled = true;
      Object.assign(m.lines.params, { direction: "horizontal", spacing: 7, wave: 16, glow: 0.6, colorMode: "image", intensity: 0.9 });
    },
  };

  function lookStates(name) {
    const c = {};
    for (const e of Effects.REGISTRY) c[e.id] = { enabled: false, params: structuredClone(e.defaults) };
    const m = {
      orbs: { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.orbs.defaults) },
      lines: { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.lines.defaults) },
    };
    LOOKS[name](c, m);
    return { c, m };
  }

  function thumbSource(w, h) {
    const t = document.createElement("canvas");
    t.width = w; t.height = h;
    const g = t.getContext("2d");
    if (mode === "image" && sourceImage) {
      const s = document.createElement("canvas");
      s.width = sourceImage.width; s.height = sourceImage.height;
      s.getContext("2d").putImageData(sourceImage, 0, 0);
      g.drawImage(s, 0, 0, w, h);
    } else if (vidCanvas.width > 1 && (videoEl || camVideo)) {
      g.drawImage(vidCanvas, 0, 0, w, h); // raw current frame
    } else {
      return null;
    }
    return g.getImageData(0, 0, w, h);
  }

  // live preview: every look chip renders ITS look on the actual image
  function renderLookThumbs() {
    const src = thumbSource(96, 64);
    if (!src) return;
    document.querySelectorAll("#looks-bar .look").forEach((btn) => {
      const name = btn.dataset.look;
      if (!name || !LOOKS[name]) return;
      const th = btn.querySelector("canvas");
      if (!th) return;
      const { c, m } = lookStates(name);
      let out = Effects.apply(src, c, seed);
      out = Effects.renderOverlayStack(out, m, [], false);
      th.getContext("2d").putImageData(out, 0, 0);
    });
  }
  let thumbsStale = true;

  function applyLook(name) {
    closeSheet(true);
    for (const e of Effects.REGISTRY) {
      chain[e.id] = { enabled: false, params: structuredClone(e.defaults) };
    }
    overlayModules.orbs = { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.orbs.defaults) };
    overlayModules.lines = { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.lines.defaults) };
    LOOKS[name](chain, overlayModules);
    syncControls();
    buildOverlayModules();
    updateChips();
    document.querySelectorAll("#looks-bar .look").forEach((el) =>
      el.classList.toggle("active", el.dataset.look === name));
    render();
  }

  function buildLooks() {
    const bar = $("looks-bar");
    bar.innerHTML = "";
    for (const name of Object.keys(LOOKS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "look";
      b.dataset.look = name;
      const th = document.createElement("canvas");
      th.className = "look-thumb";
      th.width = 96; th.height = 64;
      const lab = document.createElement("span");
      lab.textContent = name;
      b.append(th, lab);
      b.addEventListener("click", () => applyLook(name));
      bar.appendChild(b);
    }
  }
  // manual edits clear the active-look highlight
  document.addEventListener("change", (ev) => {
    if (ev.target.closest && (ev.target.closest("#effect-list") || ev.target.closest("#overlay-module-list") || ev.target.closest("#sheet-content"))) {
      document.querySelectorAll("#looks-bar .look.active").forEach((el) => el.classList.remove("active"));
    }
  });

  // =====================================================================
  // mobile chips + bottom sheet (VSCO-style): the chip bar lists every
  // tool; tapping one lifts its existing control block into a bottom
  // sheet, so all editing happens under the sticky preview
  // =====================================================================

  const CHIP_DEFS = [
    ...Effects.REGISTRY.map((e) => ({ id: e.id, label: e.name, kind: "effect" })),
    { id: "orbs", label: "ORBS", kind: "module" },
    { id: "lines", label: "LINES", kind: "module" },
    { id: "stars", label: "STARS", kind: "stars" },
  ];
  let sheetStash = null;

  function chipEnabled(def) {
    if (def.kind === "effect") return chain[def.id].enabled;
    if (def.kind === "module") return overlayModules[def.id].enabled;
    return stars.length > 0;
  }

  function updateChips() {
    document.querySelectorAll("#chip-bar .chip[data-chip]").forEach((el) => {
      const def = CHIP_DEFS.find((c) => c.id === el.dataset.chip);
      if (def) el.classList.toggle("on", chipEnabled(def));
    });
  }

  function buildChips() {
    const bar = $("chip-bar");
    bar.innerHTML = "";
    for (const def of CHIP_DEFS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (chipEnabled(def) ? " on" : "");
      b.dataset.chip = def.id;
      b.textContent = def.label;
      b.addEventListener("click", () => openSheetFor(def));
      bar.appendChild(b);
    }
    const rst = document.createElement("button");
    rst.type = "button";
    rst.className = "chip chip-reset";
    rst.textContent = "RESET";
    rst.addEventListener("click", resetAll);
    bar.appendChild(rst);
  }

  function openSheetFor(def) {
    closeSheet(true);
    let node;
    if (def.kind === "effect") node = document.querySelector(`.effect[data-effect="${def.id}"]`);
    else if (def.kind === "module") node = document.querySelector(`[data-overlay-module="${def.id}"]`);
    else if (def.kind === "export") node = document.querySelector(".export-bar");
    else node = $("star-section");
    if (!node) return;
    sheetStash = { node, parent: node.parentNode, next: node.nextSibling };
    $("sheet-title").textContent = def.label;
    $("sheet-content").appendChild(node);
    if (node.classList.contains("effect")) node.classList.add("open");
    const sheet = $("chip-sheet");
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add("open"));
  }

  function closeSheet(instant) {
    const sheet = $("chip-sheet");
    if (sheet.hidden) return;
    if (sheetStash) {
      sheetStash.parent.insertBefore(sheetStash.node, sheetStash.next);
      sheetStash = null;
    }
    sheet.classList.remove("open");
    if (instant) sheet.hidden = true;
    else setTimeout(() => { sheet.hidden = true; }, 220);
    updateChips();
  }

  $("sheet-close").addEventListener("click", () => closeSheet(false));
  document.addEventListener("change", (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains("effect-toggle")) {
      updateChips();
    }
  });

  // ---- PWA: offline app shell + add-to-home-screen. When a new version
  // activates, refresh once so users never sit on stale code ----
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  // ---- landing wordmark art: the brand word rendered as a field of
  // purple stars — real SVG vector paths (no font/emoji glyphs, so it
  // renders identically on every platform), sampled from Inter text ----
  function drawWordmarkArt() {
    const el = $("wordmark-art");
    if (!el) return;
    const w = 1000, h = Math.round(w * 0.24);

    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const g = off.getContext("2d");
    g.font = `700 ${Math.round(h * 0.82)}px "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("versions", w / 2, h * 0.56);
    const mask = g.getImageData(0, 0, w, h).data;

    const rng = Effects.makeRng(20260717);
    const purples = ["#8a5bc9", "#7451d2", "#5b52c9", "#9a5fc2", "#4c4fc0", "#6d4fd8"];
    const step = Math.max(4, Math.round(w / 120));
    const parts = [];

    const rayStar = (x, y, r, rays, rot, color) => {
      let d = "";
      for (let k = 0; k < rays; k++) {
        const ang = (Math.PI * 2 * k) / rays;
        d += `M0 0L${(Math.cos(ang) * r).toFixed(1)} ${(Math.sin(ang) * r).toFixed(1)}`;
      }
      parts.push(`<path d="${d}" stroke="${color}" stroke-width="${(r * 0.36).toFixed(1)}" ` +
        `stroke-linecap="round" fill="none" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot})"/>`);
    };
    const sparkle = (x, y, r, rot, color) => {
      const rr = r.toFixed(1);
      parts.push(`<path d="M0 -${rr}Q0 0 ${rr} 0Q0 0 0 ${rr}Q0 0 -${rr} 0Q0 0 0 -${rr}Z" ` +
        `fill="${color}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot}) scale(1.35)"/>`);
    };

    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        const i = ((Math.round(y) * w) + Math.round(x)) * 4;
        if (mask[i + 3] < 80 || rng() < 0.06) continue;
        const color = purples[Math.floor(rng() * purples.length)];
        const r = step * (0.55 + rng() * 0.75);
        const px = x + (rng() - 0.5) * step * 0.7;
        const py = y + (rng() - 0.5) * step * 0.7;
        const rot = Math.round(rng() * 90);
        const kind = rng();
        if (kind < 0.22) sparkle(px, py, r, rot, color);
        else if (kind < 0.5) rayStar(px, py, r, 6, rot, color);
        else if (kind < 0.72) rayStar(px, py, r, 5, rot, color);
        else if (kind < 0.88) rayStar(px, py, r * 1.1, 8, rot, color);
        else rayStar(px, py, r, 4, rot, color); // plus
      }
    }
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
  }
  drawWordmarkArt();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(drawWordmarkArt); // redraw once Inter is in
  }

  // header CTA + explicit chooser both open the file picker
  $("header-cta").addEventListener("click", () => $("file-input").click());
  $("live-btn").addEventListener("click", (ev) => { ev.stopPropagation(); startLive(); });
  $("record-btn").addEventListener("click", toggleLiveRecord);
  $("flip-btn").addEventListener("click", flipCamera);
  $("ab-flip").addEventListener("click", flipCamera);

  // mobile app bar proxies the main actions
  $("ab-new").addEventListener("click", () => $("new-image-btn").click());
  $("ab-seed").addEventListener("click", () => $("reroll-btn").click());
  $("ab-rand").addEventListener("click", () => $("random-btn").click());
  $("ab-export").addEventListener("click", () => {
    if (mode === "live") { toggleLiveRecord(); return; }
    openSheetFor({ id: "export", label: "EXPORT", kind: "export" });
  });
  $("ab-play").addEventListener("click", () => {
    $("playpause-btn").click();
    $("ab-play").textContent = $("playpause-btn").textContent;
  });
  const abOrig = $("ab-orig");
  abOrig.addEventListener("pointerdown", () => showOriginal(true));
  for (const evName of ["pointerup", "pointerleave", "pointercancel"]) {
    abOrig.addEventListener(evName, () => showOriginal(false));
  }

  // =====================================================================
  // node view — sketchdesign-style workspace: the enabled effects as a
  // stack of node rows wired to a draggable preview card on a dark grid
  // =====================================================================

  let nodeParamsStash = null;

  const NODE_DEFS = () => [
    ...Effects.REGISTRY.map((e) => ({ id: e.id, label: e.name, kind: "effect" })),
    { id: "orbs", label: "ORBS", kind: "module" },
    { id: "lines", label: "LINES", kind: "module" },
  ];

  function nodeEnabled(def) {
    return def.kind === "effect" ? chain[def.id].enabled : overlayModules[def.id].enabled;
  }
  function setNodeEnabled(def, on) {
    if (def.kind === "effect") chain[def.id].enabled = on;
    else overlayModules[def.id].enabled = on;
    const sel = def.kind === "effect"
      ? `.effect[data-effect="${def.id}"] .effect-toggle`
      : `[data-overlay-module="${def.id}"] .effect-toggle`;
    const t = document.querySelector(sel);
    if (t) t.checked = on;
    const box = t && t.closest(".effect");
    if (box) box.classList.toggle("enabled", on);
  }

  function renderNodeStack() {
    if (!document.body.classList.contains("node-mode")) return;
    const rows = $("node-rows");
    rows.innerHTML = "";
    let any = false;
    for (const def of NODE_DEFS()) {
      if (!nodeEnabled(def)) continue;
      any = true;
      const row = document.createElement("div");
      row.className = "node-row";
      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "node-name";
      name.textContent = def.label;
      const x = document.createElement("button");
      x.className = "node-x";
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", `remove ${def.label}`);
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setNodeEnabled(def, false);
        if (nodeParamsStash && nodeParamsStash.def.id === def.id) closeNodeParams();
        renderNodeStack();
        updateChips();
        render();
        requestAnimationFrame(updateWire);
      });
      row.append(dot, name, x);
      row.addEventListener("click", () => openNodeParams(def));
      rows.appendChild(row);
    }
    if (stars.length) {
      any = true;
      const row = document.createElement("div");
      row.className = "node-row";
      row.innerHTML = `<span class="dot"></span><span class="node-name">stars (${stars.length})</span>`;
      row.addEventListener("click", () => openNodeParams({ id: "stars", label: "STARS", kind: "stars" }));
      rows.appendChild(row);
    }
    if (!any) {
      const empty = document.createElement("div");
      empty.className = "node-row-empty";
      empty.textContent = "empty stack — add an effect";
      rows.appendChild(empty);
    }
    requestAnimationFrame(updateWire);
  }

  function buildNodeAddMenu() {
    const menu = $("node-add-menu");
    menu.innerHTML = "";
    for (const def of NODE_DEFS()) {
      if (nodeEnabled(def)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = def.label;
      b.addEventListener("click", () => {
        setNodeEnabled(def, true);
        menu.hidden = true;
        renderNodeStack();
        updateChips();
        render();
        openNodeParams(def);
      });
      menu.appendChild(b);
    }
    const star = document.createElement("button");
    star.type = "button";
    star.textContent = "+ star overlay";
    star.addEventListener("click", () => {
      menu.hidden = true;
      addStar();
      renderNodeStack();
    });
    menu.appendChild(star);
  }

  function openNodeParams(def) {
    closeNodeParams();
    let node;
    if (def.kind === "effect") node = document.querySelector(`.effect[data-effect="${def.id}"]`);
    else if (def.kind === "module") node = document.querySelector(`[data-overlay-module="${def.id}"]`);
    else node = $("star-section");
    if (!node) return;
    nodeParamsStash = { def, node, parent: node.parentNode, next: node.nextSibling };
    $("node-params-title").textContent = def.label.toLowerCase();
    $("node-params-body").appendChild(node);
    if (node.classList.contains("effect")) node.classList.add("open");
    $("node-params").hidden = false;
  }

  function closeNodeParams() {
    if (nodeParamsStash) {
      nodeParamsStash.parent.insertBefore(nodeParamsStash.node, nodeParamsStash.next);
      nodeParamsStash = null;
    }
    $("node-params").hidden = true;
  }

  function updateWire() {
    const v = $("node-view");
    if (v.hidden) return;
    const svg = $("node-wires");
    const vr = v.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${vr.width} ${vr.height}`);
    const s = $("node-stack").getBoundingClientRect();
    const p = $("node-preview").getBoundingClientRect();
    const x1 = s.right - vr.left, y1 = s.top + s.height / 2 - vr.top;
    const x2 = p.left - vr.left, y2 = p.top + 24 - vr.top;
    const dx = Math.max(50, (x2 - x1) / 2);
    svg.innerHTML =
      `<path d="M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"` +
      ` stroke="#5a5a52" stroke-width="1.5" fill="none"/>` +
      `<circle cx="${x1}" cy="${y1}" r="3.5" fill="#d6cbfa"/>` +
      `<circle cx="${x2}" cy="${y2}" r="3.5" fill="#d6cbfa"/>`;
  }

  function makeNodeDraggable(card, wholeCard) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    card.addEventListener("pointerdown", (ev) => {
      // controls stay interactive; everything else on the card drags it
      if (ev.target.closest("button, input, select, textarea, canvas, .node-row, .node-add-menu")) return;
      if (!wholeCard && !ev.target.closest(".node-title")) return;
      dragging = true;
      card.setPointerCapture(ev.pointerId);
      sx = ev.clientX; sy = ev.clientY;
      ox = card._x || 0; oy = card._y || 0;
      ev.preventDefault();
    });
    card.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      card._x = ox + ev.clientX - sx;
      card._y = oy + ev.clientY - sy;
      card.style.transform = `translate(${card._x}px, ${card._y}px)`;
      updateWire();
    });
    for (const n of ["pointerup", "pointercancel"]) {
      card.addEventListener(n, () => { dragging = false; });
    }
  }

  // background panning moves both cards together
  (() => {
    const v = $("node-view");
    let panning = false, sx = 0, sy = 0, starts = null;
    v.addEventListener("pointerdown", (ev) => {
      if (ev.target !== v && ev.target.id !== "node-wires") return;
      panning = true;
      v.setPointerCapture(ev.pointerId);
      sx = ev.clientX; sy = ev.clientY;
      starts = [$("node-stack"), $("node-preview")].map((c) => [c, c._x || 0, c._y || 0]);
    });
    v.addEventListener("pointermove", (ev) => {
      if (!panning) return;
      for (const [c, x0, y0] of starts) {
        c._x = x0 + ev.clientX - sx;
        c._y = y0 + ev.clientY - sy;
        c.style.transform = `translate(${c._x}px, ${c._y}px)`;
      }
      updateWire();
    });
    for (const n of ["pointerup", "pointercancel"]) {
      v.addEventListener(n, () => { panning = false; });
    }
  })();

  function enterNodeView() {
    if (document.body.classList.contains("node-mode")) return;
    closeSheet(true);
    document.body.classList.add("node-mode");
    $("node-view").hidden = false;
    $("node-canvas-slot").appendChild(canvas);
    renderNodeStack();
    requestAnimationFrame(updateWire);
  }

  function exitNodeView() {
    if (!document.body.classList.contains("node-mode")) return;
    closeNodeParams();
    $("node-add-menu").hidden = true;
    document.body.classList.remove("node-mode");
    $("node-view").hidden = true;
    $("canvas-wrap").appendChild(canvas);
  }

  $("node-toggle").addEventListener("click", enterNodeView);
  $("node-exit").addEventListener("click", exitNodeView);
  $("node-params-close").addEventListener("click", closeNodeParams);
  $("node-add").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const menu = $("node-add-menu");
    if (menu.hidden) { buildNodeAddMenu(); menu.hidden = false; }
    else menu.hidden = true;
  });
  $("nv-seed").addEventListener("click", () => $("reroll-btn").click());
  $("nv-rand").addEventListener("click", () => {
    $("random-btn").click();
    renderNodeStack();
  });
  $("nv-png").addEventListener("click", () => $("download-btn").click());
  $("nv-svg").addEventListener("click", () => $("svg-btn").click());
  $("nv-export").addEventListener("click", () => {
    if (mode === "video") $("export-video-btn").click();
    else if (mode === "live") toggleLiveRecord();
  });
  makeNodeDraggable($("node-stack"), true);
  makeNodeDraggable($("node-preview"), true);
  makeNodeDraggable($("node-params"), false); // by its title bar
  window.addEventListener("resize", () => {
    if (window.innerWidth <= 940) exitNodeView();
    updateWire();
  });
  document.addEventListener("change", (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains("effect-toggle")) {
      renderNodeStack();
    }
  });

  buildControls();
  buildOverlayList();
  buildChips();
  buildLooks();
})();
