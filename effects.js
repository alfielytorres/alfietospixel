/* PIXELWRECK — effect engine.
 * Every effect takes (ImageData, params, rng) and returns a new ImageData.
 * All randomness goes through the seeded rng so a given seed reproduces
 * the exact same glitch, and "reroll" gives a fresh one.
 */
"use strict";

const Effects = (() => {

  // --- seeded RNG (mulberry32) ---
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clone(img) {
    return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  }

  function luma(d, i) {
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // ======================================================================
  // DITHER — the Ditherboy-style effect: pixelate + palette + dithering
  // ======================================================================

  const PALETTES = {
    "1-bit":      [[10, 10, 15], [232, 232, 240]],
    "paper":      [[26, 22, 18], [242, 233, 215]],
    "gameboy":    [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]],
    "cga":        [[0, 0, 0], [85, 255, 255], [255, 85, 255], [255, 255, 255]],
    "flareware":  [[8, 4, 24], [106, 91, 255], [255, 46, 136], [0, 255, 195], [255, 240, 200]],
    "vaporwave":  [[20, 12, 40], [255, 113, 206], [1, 205, 254], [5, 255, 161], [255, 251, 150]],
    "thermal":    [[0, 0, 32], [64, 0, 128], [220, 40, 40], [255, 160, 20], [255, 255, 200]],
    "grayscale":  [[0,0,0],[36,36,36],[73,73,73],[109,109,109],[146,146,146],[182,182,182],[219,219,219],[255,255,255]],
  };

  const BAYER_4 = [
    [ 0,  8,  2, 10],
    [12,  4, 14,  6],
    [ 3, 11,  1,  9],
    [15,  7, 13,  5],
  ];

  const BAYER_8 = (() => {
    const m = [];
    for (let y = 0; y < 8; y++) {
      m[y] = [];
      for (let x = 0; x < 8; x++) {
        m[y][x] = BAYER_4[y % 4][x % 4] * 4 +
          [[0, 2], [3, 1]][(y >> 2) & 1][(x >> 2) & 1];
      }
    }
    return m;
  })();

  function nearestColor(palette, r, g, b) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) { bestD = d; best = i; }
    }
    return palette[best];
  }

  function dither(img, params) {
    const scale = Math.max(1, Math.round(params.pixelSize));
    const palette = PALETTES[params.palette] || PALETTES["1-bit"];
    const w = Math.max(1, Math.floor(img.width / scale));
    const h = Math.max(1, Math.floor(img.height / scale));

    // downsample by box-averaging
    const small = new Float32Array(w * h * 3);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        const y1 = Math.min(img.height, (y + 1) * scale);
        const x1 = Math.min(img.width, (x + 1) * scale);
        for (let sy = y * scale; sy < y1; sy++) {
          for (let sx = x * scale; sx < x1; sx++) {
            const i = (sy * img.width + sx) * 4;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
        }
        const j = (y * w + x) * 3;
        small[j] = r / n; small[j + 1] = g / n; small[j + 2] = b / n;
      }
    }

    // contrast / brightness pre-adjust
    const con = params.contrast, bri = params.brightness;
    for (let i = 0; i < small.length; i++) {
      small[i] = (small[i] - 128) * con + 128 + bri;
    }

    // quantize with chosen dither algorithm
    const out = new Uint8ClampedArray(w * h * 3);
    const algo = params.algorithm;
    const amt = params.amount;

    if (algo === "bayer4" || algo === "bayer8") {
      const mat = algo === "bayer4" ? BAYER_4 : BAYER_8;
      const size = mat.length, levels = size * size;
      const spread = (255 / palette.length) * 1.5 * amt;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const j = (y * w + x) * 3;
          const t = (mat[y % size][x % size] + 0.5) / levels - 0.5;
          const c = nearestColor(palette,
            small[j] + t * spread, small[j + 1] + t * spread, small[j + 2] + t * spread);
          out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2];
        }
      }
    } else if (algo === "none") {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const j = (y * w + x) * 3;
          const c = nearestColor(palette, small[j], small[j + 1], small[j + 2]);
          out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2];
        }
      }
    } else {
      // Error-diffusion family: floyd | floyd-serp | atkinson.
      // Classic Floyd–Steinberg: quantize Î = nearest(I), e = I − Î, then
      // spread e forward with weights 7/16, 3/16, 5/16, 1/16. Serpentine
      // mode alternates scan direction per row (mirroring the kernel),
      // which breaks up the diagonal worm artifacts of pure raster order.
      const atk = algo === "atkinson";
      const serp = algo === "floyd-serp";
      for (let y = 0; y < h; y++) {
        const rtl = serp && (y & 1) === 1;
        const dir = rtl ? -1 : 1;
        for (let step = 0; step < w; step++) {
          const x = rtl ? w - 1 - step : step;
          const j = (y * w + x) * 3;
          const r = small[j], g = small[j + 1], b = small[j + 2];
          const c = nearestColor(palette, r, g, b);
          out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2];
          const er = (r - c[0]) * amt, eg = (g - c[1]) * amt, eb = (b - c[2]) * amt;
          const push = (dx, dy, f) => {
            const nx = x + dx * dir, ny = y + dy;
            if (nx < 0 || nx >= w || ny >= h) return;
            const k = (ny * w + nx) * 3;
            small[k] += er * f; small[k + 1] += eg * f; small[k + 2] += eb * f;
          };
          if (atk) {
            const f = 1 / 8;
            push(1, 0, f); push(2, 0, f);
            push(-1, 1, f); push(0, 1, f); push(1, 1, f);
            push(0, 2, f);
          } else {
            push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16);
          }
        }
      }
    }

    // upscale back with hard pixels
    const res = new ImageData(img.width, img.height);
    const rd = res.data;
    for (let y = 0; y < img.height; y++) {
      const sy = Math.min(h - 1, Math.floor(y / scale));
      for (let x = 0; x < img.width; x++) {
        const sx = Math.min(w - 1, Math.floor(x / scale));
        const j = (sy * w + sx) * 3;
        const i = (y * img.width + x) * 4;
        rd[i] = out[j]; rd[i + 1] = out[j + 1]; rd[i + 2] = out[j + 2]; rd[i + 3] = 255;
      }
    }
    return res;
  }

  // ======================================================================
  // PIXEL SORT — sort runs of pixels by brightness within a threshold band
  // ======================================================================

  function pixelSort(img, params, rng) {
    const res = clone(img);
    const d = res.data;
    const w = img.width, h = img.height;
    const lo = params.threshold - params.band / 2;
    const hi = params.threshold + params.band / 2;
    const vertical = params.direction === "vertical";
    const lineLen = vertical ? h : w;
    const lineCount = vertical ? w : h;
    const prob = params.coverage;

    const idx = vertical
      ? (line, p) => (p * w + line) * 4
      : (line, p) => (line * w + p) * 4;

    const px = new Array(lineLen);
    for (let line = 0; line < lineCount; line++) {
      if (rng() > prob) continue;
      let runStart = -1;
      for (let p = 0; p <= lineLen; p++) {
        const inBand = p < lineLen && (() => {
          const l = luma(d, idx(line, p));
          return l >= lo && l <= hi;
        })();
        if (inBand && runStart < 0) runStart = p;
        if (!inBand && runStart >= 0) {
          const len = p - runStart;
          if (len > 2) {
            for (let k = 0; k < len; k++) {
              const i = idx(line, runStart + k);
              px[k] = { l: luma(d, i), r: d[i], g: d[i + 1], b: d[i + 2] };
            }
            const run = px.slice(0, len).sort((a, b) => a.l - b.l);
            if (params.reverse) run.reverse();
            for (let k = 0; k < len; k++) {
              const i = idx(line, runStart + k);
              d[i] = run[k].r; d[i + 1] = run[k].g; d[i + 2] = run[k].b;
            }
          }
          runStart = -1;
        }
      }
    }
    return res;
  }

  // ======================================================================
  // RGB SHIFT — chromatic aberration / channel displacement
  // ======================================================================

  function rgbShift(img, params, rng) {
    const res = clone(img);
    const src = img.data, d = res.data;
    const w = img.width, h = img.height;
    const ang = params.angle * Math.PI / 180;
    const amt = params.amount;
    const rdx = Math.round(Math.cos(ang) * amt), rdy = Math.round(Math.sin(ang) * amt);
    const bdx = -rdx, bdy = -rdy;
    const wrap = params.wrap;

    const sample = (x, y, c) => {
      if (wrap) {
        x = ((x % w) + w) % w; y = ((y % h) + h) % h;
      } else {
        x = x < 0 ? 0 : x >= w ? w - 1 : x;
        y = y < 0 ? 0 : y >= h ? h - 1 : y;
      }
      return src[(y * w + x) * 4 + c];
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        d[i] = sample(x + rdx, y + rdy, 0);
        d[i + 2] = sample(x + bdx, y + bdy, 2);
      }
    }
    return res;
  }

  // ======================================================================
  // SLICE GLITCH — horizontal bands ripped sideways, optional channel tear
  // ======================================================================

  function sliceGlitch(img, params, rng) {
    const res = clone(img);
    const src = img.data, d = res.data;
    const w = img.width, h = img.height;
    const count = Math.round(params.slices);
    const maxShift = Math.round(w * params.intensity * 0.35);

    for (let s = 0; s < count; s++) {
      const sy = Math.floor(rng() * h);
      const sh = Math.max(2, Math.floor(rng() * rng() * h * 0.12));
      const shift = Math.round((rng() * 2 - 1) * maxShift);
      const chanTear = params.channelTear && rng() < 0.5;
      const y1 = Math.min(h, sy + sh);
      for (let y = sy; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const tx = ((x - shift) % w + w) % w;
          const i = (y * w + x) * 4, j = (y * w + tx) * 4;
          if (chanTear) {
            d[i] = src[j];             // shifted red
            d[i + 1] = src[i + 1];     // green stays
            d[i + 2] = src[j + 2];
          } else {
            d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2];
          }
        }
      }
    }
    return res;
  }

  // ======================================================================
  // BLOCK CORRUPT — databend-style: blocks copied to wrong places
  // ======================================================================

  function blockCorrupt(img, params, rng) {
    const res = clone(img);
    const src = img.data, d = res.data;
    const w = img.width, h = img.height;
    const count = Math.round(params.blocks);

    for (let n = 0; n < count; n++) {
      const bw = Math.max(4, Math.floor(rng() * w * 0.3));
      const bh = Math.max(4, Math.floor(rng() * h * 0.12));
      const sx = Math.floor(rng() * (w - bw));
      const sy = Math.floor(rng() * (h - bh));
      const dx = Math.floor(rng() * (w - bw));
      const dy = Math.floor(sy + (rng() * 2 - 1) * h * 0.1);
      const ty = Math.max(0, Math.min(h - bh, dy));
      const mode = rng();
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const si = ((sy + y) * w + sx + x) * 4;
          const di = ((ty + y) * w + dx + x) * 4;
          if (mode < 0.6) {          // plain relocate
            d[di] = src[si]; d[di + 1] = src[si + 1]; d[di + 2] = src[si + 2];
          } else if (mode < 0.85) {  // channel-swapped relocate
            d[di] = src[si + 1]; d[di + 1] = src[si + 2]; d[di + 2] = src[si];
          } else {                   // smeared: repeat first column
            const ri = ((sy + y) * w + sx) * 4;
            d[di] = src[ri]; d[di + 1] = src[ri + 1]; d[di + 2] = src[ri + 2];
          }
        }
      }
    }
    return res;
  }

  // ======================================================================
  // WAVE — sinusoidal displacement warping
  // ======================================================================

  function wave(img, params, rng) {
    const res = new ImageData(img.width, img.height);
    const src = img.data, d = res.data;
    const w = img.width, h = img.height;
    const ampX = params.amplitude;
    const freq = params.frequency * 0.05;
    const phase = rng() * Math.PI * 2;
    const vert = params.axis === "vertical" || params.axis === "both";
    const horz = params.axis === "horizontal" || params.axis === "both";

    for (let y = 0; y < h; y++) {
      const dx = horz ? Math.sin(y * freq + phase) * ampX : 0;
      for (let x = 0; x < w; x++) {
        const dy = vert ? Math.sin(x * freq + phase * 1.3) * ampX : 0;
        let sx = Math.round(x + dx), sy = Math.round(y + dy);
        sx = ((sx % w) + w) % w; sy = ((sy % h) + h) % h;
        const i = (y * w + x) * 4, j = (sy * w + sx) * 4;
        d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; d[i + 3] = 255;
      }
    }
    return res;
  }

  // ======================================================================
  // ANAMORPHIC FLARE — horizontal lens streaks from highlights, optional
  // vertical spikes so bright points become four-point stars
  // ======================================================================

  const FLARE_TINTS = {
    "cool blue": [0.45, 0.68, 1.0],
    "cyan":      [0.35, 1.0, 0.92],
    "magenta":   [1.0, 0.4, 0.85],
    "warm":      [1.0, 0.78, 0.45],
    "white":     [1.0, 1.0, 1.0],
  };

  function anamorphicFlare(img, params) {
    const w = img.width, h = img.height;
    const res = clone(img);
    const d = res.data;
    const src = img.data;
    const thr = params.threshold;
    const tint = FLARE_TINTS[params.tint] || FLARE_TINTS["cool blue"];
    const gain = params.gain * 255;

    // highlight pass: how far above the threshold each pixel is (0..1)
    const hl = new Float32Array(w * h);
    const range = Math.max(1, 255 - thr);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      const l = luma(src, i);
      if (l > thr) hl[p] = (l - thr) / range;
    }

    // streak = exponential-decay smear of the highlights, both directions.
    // decay chosen so intensity falls to ~2% at `length` pixels.
    const smear = (buf, lineLen, lineCount, idx, len) => {
      const decay = Math.exp(-4 / Math.max(2, len));
      for (let line = 0; line < lineCount; line++) {
        let acc = 0;
        for (let p = 0; p < lineLen; p++) {
          const k = idx(line, p);
          acc = acc * decay + hl[k];
          if (acc > buf[k]) buf[k] = acc;
        }
        acc = 0;
        for (let p = lineLen - 1; p >= 0; p--) {
          const k = idx(line, p);
          acc = acc * decay + hl[k];
          if (acc > buf[k]) buf[k] = acc;
        }
      }
    };

    const streak = new Float32Array(w * h);
    smear(streak, w, h, (y, x) => y * w + x, params.length);
    if (params.spikes) {
      // vertical spikes are shorter, giving the classic star cross
      smear(streak, h, w, (x, y) => y * w + x, params.length * 0.3);
    }

    // soften vertically (3-tap) and composite additively with tint
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        let s = streak[p] * 0.6;
        if (y > 0) s += streak[p - w] * 0.2;
        if (y < h - 1) s += streak[p + w] * 0.2;
        if (s <= 0.001) continue;
        const i = p * 4;
        const e = s * gain;
        d[i] = clamp255(d[i] + e * tint[0]);
        d[i + 1] = clamp255(d[i + 1] + e * tint[1]);
        d[i + 2] = clamp255(d[i + 2] + e * tint[2]);
      }
    }
    return res;
  }

  // ======================================================================
  // VHS / CRT — scanlines, chroma bleed, noise, jitter, vignette
  // ======================================================================

  function vhs(img, params, rng) {
    const w = img.width, h = img.height;
    const res = new ImageData(w, h);
    const src = img.data, d = res.data;
    const bleed = Math.round(params.bleed);
    const noise = params.noise * 255;
    const scan = params.scanlines;
    const jitterAmt = params.jitter;

    // occasional full-width jitter bands
    const bandCount = Math.floor(jitterAmt * 6);
    const bands = [];
    for (let i = 0; i < bandCount; i++) {
      bands.push({
        y: Math.floor(rng() * h),
        hgt: 2 + Math.floor(rng() * h * 0.03),
        off: Math.round((rng() * 2 - 1) * w * 0.05 * jitterAmt),
      });
    }
    const rowOffset = new Int16Array(h);
    for (const b of bands) {
      for (let y = b.y; y < Math.min(h, b.y + b.hgt); y++) rowOffset[y] = b.off;
    }

    for (let y = 0; y < h; y++) {
      const off = rowOffset[y];
      const scanMul = 1 - (y % 2) * scan;
      for (let x = 0; x < w; x++) {
        const sx = (((x + off) % w) + w) % w;
        const i = (y * w + x) * 4;
        const j = (y * w + sx) * 4;
        // chroma bleed: red pulled from the left, blue from the right
        const jl = (y * w + Math.max(0, sx - bleed)) * 4;
        const jr = (y * w + Math.min(w - 1, sx + bleed)) * 4;
        let r = src[jl], g = src[j + 1], b = src[jr + 2];
        if (noise > 0) {
          const n = (rng() * 2 - 1) * noise;
          r += n; g += n; b += n;
        }
        d[i] = clamp255(r * scanMul);
        d[i + 1] = clamp255(g * scanMul);
        d[i + 2] = clamp255(b * scanMul);
        d[i + 3] = 255;
      }
    }

    // vignette
    if (params.vignette > 0) {
      const cx = w / 2, cy = h / 2;
      const maxD = Math.sqrt(cx * cx + cy * cy);
      const vg = params.vignette;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxD;
          const m = 1 - vg * dist * dist;
          const i = (y * w + x) * 4;
          d[i] *= m; d[i + 1] *= m; d[i + 2] *= m;
        }
      }
    }
    return res;
  }

  // ======================================================================
  // POSTER BURN — posterize + hue rotate + solarize for flareware colors
  // ======================================================================

  function posterBurn(img, params) {
    const res = clone(img);
    const d = res.data;
    const levels = Math.max(2, Math.round(params.levels));
    const step = 255 / (levels - 1);
    const hue = params.hueShift * Math.PI / 180;
    const cosA = Math.cos(hue), sinA = Math.sin(hue);
    // hue rotation matrix (approximate, in RGB space)
    const m = [
      cosA + (1 - cosA) / 3, (1 - cosA) / 3 - sinA * 0.577, (1 - cosA) / 3 + sinA * 0.577,
      (1 - cosA) / 3 + sinA * 0.577, cosA + (1 - cosA) / 3, (1 - cosA) / 3 - sinA * 0.577,
      (1 - cosA) / 3 - sinA * 0.577, (1 - cosA) / 3 + sinA * 0.577, cosA + (1 - cosA) / 3,
    ];
    const sol = params.solarize * 255;

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (hue !== 0) {
        const nr = r * m[0] + g * m[1] + b * m[2];
        const ng = r * m[3] + g * m[4] + b * m[5];
        const nb = r * m[6] + g * m[7] + b * m[8];
        r = nr; g = ng; b = nb;
      }
      if (sol > 0) {
        if (r > 255 - sol) r = 255 - r;
        if (g > 255 - sol) g = 255 - g;
        if (b > 255 - sol) b = 255 - b;
      }
      d[i] = Math.round(clamp255(r) / step) * step;
      d[i + 1] = Math.round(clamp255(g) / step) * step;
      d[i + 2] = Math.round(clamp255(b) / step) * step;
    }
    return res;
  }

  // ======================================================================
  // registry — order here is the pipeline order
  // ======================================================================

  const REGISTRY = [
    {
      id: "posterburn",
      name: "POSTER BURN",
      fn: posterBurn,
      defaults: { levels: 5, hueShift: 0, solarize: 0 },
      params: [
        { key: "levels", label: "color levels", min: 2, max: 16, step: 1 },
        { key: "hueShift", label: "hue shift", min: -180, max: 180, step: 1, unit: "°" },
        { key: "solarize", label: "solarize", min: 0, max: 1, step: 0.01 },
      ],
    },
    {
      id: "dither",
      name: "DITHER",
      fn: dither,
      defaults: { algorithm: "bayer4", palette: "1-bit", pixelSize: 3, amount: 1, contrast: 1, brightness: 0 },
      params: [
        { key: "algorithm", label: "algorithm", type: "select",
          options: [
            ["bayer4", "ordered — bayer 4×4"],
            ["bayer8", "ordered — bayer 8×8"],
            ["floyd", "floyd–steinberg"],
            ["floyd-serp", "floyd–steinberg (serpentine)"],
            ["atkinson", "atkinson"],
            ["none", "hard threshold"],
          ] },
        { key: "palette", label: "palette", type: "select",
          options: Object.keys(PALETTES).map((k) => [k, k]) },
        { key: "pixelSize", label: "pixel size", min: 1, max: 16, step: 1, unit: "px" },
        { key: "amount", label: "dither strength", min: 0, max: 1.5, step: 0.05 },
        { key: "contrast", label: "contrast", min: 0.4, max: 2.5, step: 0.05 },
        { key: "brightness", label: "brightness", min: -100, max: 100, step: 1 },
      ],
    },
    {
      id: "pixelsort",
      name: "PIXEL SORT",
      fn: pixelSort,
      defaults: { threshold: 130, band: 140, coverage: 0.9, direction: "horizontal", reverse: false },
      params: [
        { key: "direction", label: "direction", type: "select",
          options: [["horizontal", "horizontal"], ["vertical", "vertical"]] },
        { key: "threshold", label: "threshold", min: 0, max: 255, step: 1 },
        { key: "band", label: "band width", min: 10, max: 255, step: 1 },
        { key: "coverage", label: "coverage", min: 0, max: 1, step: 0.01 },
        { key: "reverse", label: "reverse order", type: "select",
          options: [[false, "dark → bright"], [true, "bright → dark"]] },
      ],
    },
    {
      id: "rgbshift",
      name: "RGB SHIFT",
      fn: rgbShift,
      defaults: { amount: 6, angle: 0, wrap: true },
      params: [
        { key: "amount", label: "amount", min: 0, max: 60, step: 1, unit: "px" },
        { key: "angle", label: "angle", min: 0, max: 360, step: 1, unit: "°" },
        { key: "wrap", label: "edges", type: "select",
          options: [[true, "wrap around"], [false, "clamp"]] },
      ],
    },
    {
      id: "slice",
      name: "SLICE GLITCH",
      fn: sliceGlitch,
      defaults: { slices: 8, intensity: 0.5, channelTear: true },
      params: [
        { key: "slices", label: "slice count", min: 1, max: 40, step: 1 },
        { key: "intensity", label: "shift intensity", min: 0, max: 1, step: 0.01 },
        { key: "channelTear", label: "channel tear", type: "select",
          options: [[true, "on"], [false, "off"]] },
      ],
    },
    {
      id: "blocks",
      name: "BLOCK CORRUPT",
      fn: blockCorrupt,
      defaults: { blocks: 12 },
      params: [
        { key: "blocks", label: "block count", min: 1, max: 60, step: 1 },
      ],
    },
    {
      id: "wave",
      name: "WAVE WARP",
      fn: wave,
      defaults: { amplitude: 10, frequency: 2, axis: "horizontal" },
      params: [
        { key: "axis", label: "axis", type: "select",
          options: [["horizontal", "horizontal"], ["vertical", "vertical"], ["both", "both"]] },
        { key: "amplitude", label: "amplitude", min: 0, max: 80, step: 1, unit: "px" },
        { key: "frequency", label: "frequency", min: 0.2, max: 20, step: 0.1 },
      ],
    },
    {
      id: "flare",
      name: "ANAMORPHIC FLARE",
      fn: anamorphicFlare,
      defaults: { threshold: 205, length: 160, gain: 1.2, tint: "cool blue", spikes: true },
      params: [
        { key: "threshold", label: "highlight threshold", min: 100, max: 254, step: 1 },
        { key: "length", label: "streak length", min: 10, max: 500, step: 5, unit: "px" },
        { key: "gain", label: "gain", min: 0, max: 3, step: 0.05 },
        { key: "tint", label: "tint", type: "select",
          options: Object.keys(FLARE_TINTS).map((k) => [k, k]) },
        { key: "spikes", label: "star spikes", type: "select",
          options: [[true, "on — 4-point stars"], [false, "off — streaks only"]] },
      ],
    },
    {
      id: "vhs",
      name: "VHS / CRT",
      fn: vhs,
      defaults: { scanlines: 0.35, bleed: 3, noise: 0.08, jitter: 0.5, vignette: 0.35 },
      params: [
        { key: "scanlines", label: "scanlines", min: 0, max: 0.9, step: 0.01 },
        { key: "bleed", label: "chroma bleed", min: 0, max: 20, step: 1, unit: "px" },
        { key: "noise", label: "noise", min: 0, max: 0.5, step: 0.01 },
        { key: "jitter", label: "tracking jitter", min: 0, max: 1, step: 0.01 },
        { key: "vignette", label: "vignette", min: 0, max: 1, step: 0.01 },
      ],
    },
  ];

  function apply(img, chain, seed) {
    let out = img;
    for (const entry of REGISTRY) {
      const state = chain[entry.id];
      if (!state || !state.enabled) continue;
      // per-effect rng: same seed + effect id → stable, but effects independent
      let idHash = 0;
      for (const ch of entry.id) idHash = (idHash * 31 + ch.charCodeAt(0)) | 0;
      const rng = makeRng((seed ^ idHash) >>> 0);
      out = entry.fn(out, state.params, rng);
    }
    return out;
  }

  return { REGISTRY, PALETTES, apply, makeRng };
})();
