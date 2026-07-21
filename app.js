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
    text: { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.text.defaults) },
  };
  let stars = [];
  let dragIdx = -1;

  // ---- audio: an added track drives audio-reactive effects (beat 0..1) ----
  let audioEl = null, audioUrl = null, audioCtx = null, analyser = null, audioData = null;
  let audioLevel = 0, audioRaf = 0;
  const audioReact = { amount: 0.7 };
  const audioActive = () => (audioEl && !audioEl.paused) ||
    (typeof TL !== "undefined" && TL.clips && TL.clips.some((c) => (c.kind === "audio" || c.kind === "video") && c.el && !c.el.paused));

  // per-frame chain modulated by the beat, for realtime preview/record only
  function beatChain() {
    if (!audioActive()) return chain;
    const lvl = audioLevel * audioReact.amount;
    if (lvl < 0.001) return chain;
    const c = {};
    for (const e of Effects.REGISTRY) {
      const st = chain[e.id];
      if (!st.enabled) { c[e.id] = st; continue; }
      const p = { ...st.params };
      if (e.id === "rgbshift") p.amount = st.params.amount * (1 + lvl * 2.2);
      else if (e.id === "slice") p.intensity = Math.min(1, st.params.intensity * (1 + lvl * 1.4));
      else if (e.id === "blocks") p.blocks = Math.round(st.params.blocks * (1 + lvl * 1.3));
      else if (e.id === "dither") p.pixelSize = Math.max(1, Math.round(st.params.pixelSize * (1 + lvl * 0.7)));
      else if (e.id === "vhs") p.jitter = Math.min(1, (st.params.jitter || 0) + lvl * 0.6);
      c[e.id] = { enabled: true, params: p };
    }
    return c;
  }

  // one place that runs the chain + overlays; `live` enables beat reaction
  function pipelineApply(frame, seedVal, live) {
    const out = Effects.apply(frame, live ? beatChain() : chain, seedVal);
    return Effects.renderOverlayStack(out, overlayModules, stars, !!live, live ? audioLevel : 0);
  }

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
    if (TL.clips && TL.clips.length) { renderComposite(); return; }
    if (mode !== "image" || !sourceImage || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      let out = sourceImage;
      if (!holdOriginal) out = pipelineApply(sourceImage, seed, audioActive());
      canvas.width = out.width;
      canvas.height = out.height;
      ctx.putImageData(out, 0, 0);
      scheduleThumbs();
      // keep re-rendering a still while audio is playing so it pulses
      if (mode === "image" && audioActive() && !holdOriginal) requestAnimationFrame(render);
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
      frame = pipelineApply(frame, frameSeedAt(Math.floor(videoEl.currentTime * EXPORT_FPS)), true);
    }
    if (canvas.width !== vw) canvas.width = vw;
    if (canvas.height !== vh) canvas.height = vh;
    ctx.putImageData(frame, 0, 0);

    if (recording) {
      $("export-video-btn").textContent =
        `REC ${videoEl.currentTime.toFixed(1)}S / ${clipEnd.toFixed(1)}S`;
    }
    if (document.body.classList.contains("node-mode") && performance.now() - lastLoopThumb > 350) {
      lastLoopThumb = performance.now(); refreshThumbs();
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
    // node view is the only editing surface, on every device
    document.body.classList.add("editing");
    enterNodeView();
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
    const tip = "tap + to add a filter · tap a node to edit · drag to rearrange";
    setTimeout(() => toast(tip, 4200), 700);
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
    if (document.body.classList.contains("node-mode")) renderNodeGraph();
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
      frame = pipelineApply(frame, frameSeedAt(f), true);
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
    if (document.body.classList.contains("node-mode") && performance.now() - lastLoopThumb > 350) {
      lastLoopThumb = performance.now(); refreshThumbs();
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

  // ---- audio track: plays alongside the visual and feeds the analyser ----
  function cleanupAudioTrack() {
    cancelAnimationFrame(audioRaf);
    audioLevel = 0;
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); }
    if (audioCtx) { try { audioCtx.close(); } catch { /* already closed */ } }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioEl = null; audioCtx = null; analyser = null; audioData = null; audioUrl = null;
  }

  function audioTick() {
    if (analyser && audioData) {
      analyser.getByteFrequencyData(audioData);
      let sum = 0; const n = Math.min(28, audioData.length); // low-mid bins ~ the beat
      for (let i = 0; i < n; i++) sum += audioData[i];
      const raw = (sum / n) / 255;
      audioLevel = audioLevel * 0.78 + raw * 0.22;
    }
    audioRaf = requestAnimationFrame(audioTick);
  }

  function loadAudioTrack(file) {
    cleanupAudioTrack();
    audioUrl = URL.createObjectURL(file);
    audioEl = new Audio(audioUrl);
    audioEl.loop = true;
    audioEl.play().catch(() => {});
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(audioEl);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      audioData = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
      analyser.connect(audioCtx.destination);
      audioCtx.resume().catch(() => {});
    } catch { /* analyser optional — playback still works */ }
    cancelAnimationFrame(audioRaf);
    audioTick();
    toast("audio attached — effects now react to the beat", 3200);
    if (mode === "image") render();
    if (document.body.classList.contains("node-mode")) renderNodeGraph();
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
    const isAudio = file.type.startsWith("audio/") ||
      (!file.type && /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(name));
    if (isAudio) { tlAddAudio(file); return; }
    if (isVideo) { tlAddVideo(file); return; }
    if (isImage || isHeif) { tlAddImage(file); return; }
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
    } else if (p.type === "text") {
      const ta = document.createElement("textarea");
      ta.className = "text-input";
      ta.rows = 2;
      ta.placeholder = "type text / paste lyrics — one line per row";
      ta.value = get();
      ta.addEventListener("input", () => { set(ta.value); render(); });
      row.appendChild(ta);
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
    for (const key of ["orbs", "lines", "text"]) {
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
    if (document.body.classList.contains("node-mode")) renderNodeGraph();
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
    overlayModules.text = { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.text.defaults) };
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
    document.body.classList.remove("editing");
    exitNodeView();
    cleanupVideo();
    cleanupLive();
    cleanupAudioTrack();
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
      text: { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.text.defaults) },
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
    overlayModules.text = { enabled: false, params: structuredClone(Effects.OVERLAY_MODULES.text.defaults) };
    LOOKS[name](chain, overlayModules);
    syncControls();
    buildOverlayModules();
    updateChips();
    document.querySelectorAll("#looks-bar .look").forEach((el) =>
      el.classList.toggle("active", el.dataset.look === name));
    render();
    if (document.body.classList.contains("node-mode")) renderNodeGraph();
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
  // node view — sketchdesign-style pipeline: source → filter → … → result.
  // one node per filter, wired left to right on a dark dotted canvas; each
  // node shows a live thumbnail of the image up to and including that step.
  // =====================================================================

  let nodeParamsStash = null;
  const nodePos = {};   // id -> { bx, by, dx, dy }  base layout + drag offset
  let thumbTimer = 0, lastLoopThumb = 0;

  const NODE_DEFS = () => [
    ...Effects.REGISTRY.map((e) => ({ id: e.id, label: e.name, kind: "effect" })),
    { id: "orbs", label: "ORBS", kind: "module" },
    { id: "lines", label: "LINES", kind: "module" },
    { id: "text", label: "TEXT", kind: "module" },
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

  // the ordered pipeline: source, then each enabled step, then result
  function pipeline() {
    const list = [{ id: "__source", kind: "source", label: "source" }];
    for (const e of Effects.REGISTRY) {
      if (chain[e.id].enabled) list.push({ id: e.id, kind: "effect", label: e.name });
    }
    if (overlayModules.orbs.enabled) list.push({ id: "orbs", kind: "module", label: "ORBS" });
    if (overlayModules.lines.enabled) list.push({ id: "lines", kind: "module", label: "LINES" });
    if (overlayModules.text.enabled) list.push({ id: "text", kind: "module", label: "TEXT" });
    if (stars.length) list.push({ id: "__stars", kind: "stars", label: `stars (${stars.length})` });
    list.push({ id: "__result", kind: "result", label: "result" });
    return list;
  }

  // small copy of the current source/frame to render node thumbnails on
  function thumbBase() {
    if (!TL.clips || !TL.clips.length) return null;
    compositeFrame(TL.playhead); // fills tlCanvas at TL.W x TL.H
    const W = 150, H = Math.max(1, Math.round(W * TL.H / TL.W));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d");
    g.drawImage(tlCanvas, 0, 0, W, H);
    return g.getImageData(0, 0, W, H);
  }

  // apply the pipeline up to (and including) list index k onto src
  function applyUpTo(src, list, k) {
    const c = {};
    for (const e of Effects.REGISTRY) c[e.id] = { enabled: false, params: chain[e.id].params };
    const m = {
      orbs: { enabled: false, params: overlayModules.orbs.params },
      lines: { enabled: false, params: overlayModules.lines.params },
      text: { enabled: false, params: overlayModules.text.params },
    };
    let useStars = false;
    for (let i = 1; i <= k; i++) {
      const n = list[i];
      if (n.kind === "effect") c[n.id].enabled = true;
      else if (n.kind === "module") m[n.id].enabled = true;
      else if (n.kind === "stars") useStars = true;
    }
    let out = Effects.apply(src, c, seed);
    out = Effects.renderOverlayStack(out, m, useStars ? stars : [], false);
    return out;
  }

  function pickFile(accept) {
    const inp = $("file-input");
    inp.setAttribute("accept", accept);
    inp.value = "";
    inp.click();
  }

  function nvBtn(label, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "nbtn"; b.textContent = label;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    return b;
  }

  function removeNode(n) {
    if (n.kind === "effect") setNodeEnabled({ id: n.id, kind: "effect" }, false);
    else if (n.kind === "module") setNodeEnabled({ id: n.id, kind: "module" }, false);
    else if (n.kind === "stars") { stars = []; buildStarList(); }
    if (nodeParamsStash && nodeParamsStash.def.id === n.id) closeNodeParams();
    updateChips();
    render();
    renderNodeGraph();
  }

  function renderNodeGraph() {
    if (!document.body.classList.contains("node-mode")) return;
    const graph = $("node-graph");
    graph.innerHTML = "";
    const list = pipeline();
    const base = thumbBase();
    list.forEach((n, i) => {
      const card = document.createElement("div");
      card.className = "node-card node-" + n.kind;
      card.dataset.nid = n.id;

      const title = document.createElement("div");
      title.className = "node-title node-drag";
      title.textContent = n.kind === "result" ? "result · 1:1" : n.label.toLowerCase();
      card.appendChild(title);

      if (n.kind === "result") {
        const slot = document.createElement("div");
        slot.className = "node-result-slot";
        slot.appendChild(canvas);
        card.appendChild(slot);
        const acts = document.createElement("div");
        acts.className = "node-actions";
        acts.append(
          nvBtn("seed", () => { $("reroll-btn").click(); }),
          nvBtn("random", () => { $("random-btn").click(); }),
          nvBtn("png", () => $("download-btn").click()),
          nvBtn("svg", () => $("svg-btn").click()),
        );
        if (mode === "video" || mode === "live") {
          const exp = nvBtn(mode === "live" ? "record" : "export mov", () => {
            if (mode === "video") $("export-video-btn").click();
            else toggleLiveRecord();
          });
          exp.classList.add("nbtn-primary");
          acts.appendChild(exp);
        }
        card.appendChild(acts);
      } else {
        const thumb = document.createElement("canvas");
        thumb.className = "node-thumb";
        thumb.width = 150; thumb.height = base ? base.height : 100;
        card.appendChild(thumb);
        if (base) thumb.getContext("2d").putImageData(applyUpTo(base, list, i), 0, 0);

        if (n.kind === "source") {
          const tabs = document.createElement("div");
          tabs.className = "node-source-tabs";
          const b = document.createElement("button");
          b.type = "button"; b.className = "src-tab active";
          b.textContent = "timeline · edit";
          b.addEventListener("click", (ev) => { ev.stopPropagation(); enterEditor(); });
          tabs.appendChild(b);
          card.appendChild(tabs);
        } else {
          const x = document.createElement("button");
          x.className = "node-x node-card-x"; x.type = "button"; x.textContent = "×";
          x.setAttribute("aria-label", `remove ${n.label}`);
          x.addEventListener("click", (ev) => { ev.stopPropagation(); removeNode(n); });
          card.appendChild(x);
          card.addEventListener("click", (ev) => {
            if (!ev.target.closest("button")) openNodeParams(n);
          });
        }
      }

      if (n.kind !== "result") {
        const plus = document.createElement("button");
        plus.className = "node-plus"; plus.type = "button"; plus.textContent = "+";
        plus.setAttribute("aria-label", "add filter");
        plus.addEventListener("click", (ev) => { ev.stopPropagation(); toggleAddMenu(plus); });
        card.appendChild(plus);
      }

      makeCardDraggable(card, n.kind === "result");
      graph.appendChild(card);
    });
    layoutNodes();
  }

  function layoutNodes() {
    const graph = $("node-graph");
    const cards = [...graph.children];
    const midY = graph.clientHeight / 2;
    let x = 44;
    for (const card of cards) {
      const id = card.dataset.nid;
      const p = nodePos[id] || (nodePos[id] = { dx: 0, dy: 0 });
      const w = card.offsetWidth, h = card.offsetHeight;
      p.bx = x; p.by = midY - h / 2;
      card.style.left = (p.bx + p.dx) + "px";
      card.style.top = (p.by + p.dy) + "px";
      x += w + 74;
    }
    requestAnimationFrame(updateWires);
  }

  function updateWires() {
    const v = $("node-view");
    if (v.hidden) return;
    const vr = v.getBoundingClientRect();
    const svg = $("node-wires");
    svg.setAttribute("viewBox", `0 0 ${vr.width} ${vr.height}`);
    const cards = [...$("node-graph").children];
    let paths = "", dots = "";
    for (let i = 0; i < cards.length - 1; i++) {
      const a = cards[i].getBoundingClientRect(), b = cards[i + 1].getBoundingClientRect();
      const x1 = a.right - vr.left, y1 = a.top + a.height / 2 - vr.top;
      const x2 = b.left - vr.left, y2 = b.top + b.height / 2 - vr.top;
      const dx = Math.max(28, (x2 - x1) / 2);
      paths += `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2} `;
      dots += `<circle cx="${x1}" cy="${y1}" r="3.5" fill="#d6cbfa"/><circle cx="${x2}" cy="${y2}" r="3.5" fill="#d6cbfa"/>`;
    }
    svg.innerHTML = `<path d="${paths}" stroke="#4a4a44" stroke-width="1.5" fill="none"/>${dots}`;
  }

  function makeCardDraggable(card, byTitleOnly) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    card.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button, input, select, textarea, .node-actions")) return;
      if (byTitleOnly && !ev.target.closest(".node-title")) return;
      const id = card.dataset.nid;
      const p = nodePos[id] || (nodePos[id] = { dx: 0, dy: 0, bx: 0, by: 0 });
      dragging = true;
      card.setPointerCapture(ev.pointerId);
      sx = ev.clientX; sy = ev.clientY; ox = p.dx; oy = p.dy;
      card.style.zIndex = 5;
      ev.preventDefault();
      ev.stopPropagation();
    });
    card.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const p = nodePos[card.dataset.nid];
      p.dx = ox + ev.clientX - sx;
      p.dy = oy + ev.clientY - sy;
      card.style.left = (p.bx + p.dx) + "px";
      card.style.top = (p.by + p.dy) + "px";
      updateWires();
    });
    for (const n of ["pointerup", "pointercancel"]) {
      card.addEventListener(n, () => { dragging = false; });
    }
  }

  // pan the whole graph by dragging empty canvas
  (() => {
    const v = $("node-view");
    let panning = false, sx = 0, sy = 0, starts = null;
    v.addEventListener("pointerdown", (ev) => {
      if (ev.target !== v && ev.target.id !== "node-wires" && ev.target.id !== "node-graph") return;
      panning = true;
      v.setPointerCapture(ev.pointerId);
      sx = ev.clientX; sy = ev.clientY;
      starts = [...$("node-graph").children].map((c) => {
        const p = nodePos[c.dataset.nid]; return [c, p.dx, p.dy];
      });
    });
    v.addEventListener("pointermove", (ev) => {
      if (!panning) return;
      for (const [c, x0, y0] of starts) {
        const p = nodePos[c.dataset.nid];
        p.dx = x0 + ev.clientX - sx; p.dy = y0 + ev.clientY - sy;
        c.style.left = (p.bx + p.dx) + "px"; c.style.top = (p.by + p.dy) + "px";
      }
      updateWires();
    });
    for (const n of ["pointerup", "pointercancel"]) v.addEventListener(n, () => { panning = false; });
  })();

  function toggleAddMenu(anchor) {
    const menu = $("node-add-menu");
    if (!menu.hidden && menu._anchor === anchor) { menu.hidden = true; return; }
    menu.innerHTML = "";
    let hasAny = false;
    for (const def of NODE_DEFS()) {
      if (nodeEnabled(def)) continue;
      hasAny = true;
      const b = document.createElement("button");
      b.type = "button"; b.textContent = def.label.toLowerCase();
      b.addEventListener("click", () => {
        setNodeEnabled(def, true);
        menu.hidden = true;
        updateChips();
        render();
        renderNodeGraph();
      });
      menu.appendChild(b);
    }
    const star = document.createElement("button");
    star.type = "button"; star.textContent = "+ star overlay";
    star.addEventListener("click", () => {
      menu.hidden = true;
      addStar();
      renderNodeGraph();
    });
    menu.appendChild(star);
    if (!hasAny && !stars.length) { /* still show star option */ }

    const v = $("node-view").getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    menu.style.left = (a.right - v.left + 8) + "px";
    menu.style.top = (a.top - v.top) + "px";
    menu._anchor = anchor;
    menu.hidden = false;
  }

  function openNodeParams(def) {
    closeNodeParams();
    let node;
    if (def.kind === "effect") node = document.querySelector(`.effect[data-effect="${def.id}"]`);
    else if (def.kind === "module") node = document.querySelector(`[data-overlay-module="${def.id}"]`);
    else node = $("star-section");
    if (!node) return;
    nodeParamsStash = { def, node, parent: node.parentNode, next: node.nextSibling };
    $("node-params-title").textContent = (def.kind === "stars" ? "stars" : def.label).toLowerCase();
    $("node-params-body").appendChild(node);
    if (node.classList.contains("effect")) node.classList.add("open");
    $("node-backdrop").hidden = false;
    $("node-params").hidden = false;
  }
  function closeNodeParams() {
    if (nodeParamsStash) {
      nodeParamsStash.parent.insertBefore(nodeParamsStash.node, nodeParamsStash.next);
      nodeParamsStash = null;
    }
    $("node-params").hidden = true;
    $("node-backdrop").hidden = true;
  }

  // refresh node thumbnails without rebuilding the layout
  function refreshThumbs() {
    if (!document.body.classList.contains("node-mode")) return;
    const list = pipeline();
    const base = thumbBase();
    if (!base) return;
    const cards = [...$("node-graph").children];
    cards.forEach((card, i) => {
      const th = card.querySelector(".node-thumb");
      if (!th) return;
      if (th.height !== base.height) th.height = base.height;
      th.getContext("2d").putImageData(applyUpTo(base, list, i), 0, 0);
    });
  }
  function scheduleThumbs() {
    if (!document.body.classList.contains("node-mode")) return;
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(refreshThumbs, 140);
  }

  function enterNodeView() {
    closeSheet(true);
    document.body.classList.add("node-mode");
    $("node-view").hidden = false;
    renderNodeGraph();          // this moves the canvas into the result node
    requestAnimationFrame(updateWires);
    // installed / fullscreen PWAs can request landscape; harmless elsewhere
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(() => {}); } catch { /* ignore */ }
  }
  function exitNodeView() {
    if (!document.body.classList.contains("node-mode")) return;
    closeNodeParams();
    $("node-add-menu").hidden = true;
    document.body.classList.remove("node-mode");
    $("node-view").hidden = true;
    $("canvas-wrap").appendChild(canvas);
  }

  $("node-params-close").addEventListener("click", closeNodeParams);
  $("node-backdrop").addEventListener("click", closeNodeParams);
  window.addEventListener("resize", () => {
    if (document.body.classList.contains("node-mode")) layoutNodes();
  });
  window.addEventListener("orientationchange", () => {
    if (document.body.classList.contains("node-mode")) setTimeout(layoutNodes, 250);
  });
  document.addEventListener("change", (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains("effect-toggle")) {
      renderNodeGraph();
    }
  });

  // =====================================================================
  // TIMELINE editor — Final-Cut-style: 3 magnetic layers, any media as
  // clips, ≤15s, scrub/play; the composite feeds the effect pipeline.
  // =====================================================================

  const TL = {
    clips: [], duration: 15, playhead: 0, playing: false,
    raf: 0, lastPerf: 0, W: 960, H: 540, sel: null, nextId: 1,
  };
  const tlCanvas = document.createElement("canvas");
  const tlCtx = tlCanvas.getContext("2d", { willReadFrequently: true });
  const SNAP_PX = 7;
  let mixCtx = null, mixDest = null, mixAnalyser = null, mixData = null;
  function ensureMix() {
    if (!mixCtx) {
      try {
        mixCtx = new (window.AudioContext || window.webkitAudioContext)();
        mixDest = mixCtx.createMediaStreamDestination();
        mixAnalyser = mixCtx.createAnalyser(); mixAnalyser.fftSize = 256;
        mixData = new Uint8Array(mixAnalyser.frequencyBinCount);
      } catch { mixCtx = null; }
    }
    if (mixCtx && mixCtx.state === "suspended") mixCtx.resume().catch(() => {});
    return mixCtx;
  }
  function connectClipAudio(c) {
    if (c._src || (c.kind !== "video" && c.kind !== "audio")) return;
    if (!ensureMix()) return;
    try {
      c._src = mixCtx.createMediaElementSource(c.el);
      c._src.connect(mixCtx.destination); // speakers
      c._src.connect(mixDest);            // export tap
      c._src.connect(mixAnalyser);        // beat detection
    } catch { c._src = null; }
  }
  function updateBeat() {
    if (!mixAnalyser || !mixData) return;
    mixAnalyser.getByteFrequencyData(mixData);
    let sum = 0; const n = Math.min(28, mixData.length);
    for (let i = 0; i < n; i++) sum += mixData[i];
    audioLevel = audioLevel * 0.72 + ((sum / n) / 255) * 0.28;
  }

  function tlTracksEl() { return $("tl-tracks"); }
  function tlPPS() { const w = tlTracksEl().clientWidth - 16; return Math.max(1, w) / TL.duration; }
  function projectEnd() { return Math.min(TL.duration, TL.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0)); }
  function remainingFrom(t) { return Math.max(0.5, TL.duration - t); }

  function drawVisual(ctx, el, ew, eh, c) {
    const W = TL.W, H = TL.H;
    if (!ew || !eh) return;
    const base = c.fit === "contain" ? Math.min(W / ew, H / eh)
      : c.fit === "stretch" ? 0 : Math.max(W / ew, H / eh);
    if (c.fit === "stretch") {
      const dw = W * (c.scale || 1), dh = H * (c.scale || 1);
      ctx.drawImage(el, (W - dw) / 2 + (c.ox || 0) * W, (H - dh) / 2 + (c.oy || 0) * H, dw, dh);
      return;
    }
    const sc = base * (c.scale || 1);
    const dw = ew * sc, dh = eh * sc;
    ctx.drawImage(el, (W - dw) / 2 + (c.ox || 0) * W, (H - dh) / 2 + (c.oy || 0) * H, dw, dh);
  }

  function clipsOnLayer(layer) {
    return TL.clips.filter((c) => c.layer === layer).sort((a, b) => a.start - b.start);
  }
  function clipAt(layer, t) {
    return TL.clips.find((c) => c.layer === layer && t >= c.start && t < c.start + c.dur);
  }

  function drawTLClip(ctx, c, t) {
    const lt = t - c.start;
    if (c.kind === "image") { drawVisual(ctx, c.el, c.natW, c.natH, c); }
    else if (c.kind === "video") {
      try { drawVisual(ctx, c.el, c.el.videoWidth, c.el.videoHeight, c); } catch { /* not ready */ }
    } else if (c.kind === "color") {
      ctx.fillStyle = c.color; ctx.fillRect(0, 0, TL.W, TL.H);
    } else if (c.kind === "text") {
      const s = c.style;
      const pulse = 1 + audioLevel * (s.pulse || 0) * 0.6;
      ctx.font = `${s.weight} ${(s.size / 100) * TL.H * pulse}px ${s.family}`;
      ctx.fillStyle = s.color; ctx.textAlign = s.align; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = (s.size / 100) * TL.H * 0.08;
      const cx = s.align === "left" ? TL.W * 0.06 : s.align === "right" ? TL.W * 0.94 : TL.W * s.x;
      const lines = String(s.text).split("\n"); const lh = (s.size / 100) * TL.H * 1.15;
      let y = TL.H * s.y - (lines.length - 1) * lh / 2;
      for (const ln of lines) { ctx.fillText(ln, cx, y); y += lh; }
      ctx.shadowBlur = 0;
    }
  }

  function compositeFrame(t) {
    tlCtx.clearRect(0, 0, TL.W, TL.H);
    tlCtx.fillStyle = "#000"; tlCtx.fillRect(0, 0, TL.W, TL.H);
    for (let layer = 2; layer >= 0; layer--) {
      const c = clipAt(layer, t);
      if (c) drawTLClip(tlCtx, c, t);
    }
    return tlCtx.getImageData(0, 0, TL.W, TL.H);
  }

  function renderComposite() {
    if (!TL.clips.length) { drawEmptyPreview(); return; }
    updateBeat();
    const frame = compositeFrame(TL.playhead);
    const out = pipelineApply(frame, frameSeedAt(Math.floor(TL.playhead * EXPORT_FPS)), TL.playing || audioActive());
    if (canvas.width !== out.width) canvas.width = out.width;
    if (canvas.height !== out.height) canvas.height = out.height;
    ctx.putImageData(out, 0, 0);
    scheduleThumbs();
  }

  function drawEmptyPreview() {
    canvas.width = TL.W; canvas.height = TL.H;
    ctx.fillStyle = "#0e0e0c"; ctx.fillRect(0, 0, TL.W, TL.H);
    ctx.fillStyle = "#3a3a34"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "500 26px Georgia, serif";
    ctx.fillText("+ media to begin", TL.W / 2, TL.H / 2);
  }

  // media playback sync during play / scrub
  function syncMedia(seek) {
    for (const c of TL.clips) {
      if (c.kind !== "video" && c.kind !== "audio") continue;
      const inClip = TL.playhead >= c.start && TL.playhead < c.start + c.dur;
      const local = (c.inPoint || 0) + (TL.playhead - c.start);
      if (inClip && TL.playing) {
        if (c.el.paused) { try { c.el.currentTime = local; } catch {} c.el.play().catch(() => {}); }
        else if (Math.abs(c.el.currentTime - local) > 0.35) { try { c.el.currentTime = local; } catch {} }
      } else if (seek && inClip) {
        try { c.el.currentTime = local; } catch {}
        c.el.pause();
      } else if (!c.el.paused) { c.el.pause(); }
    }
  }

  function tlLoop() {
    const now = performance.now();
    TL.playhead += (now - TL.lastPerf) / 1000;
    TL.lastPerf = now;
    if (TL.playhead >= projectEnd()) { TL.playhead = 0; }
    syncMedia(false);
    renderComposite();
    updatePlayhead();
    if (TL.playing) TL.raf = requestAnimationFrame(tlLoop);
  }
  function tlPlay() {
    if (TL.playing || !TL.clips.length) return;
    if (TL.playhead >= projectEnd() - 0.02) TL.playhead = 0;
    TL.playing = true; TL.lastPerf = performance.now();
    $("tl-play").innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" fill="currentColor"/></svg><span>pause</span>';
    tlLoop();
  }
  function tlPause() {
    TL.playing = false; cancelAnimationFrame(TL.raf);
    for (const c of TL.clips) if (c.el && (c.kind === "video" || c.kind === "audio")) c.el.pause();
    $("tl-play").innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 1.5v9l8-4.5z" fill="currentColor"/></svg><span>play</span>';
    syncMedia(true); renderComposite();
  }
  function tlTogglePlay() { TL.playing ? tlPause() : tlPlay(); }

  function updatePlayhead() {
    const pps = tlPPS();
    $("tl-playhead").style.left = (8 + TL.playhead * pps) + "px";
    $("tl-time").textContent = `${TL.playhead.toFixed(1)} / ${projectEnd().toFixed(1)}s`;
  }

  function buildRuler() {
    const r = $("tl-ruler"); r.innerHTML = ""; const pps = tlPPS();
    for (let s = 0; s <= TL.duration; s++) {
      const t = document.createElement("span");
      t.className = "tl-tick"; t.style.left = (s * pps) + "px"; t.textContent = s + "s";
      r.appendChild(t);
    }
  }

  function clipLabel(c) {
    return c.kind === "text" ? (c.style.text.split("\n")[0] || "text")
      : c.kind === "color" ? "color" : c.name || c.kind;
  }

  function renderTimeline() {
    buildRuler();
    const pps = tlPPS();
    document.querySelectorAll(".tl-clip").forEach((e) => e.remove());
    for (const c of TL.clips) {
      const track = document.querySelector(`.tl-track[data-layer="${c.layer}"]`);
      if (!track) continue;
      const el = document.createElement("div");
      el.className = `tl-clip tl-clip-c-${c.kind}` + (TL.sel === c.id ? " sel" : "");
      el.dataset.cid = c.id;
      el.style.left = (c.start * pps) + "px";
      el.style.width = Math.max(14, c.dur * pps) + "px";
      if (c.thumb) { const t = document.createElement("div"); t.className = "tl-clip-thumb"; t.style.backgroundImage = `url(${c.thumb})`; el.appendChild(t); }
      const lab = document.createElement("span"); lab.className = "tl-clip-label"; lab.textContent = clipLabel(c); el.appendChild(lab);
      const hl = document.createElement("div"); hl.className = "tl-clip-handle l"; el.appendChild(hl);
      const hr = document.createElement("div"); hr.className = "tl-clip-handle r"; el.appendChild(hr);
      track.appendChild(el);
    }
    updatePlayhead();
    $("tl-del").hidden = TL.sel == null;
    $("tl-edit").hidden = TL.sel == null;
  }

  // snap candidate times from clip edges (excluding the moving clip), 0, end, playhead
  function snapTimes(exceptId) {
    const arr = [0, TL.duration, TL.playhead];
    for (const c of TL.clips) { if (c.id === exceptId) continue; arr.push(c.start, c.start + c.dur); }
    return arr;
  }
  function snap(t, exceptId, pps) {
    let best = t, bestD = SNAP_PX / pps;
    for (const s of snapTimes(exceptId)) {
      const d = Math.abs(s - t);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  function overlaps(layer, start, dur, exceptId) {
    return TL.clips.some((c) => c.layer === layer && c.id !== exceptId &&
      start < c.start + c.dur - 1e-4 && start + dur > c.start + 1e-4);
  }

  function placeClip(c) {
    // try each layer top→bottom at the playhead, else find any gap
    for (let L = 0; L < 3; L++) {
      if (!overlaps(L, TL.playhead, c.dur)) { c.layer = L; c.start = Math.min(TL.playhead, TL.duration - c.dur); return; }
    }
    for (let L = 0; L < 3; L++) {
      const row = clipsOnLayer(L); let cursor = 0;
      for (const o of row) { if (o.start - cursor >= c.dur) break; cursor = Math.max(cursor, o.start + o.dur); }
      if (cursor + c.dur <= TL.duration) { c.layer = L; c.start = cursor; return; }
    }
    c.layer = 0; c.start = Math.max(0, Math.min(TL.playhead, TL.duration - c.dur));
  }

  function addClipObj(c) {
    c.id = TL.nextId++;
    placeClip(c);
    TL.clips.push(c);
    TL.sel = c.id;
    renderTimeline();
    renderComposite();
    if (document.body.classList.contains("node-mode")) renderNodeGraph();
  }

  function hasVisual() { return TL.clips.some((c) => c.kind === "image" || c.kind === "video"); }
  function setAspect(w, h) {
    if (!w || !h) return;
    TL.W = w >= h ? Math.min(1280, w) : Math.round(720 * w / h);
    TL.H = Math.round(TL.W * h / w);
    tlCanvas.width = TL.W; tlCanvas.height = TL.H;
  }
  function tlAddImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (!hasVisual()) setAspect(img.naturalWidth, img.naturalHeight);
      addClipObj({ kind: "image", el: img, natW: img.naturalWidth, natH: img.naturalHeight, name: file.name, thumb: url, fit: "cover", scale: 1, ox: 0, oy: 0, start: 0, dur: Math.min(3, remainingFrom(TL.playhead)), layer: 0 });
    };
    img.src = url;
  }
  function tlAddVideo(file) {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.src = url; v.muted = false; v.playsInline = true; v.preload = "auto";
    v.addEventListener("loadedmetadata", () => {
      if (!hasVisual() && v.videoWidth) setAspect(v.videoWidth, v.videoHeight);
      const dur = Math.min(isFinite(v.duration) ? v.duration : 5, remainingFrom(TL.playhead), TL.duration);
      const clip = { kind: "video", el: v, natW: v.videoWidth, natH: v.videoHeight, fit: "cover", scale: 1, ox: 0, oy: 0, inPoint: 0, mediaDur: v.duration, name: file.name, start: 0, dur, layer: 0 };
      connectClipAudio(clip); addClipObj(clip);
    }, { once: true });
  }
  function tlAddVideoBlob(blob, name) {
    tlAddVideo(new File([blob], name || "camera.webm", { type: blob.type || "video/webm" }));
  }
  function tlAddImageBlob(blob, name) {
    tlAddImage(new File([blob], name || "photo.png", { type: blob.type || "image/png" }));
  }

  // ---- camera capture: snap a photo or record a clip into the timeline ----
  let capStream = null, capRec = null, capChunks = [], capFacing = "user", capRecStart = 0, capRaf = 0;
  async function openCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert("Camera needs HTTPS and a supported browser."); return; }
    try {
      capStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: capFacing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    } catch { alert("Camera/mic access was blocked. Allow it and try again."); return; }
    const v = $("capture-video");
    v.srcObject = capStream; v.classList.toggle("mirror", capFacing === "user");
    v.play().catch(() => {});
    $("capture").hidden = false;
  }
  function closeCapture() {
    if (capRec && capRec.state !== "inactive") { try { capRec.stop(); } catch {} }
    cancelAnimationFrame(capRaf);
    if (capStream) for (const t of capStream.getTracks()) t.stop();
    capStream = null; capRec = null;
    $("capture").hidden = true;
    $("cap-rec").textContent = "record"; $("cap-rec").classList.remove("cap-rec-on");
  }
  function capSnap() {
    const v = $("capture-video");
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext("2d");
    if (capFacing === "user") { g.translate(c.width, 0); g.scale(-1, 1); }
    g.drawImage(v, 0, 0);
    c.toBlob((b) => { tlAddImageBlob(b, "photo.png"); closeCapture(); }, "image/png");
  }
  function capToggleRec() {
    if (capRec && capRec.state === "recording") { capRec.stop(); return; }
    if (typeof MediaRecorder === "undefined") { alert("Recording not supported here."); return; }
    const mime = ["video/mp4;codecs=avc1.64002A,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
    capRec = new MediaRecorder(capStream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    capChunks = [];
    capRec.ondataavailable = (e) => { if (e.data.size) capChunks.push(e.data); };
    capRec.onstop = () => {
      cancelAnimationFrame(capRaf);
      const blob = new Blob(capChunks, { type: capRec.mimeType || mime });
      tlAddVideoBlob(blob, "camera.webm");
      closeCapture();
    };
    capRec.start(200); capRecStart = performance.now();
    $("cap-rec").classList.add("cap-rec-on");
    const tick = () => {
      const el = (performance.now() - capRecStart) / 1000;
      $("cap-rec").textContent = `stop ${el.toFixed(1)}s`;
      if (el >= MAX_CLIP_SECONDS) { capRec.stop(); return; }
      capRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  async function capFlip() {
    capFacing = capFacing === "user" ? "environment" : "user";
    if (capStream) for (const t of capStream.getTracks()) t.stop();
    try {
      capStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: capFacing }, audio: true });
      const v = $("capture-video"); v.srcObject = capStream; v.classList.toggle("mirror", capFacing === "user"); v.play().catch(() => {});
    } catch {}
  }
  $("cap-snap").addEventListener("click", capSnap);
  $("cap-rec").addEventListener("click", capToggleRec);
  $("cap-flip").addEventListener("click", capFlip);
  $("cap-close").addEventListener("click", closeCapture);

  function tlAddAudio(file) {
    const url = URL.createObjectURL(file);
    const a = new Audio(url); a.preload = "auto";
    a.addEventListener("loadedmetadata", () => {
      const dur = Math.min(isFinite(a.duration) ? a.duration : 10, TL.duration);
      const clip = { kind: "audio", el: a, inPoint: 0, mediaDur: a.duration, name: file.name || "audio", start: 0, dur, layer: 2 };
      connectClipAudio(clip); addClipObj(clip);
    }, { once: true });
  }
  function tlAddText() {
    addClipObj({ kind: "text", style: { text: "VERSIONS", size: 12, x: 0.5, y: 0.5, color: "#ffffff", align: "center", weight: "bold", family: "serif", pulse: 0 }, start: 0, dur: 3, layer: 0 });
  }
  function tlAddColor() {
    addClipObj({ kind: "color", color: "#8f78ff", start: 0, dur: 3, layer: 2 });
  }

  function deleteSelectedClip() {
    if (TL.sel == null) return;
    const c = TL.clips.find((x) => x.id === TL.sel);
    if (c && c.el && c.el.pause) c.el.pause();
    TL.clips = TL.clips.filter((x) => x.id !== TL.sel);
    TL.sel = null;
    renderTimeline(); renderComposite();
    if (document.body.classList.contains("node-mode")) renderNodeGraph();
  }

  // ---- timeline interactions: select, drag, trim, scrub ----
  function tlClipFromEvent(ev) { const el = ev.target.closest(".tl-clip"); return el ? TL.clips.find((c) => c.id === +el.dataset.cid) : null; }

  tlTracksEl().addEventListener("pointerdown", (ev) => {
    const clipEl = ev.target.closest(".tl-clip");
    if (!clipEl) return;
    const c = TL.clips.find((x) => x.id === +clipEl.dataset.cid);
    if (!c) return;
    TL.sel = c.id; renderTimeline();
    const pps = tlPPS();
    const handle = ev.target.classList.contains("tl-clip-handle") ? (ev.target.classList.contains("l") ? "l" : "r") : null;
    const x0 = ev.clientX, s0 = c.start, d0 = c.dur, in0 = c.inPoint || 0;
    tlTracksEl().setPointerCapture(ev.pointerId);
    const move = (e) => {
      const dx = (e.clientX - x0) / pps;
      if (!handle) {
        let ns = snap(s0 + dx, c.id, pps);
        ns = Math.max(0, Math.min(TL.duration - c.dur, ns));
        // vertical: change layer by pointer row
        const row = e.target.closest ? null : null;
        const trackEls = [...document.querySelectorAll(".tl-track")];
        for (const tEl of trackEls) { const r = tEl.getBoundingClientRect(); if (e.clientY >= r.top && e.clientY <= r.bottom) { const L = +tEl.dataset.layer; if (!overlaps(L, ns, c.dur, c.id)) c.layer = L; } }
        if (!overlaps(c.layer, ns, c.dur, c.id)) c.start = ns;
      } else if (handle === "l") {
        let ns = snap(s0 + dx, c.id, pps);
        ns = Math.max(0, Math.min(s0 + d0 - 0.2, ns));
        const delta = ns - s0;
        if (!overlaps(c.layer, ns, d0 - delta, c.id)) { c.start = ns; c.dur = d0 - delta; if (c.kind === "video" || c.kind === "audio") c.inPoint = Math.max(0, in0 + delta); }
      } else {
        let ne = snap(s0 + d0 + dx, c.id, pps);
        let nd = Math.max(0.2, ne - c.start);
        if (c.mediaDur) nd = Math.min(nd, c.mediaDur - (c.inPoint || 0));
        nd = Math.min(nd, TL.duration - c.start);
        if (!overlaps(c.layer, c.start, nd, c.id)) c.dur = nd;
      }
      renderTimeline(); renderComposite();
    };
    const up = () => {
      tlTracksEl().removeEventListener("pointermove", move);
      tlTracksEl().removeEventListener("pointerup", up);
    };
    tlTracksEl().addEventListener("pointermove", move);
    tlTracksEl().addEventListener("pointerup", up);
    ev.preventDefault();
  });

  // scrub by dragging the ruler / empty track area
  function scrubFrom(clientX) {
    const rect = tlTracksEl().getBoundingClientRect();
    const pps = tlPPS();
    TL.playhead = Math.max(0, Math.min(projectEnd(), (clientX - rect.left - 8) / pps));
    syncMedia(true); renderComposite(); updatePlayhead();
  }
  for (const el of [$("tl-ruler"), $("tl-scroll")]) {
    el.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".tl-clip")) return;
      TL.sel = null; renderTimeline();
      if (TL.playing) tlPause();
      el.setPointerCapture(ev.pointerId);
      scrubFrom(ev.clientX);
      const mv = (e) => scrubFrom(e.clientX);
      const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); };
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
    });
  }

  // ---- add-media menu ----
  $("tl-add").addEventListener("click", (ev) => { ev.stopPropagation(); const m = $("tl-add-menu"); m.hidden = !m.hidden; });
  $("tl-add-menu").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-add]"); if (!b) return;
    $("tl-add-menu").hidden = true;
    const kind = b.dataset.add;
    if (kind === "text") return tlAddText();
    if (kind === "color") return tlAddColor();
    if (kind === "camera") return openCapture();
    const accept = kind === "image" ? "image/*,.heic,.heif" : kind === "video" ? "video/*" : "audio/*";
    pickFile(accept, kind);
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".tl-add-wrap")) $("tl-add-menu").hidden = true; });
  $("tl-play").addEventListener("click", tlTogglePlay);
  $("tl-del").addEventListener("click", deleteSelectedClip);
  $("tl-edit").addEventListener("click", () => {
    const c = TL.clips.find((x) => x.id === TL.sel);
    if (c) openClipParams(c);
  });

  // ---- selected clip → open its params (text/color) in the node modal ----
  tlTracksEl().addEventListener("dblclick", (ev) => {
    const c = tlClipFromEvent(ev); if (c) openClipParams(c);
  });

  function openClipParams(c) {
    const body = $("node-params-body");
    $("node-params-title").textContent = c.kind + " clip";
    body.innerHTML = "";
    const add = (p, get, set) => body.appendChild(buildParamRow(p, get, set));
    if (c.kind === "image" || c.kind === "video") {
      add({ key: "fit", label: "fit", type: "select",
            options: [["cover", "fill frame (cover)"], ["contain", "fit inside"], ["stretch", "stretch"]] },
          () => c.fit || "cover", (v) => { c.fit = v; renderComposite(); });
      add({ key: "scale", label: "scale", min: 0.2, max: 4, step: 0.02 },
          () => c.scale || 1, (v) => { c.scale = v; renderComposite(); });
      add({ key: "ox", label: "move x", min: -1, max: 1, step: 0.01 },
          () => c.ox || 0, (v) => { c.ox = v; renderComposite(); });
      add({ key: "oy", label: "move y", min: -1, max: 1, step: 0.01 },
          () => c.oy || 0, (v) => { c.oy = v; renderComposite(); });
      const tip = document.createElement("p"); tip.className = "hint";
      tip.style.marginTop = ".6rem"; tip.textContent = "tip: drag the image in the preview to move it";
      body.appendChild(tip);
    } else if (c.kind === "color") {
      add({ key: "color", label: "color", type: "color" },
        () => c.color, (v) => { c.color = v; renderTimeline(); renderComposite(); });
    } else {
      const P = [
        { key: "text", label: "text", type: "text" },
        { key: "size", label: "size", min: 2, max: 40, step: .5, unit: "%" },
        { key: "x", label: "x", min: 0, max: 1, step: .01 },
        { key: "y", label: "y", min: 0, max: 1, step: .01 },
        { key: "align", label: "align", type: "select", options: [["center", "center"], ["left", "left"], ["right", "right"]] },
        { key: "weight", label: "weight", type: "select", options: [["bold", "bold"], ["normal", "regular"], ["800", "black"]] },
        { key: "family", label: "typeface", type: "select", options: [["serif", "serif"], ["sans-serif", "sans"], ["monospace", "mono"]] },
        { key: "color", label: "color", type: "color" },
        { key: "pulse", label: "beat pulse", min: 0, max: 1, step: 0.05 },
      ];
      for (const p of P) body.appendChild(buildParamRow(p, () => c.style[p.key], (v) => { c.style[p.key] = v; renderTimeline(); renderComposite(); }));
    }
    $("node-backdrop").hidden = false; $("node-params").hidden = false;
    nodeParamsStash = null;
  }

  // ---- view switching ----
  function activeVisualClip() {
    for (let L = 0; L < 3; L++) {
      const c = clipAt(L, TL.playhead);
      if (c && (c.kind === "image" || c.kind === "video")) return c;
    }
    return null;
  }
  (function previewDrag() {
    let dragging = null, sx = 0, sy = 0, ox0 = 0, oy0 = 0;
    canvas.addEventListener("pointerdown", (ev) => {
      if (!document.body.classList.contains("editor-mode")) return;
      const c = activeVisualClip(); if (!c) return;
      dragging = c; sx = ev.clientX; sy = ev.clientY; ox0 = c.ox || 0; oy0 = c.oy || 0;
      canvas.setPointerCapture(ev.pointerId); ev.preventDefault();
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      dragging.ox = ox0 + (ev.clientX - sx) / r.width;
      dragging.oy = oy0 + (ev.clientY - sy) / r.height;
      renderComposite();
    });
    for (const n of ["pointerup", "pointercancel"]) canvas.addEventListener(n, () => { dragging = null; });
    canvas.addEventListener("wheel", (ev) => {
      if (!document.body.classList.contains("editor-mode")) return;
      const c = activeVisualClip(); if (!c) return;
      ev.preventDefault();
      c.scale = Math.max(0.2, Math.min(4, (c.scale || 1) * (ev.deltaY < 0 ? 1.06 : 0.94)));
      renderComposite();
    }, { passive: false });
  })();

  function enterEditor() {
    document.body.classList.remove("node-mode");
    document.body.classList.add("editor-mode");
    $("node-view").hidden = true;
    $("editor-view").hidden = false;
    $("ev-preview").appendChild(canvas);
    requestAnimationFrame(() => { buildRuler(); renderTimeline(); renderComposite(); });
  }
  function editorToEffects() {
    document.body.classList.remove("editor-mode");
    enterNodeView();
  }
  async function tlExport() {
    if (!TL.clips.length || TL._exporting) return;
    TL._exporting = true;
    const btn = $("tl-export"); btn.disabled = true; btn.textContent = "exporting…";
    tlPause(); TL.playhead = 0; syncMedia(true); renderComposite();
    const vstream = canvas.captureStream(EXPORT_FPS);
    ensureMix();
    const tracks = [...vstream.getVideoTracks(), ...(mixDest ? mixDest.stream.getAudioTracks() : [])];
    const stream = new MediaStream(tracks);
    const pick = [
      ["video/mp4;codecs=avc1.64002A,mp4a.40.2", "mov"],
      ["video/mp4", "mov"],
      ["video/webm;codecs=vp9,opus", "webm"],
      ["video/webm;codecs=vp8,opus", "webm"],
      ["video/webm", "webm"],
    ].find(([m]) => MediaRecorder.isTypeSupported(m)) || ["video/webm", "webm"];
    const [mime, ext] = pick;
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(200);
    const end = projectEnd();
    TL.playing = true; TL.lastPerf = performance.now();
    await new Promise((res) => {
      (function step() {
        const now = performance.now();
        TL.playhead += (now - TL.lastPerf) / 1000; TL.lastPerf = now;
        syncMedia(false); renderComposite(); updatePlayhead();
        btn.textContent = `exporting ${Math.min(100, Math.round(TL.playhead / end * 100))}%`;
        if (TL.playhead >= end) { res(); return; }
        requestAnimationFrame(step);
      })();
    });
    TL.playing = false;
    for (const c of TL.clips) if (c.el && c.el.pause) c.el.pause();
    rec.stop(); await done;
    deliverFile(new Blob(chunks, { type: mime }), `versions-eye-${Date.now().toString(36)}.${ext}`);
    TL.playhead = 0; renderComposite(); updatePlayhead();
    TL._exporting = false; btn.disabled = false; btn.textContent = "export";
  }
  function applyVisualizer() {
    chain.dither.enabled = true;
    Object.assign(chain.dither.params, { algorithm: "bayer8", palette: "flareware", pixelSize: 3, contrast: 1.15 });
    chain.rgbshift.enabled = true; Object.assign(chain.rgbshift.params, { amount: 4, angle: 0 });
    chain.slice.enabled = true; Object.assign(chain.slice.params, { slices: 6, intensity: 0.4, channelTear: true });
    chain.wave.enabled = true; Object.assign(chain.wave.params, { amplitude: 6, frequency: 3, axis: "horizontal" });
    audioReact.amount = 0.95;
    syncControls();
    if (!TL.clips.some((c) => c.kind === "text")) {
      addClipObj({ kind: "text", style: { text: "type your lyrics\nhere", size: 9, x: 0.5, y: 0.82, color: "#ffffff", align: "center", weight: "bold", family: "serif", pulse: 0.6 }, start: 0, dur: Math.max(3, projectEnd()), layer: 0 });
    }
    renderComposite();
    const hasAudio = TL.clips.some((c) => c.kind === "audio" || c.kind === "video");
    toast(hasAudio ? "visualizer on — hit play, it distorts to the beat · edit the lyrics clip"
      : "visualizer on — add an audio track, then play to make it react", 4600);
  }
  $("tl-visualizer").addEventListener("click", applyVisualizer);
  $("tl-export").addEventListener("click", tlExport);

  $("to-effects").addEventListener("click", editorToEffects);
  $("to-editor").addEventListener("click", enterEditor);
  window.addEventListener("resize", () => { if (document.body.classList.contains("editor-mode")) { buildRuler(); renderTimeline(); } });


  buildControls();
  buildOverlayList();
  buildChips();
  buildLooks();

  // open straight into the editor — no landing; media is added on the timeline
  $("dropzone").hidden = true;
  $("workspace").hidden = false;
  enterEditor();
})();
