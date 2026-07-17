/* PIXELWRECK — UI wiring: load image, build controls, run pipeline, export. */
"use strict";

(() => {
  const MAX_DIM = 1600; // cap working resolution so heavy effects stay snappy

  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");

  let sourceImage = null;   // ImageData of the loaded picture
  let seed = (Math.random() * 0xffffffff) >>> 0;
  let renderQueued = false;

  // ---- effect chain state, built from the registry ----
  const chain = {};
  for (const e of Effects.REGISTRY) {
    chain[e.id] = { enabled: false, params: { ...e.defaults } };
  }
  // sensible starting look: dither on, like ditherboy's landing state
  chain.dither.enabled = true;

  // =====================================================================
  // rendering
  // =====================================================================

  function render() {
    if (!sourceImage || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const out = Effects.apply(sourceImage, chain, seed);
      canvas.width = out.width;
      canvas.height = out.height;
      ctx.putImageData(out, 0, 0);
    });
  }

  function showOriginal(show) {
    if (!sourceImage) return;
    if (show) {
      canvas.width = sourceImage.width;
      canvas.height = sourceImage.height;
      ctx.putImageData(sourceImage, 0, 0);
    } else {
      render();
    }
  }

  // =====================================================================
  // image loading
  // =====================================================================

  function loadFromImageElement(imgEl) {
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
    $("dropzone").hidden = true;
    $("workspace").hidden = false;
    render();
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { loadFromImageElement(img); URL.revokeObjectURL(url); };
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
    c.fillStyle = "#00ffc3";
    c.font = "bold 54px monospace";
    c.textAlign = "center";
    c.fillText("PIXELWRECK", w / 2, h * 0.18);
    loadFromImageElement(off);
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
    // rebuild is cheap and keeps DOM in step with chain state
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
    // always keep at least one effect on
    if (!Effects.REGISTRY.some((e) => chain[e.id].enabled)) {
      chain.slice.enabled = true;
    }
    // huge pixel sizes eat the whole image — keep dither readable
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
      a.download = `pixelwreck-${seed.toString(16)}.png`;
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
      if (item.type.startsWith("image/")) {
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
  $("new-image-btn").addEventListener("click", () => {
    $("workspace").hidden = true;
    $("dropzone").hidden = false;
    $("file-input").value = "";
  });

  const origBtn = $("original-btn");
  origBtn.addEventListener("pointerdown", () => showOriginal(true));
  for (const evName of ["pointerup", "pointerleave", "pointercancel"]) {
    origBtn.addEventListener(evName, () => showOriginal(false));
  }

  buildControls();
})();
