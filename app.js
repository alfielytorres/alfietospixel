/* VERSIONS EYE — UI wiring: load image/video, build controls,
 * run the effect pipeline (live for video), export PNG / SVG / MOV. */
"use strict";

(() => {
  const MAX_DIM = 1600;        // cap for still images
  const MAX_VIDEO_DIM = 960;   // preview cap so per-frame effects stay realtime
  const MAX_CLIP_SECONDS = 10; // videos are trimmed to their first 10s
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

  // =====================================================================
  // rendering — image mode
  // =====================================================================

  function render() {
    if (mode !== "image" || !sourceImage || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const out = holdOriginal ? sourceImage : Effects.apply(sourceImage, chain, seed);
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
    let frame = vctx.getImageData(0, 0, vw, vh);
    if (!holdOriginal) {
      frame = Effects.apply(frame, chain, frameSeedAt(Math.floor(videoEl.currentTime * EXPORT_FPS)));
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
    $("dropzone").hidden = true;
    $("workspace").hidden = false;
    updateModeUI();
  }

  function updateModeUI() {
    const isVideo = mode === "video";
    $("playpause-btn").hidden = !isVideo;
    $("export-video-btn").hidden = !isVideo;
    $("res-wrap").hidden = !isVideo;
    $("playpause-btn").textContent = "PAUSE";
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
    $("export-video-btn").textContent = "MOV ↓";
  }

  function loadFromImageElement(imgEl) {
    cleanupVideo();
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
    showLoader("LOADING VIDEO…");
    videoUrl = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
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
    v.addEventListener("loadedmetadata", () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { hideLoader(); cleanupVideo(); return; }
      clipEnd = Math.min(v.duration || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS);
      const ratio = Math.min(1, MAX_VIDEO_DIM / Math.max(w, h));
      vidCanvas.width = Math.max(1, Math.round(w * ratio));
      vidCanvas.height = Math.max(1, Math.round(h * ratio));
      videoEl = v;
      mode = "video";
      cancelExport = false;
      enterWorkspace();
      v.play().catch(() => {});
      cancelAnimationFrame(vidRaf);
      vidRaf = requestAnimationFrame(videoLoop);
    }, { once: true });
    v.src = videoUrl;
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

  // ---- SVG export: sample the canvas on a coarse grid, RLE runs per row,
  // one <path> per color so the file stays compact and truly scalable ----
  function exportSvg() {
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    const img = ctx.getImageData(0, 0, w, h).data;

    let cell = Math.max(1, Math.ceil(Math.max(w, h) / SVG_MAX_CELLS));
    if (chain.dither.enabled) {
      cell = Math.max(cell, Math.round(chain.dither.params.pixelSize));
    }
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);

    // sample cell centers
    const grid = new Int32Array(gw * gh);
    const counts = new Map();
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const x = Math.min(w - 1, gx * cell + (cell >> 1));
        const y = Math.min(h - 1, gy * cell + (cell >> 1));
        const i = (y * w + x) * 4;
        const c = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
        grid[gy * gw + gx] = c;
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }

    // most common color becomes the background rect
    let bg = 0, bgCount = -1;
    for (const [c, n] of counts) if (n > bgCount) { bg = c; bgCount = n; }

    const hex = (c) => "#" + c.toString(16).padStart(6, "0");
    const paths = new Map(); // color -> path data
    for (let gy = 0; gy < gh; gy++) {
      let runColor = -1, runStart = 0;
      for (let gx = 0; gx <= gw; gx++) {
        const c = gx < gw ? grid[gy * gw + gx] : -1;
        if (c !== runColor) {
          if (runColor >= 0 && runColor !== bg) {
            const len = gx - runStart;
            const d = paths.get(runColor) || [];
            d.push(`M${runStart} ${gy}h${len}v1h-${len}z`);
            paths.set(runColor, d);
          }
          runColor = c;
          runStart = gx;
        }
      }
    }

    let body = `<rect width="${gw}" height="${gh}" fill="${hex(bg)}"/>`;
    for (const [c, d] of paths) {
      body += `<path fill="${hex(c)}" d="${d.join("")}"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gw} ${gh}" ` +
      `width="${gw * cell}" height="${gh * cell}" shape-rendering="crispEdges">${body}</svg>`;
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
      btn.textContent = "MOV ↓";
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
      btn.textContent = "MOV ↓";
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
      $("export-video-btn").textContent = "MOV ↓";
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
  // actions
  // =====================================================================

  function randomizeAll() {
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
    for (const e of Effects.REGISTRY) {
      chain[e.id] = { enabled: false, params: structuredClone(e.defaults) };
    }
    chain.dither.enabled = true;
    syncControls();
    render();
  }

  // =====================================================================
  // event wiring
  // =====================================================================

  const dropzone = $("dropzone");
  dropzone.addEventListener("click", (ev) => {
    if (ev.target.id !== "demo-btn") $("file-input").click();
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
    render();
  });
  $("random-btn").addEventListener("click", randomizeAll);
  $("reset-btn").addEventListener("click", resetAll);
  $("download-btn").addEventListener("click", downloadPng);
  $("svg-btn").addEventListener("click", exportSvg);
  $("export-video-btn").addEventListener("click", exportVideo);
  $("new-image-btn").addEventListener("click", () => {
    cleanupVideo();
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

  buildControls();
})();
