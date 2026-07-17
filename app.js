/* ALFIETO'S PIXEL — UI wiring: load image/video, build controls,
 * run the effect pipeline (live for video), export PNG or WebM. */
"use strict";

(() => {
  const MAX_DIM = 1600;        // cap for still images
  const MAX_VIDEO_DIM = 960;   // lower cap so per-frame effects stay realtime
  const MAX_CLIP_SECONDS = 10; // videos are trimmed to their first 10s
  const EXPORT_FPS = 30;

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

  // recording state
  let recorder = null;
  let recording = false;
  let recChunks = [];

  // ---- effect chain state, built from the registry ----
  const chain = {};
  for (const e of Effects.REGISTRY) {
    chain[e.id] = { enabled: false, params: { ...e.defaults } };
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

  function frameSeed() {
    // mix the frame index into the seed so glitches animate over time,
    // but deterministically — preview and export show the same frames
    const f = Math.floor((videoEl ? videoEl.currentTime : 0) * EXPORT_FPS);
    return (seed ^ Math.imul(f + 1, 2654435761)) >>> 0;
  }

  function videoLoop() {
    if (mode !== "video" || !videoEl) return;
    const vw = vidCanvas.width, vh = vidCanvas.height;

    if (videoEl.ended || videoEl.currentTime >= clipEnd) {
      if (recording) stopRecorder();
      videoEl.currentTime = 0;
      if (videoEl.paused) videoEl.play().catch(() => {});
    }

    vctx.drawImage(videoEl, 0, 0, vw, vh);
    let frame = vctx.getImageData(0, 0, vw, vh);
    if (!holdOriginal) frame = Effects.apply(frame, chain, frameSeed());
    if (canvas.width !== vw) canvas.width = vw;
    if (canvas.height !== vh) canvas.height = vh;
    ctx.putImageData(frame, 0, 0);

    if (recording) {
      $("export-video-btn").textContent =
        `⏺ ${videoEl.currentTime.toFixed(1)}s / ${clipEnd.toFixed(1)}s`;
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

  function enterWorkspace() {
    $("dropzone").hidden = true;
    $("workspace").hidden = false;
    updateModeUI();
  }

  function updateModeUI() {
    const isVideo = mode === "video";
    $("playpause-btn").hidden = !isVideo;
    $("export-video-btn").hidden = !isVideo;
    $("download-btn").textContent = isVideo ? "↓ frame PNG" : "↓ download PNG";
    $("playpause-btn").textContent = "⏸ pause";
  }

  function cleanupVideo() {
    cancelAnimationFrame(vidRaf);
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recording = false;
    if (videoEl) videoEl.pause();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoEl = null;
    videoUrl = null;
    $("export-video-btn").disabled = false;
    $("export-video-btn").textContent = "⏺ export WebM";
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

  function loadVideoFile(file) {
    cleanupVideo();
    videoUrl = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.addEventListener("loadedmetadata", () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { cleanupVideo(); return; }
      clipEnd = Math.min(v.duration || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS);
      const ratio = Math.min(1, MAX_VIDEO_DIM / Math.max(w, h));
      vidCanvas.width = Math.max(1, Math.round(w * ratio));
      vidCanvas.height = Math.max(1, Math.round(h * ratio));
      videoEl = v;
      mode = "video";
      enterWorkspace();
      v.play().catch(() => {});
      cancelAnimationFrame(vidRaf);
      vidRaf = requestAnimationFrame(videoLoop);
    }, { once: true });
    v.src = videoUrl;
  }

  function loadFile(file) {
    if (!file) return;
    if (file.type.startsWith("video/")) loadVideoFile(file);
    else if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { loadFromImageElement(img); URL.revokeObjectURL(url); };
      img.src = url;
    }
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
    c.fillStyle = "#00ffc3";
    c.font = "bold 50px monospace";
    c.textAlign = "center";
    c.fillText("ALFIETO'S PIXEL", w / 2, h * 0.18);
    loadFromImageElement(off);
  }

  // =====================================================================
  // video export — record the live-previewed canvas with MediaRecorder
  // =====================================================================

  function pickMime() {
    if (typeof MediaRecorder === "undefined") return null;
    return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m)) || null;
  }

  function stopRecorder() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  function exportVideo() {
    if (recording || mode !== "video" || !videoEl) return;
    const mime = pickMime();
    if (!mime) {
      alert("This browser doesn't support MediaRecorder video export.");
      return;
    }
    const btn = $("export-video-btn");
    btn.disabled = true;
    btn.textContent = "⏺ starting…";

    const stream = canvas.captureStream(EXPORT_FPS);
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `alfietos-pixel-${seed.toString(16)}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      recording = false;
      btn.disabled = false;
      btn.textContent = "⏺ export WebM";
    };

    // restart the clip so the export covers 0 → clipEnd, then record
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

  // =====================================================================
  // controls UI
  // =====================================================================

  function fmt(v, p) {
    const num = typeof v === "number" ? (p.step >= 1 ? v : v.toFixed(2)) : v;
    return `${num}${p.unit || ""}`;
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
      chain[e.id] = { enabled: false, params: { ...e.defaults } };
    }
    chain.dither.enabled = true;
    syncControls();
    render();
  }

  function download() {
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `alfietos-pixel-${seed.toString(16)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
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
  $("download-btn").addEventListener("click", download);
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
      $("playpause-btn").textContent = "⏸ pause";
    } else {
      videoEl.pause();
      $("playpause-btn").textContent = "▶ play";
    }
  });

  const origBtn = $("original-btn");
  origBtn.addEventListener("pointerdown", () => showOriginal(true));
  for (const evName of ["pointerup", "pointerleave", "pointercancel"]) {
    origBtn.addEventListener(evName, () => showOriginal(false));
  }

  buildControls();
})();
