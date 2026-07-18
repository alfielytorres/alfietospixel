# VERSIONS EYE — glitch studio

Two ways in: **recorded** — drop an image or a video (max 15 s; the first
10 s are edited) — or **live** — open the camera and run the same effect
chain on the feed in realtime, with an optional recording (video + voice,
max 15 s). Export as **PNG, SVG or MOV**. Everything runs client-side in
the browser (vanilla JS + canvas + WebCodecs) — no build step, no server,
files never leave your machine.

## Live mode

**go live** opens the front camera (with mic permission for voice); the
preview runs through the exact same effects, overlays and looks as files.
**record** captures the processed canvas plus your voice into a clip,
auto-stopping at 15 s (tap again to stop earlier); on phones it hands the
file to the share sheet. **flip camera** switches front/back. Camera
access requires HTTPS.

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

Works as-is on GitHub Pages too.

## Effect chain

Effects toggle on/off and stack top-to-bottom:

| Effect | What it does |
| --- | --- |
| **POSTER BURN** | posterize + hue rotate + solarize |
| **DITHER** | pixelate + palette + ordered (Bayer 4×4/8×8), Floyd–Steinberg (raster or serpentine), Atkinson, or hard threshold |
| **PIXEL SORT** | sorts runs of pixels by brightness inside a threshold band |
| **RGB SHIFT** | chromatic aberration / channel displacement at any angle |
| **SLICE GLITCH** | horizontal bands ripped sideways with optional channel tear |
| **BLOCK CORRUPT** | databend-style blocks copied to the wrong place |
| **WAVE WARP** | sinusoidal displacement warping |
| **VHS / CRT** | scanlines, chroma bleed, noise, tracking jitter, vignette |

### Overlays (02.2)

A separate **OVERLAYS** group sits on top of the filter chain output:

- **ORBS** — a full-frame module (toggle on/off like a filter): a hex or
  square grid of glowing orbs that **distort around the image** — brighter
  areas grow bigger, hotter orbs. In video they **ease toward the picture**
  instead of flickering (animation-speed slider). Glow slider, intensity,
  a **dithered glow style** (Bayer-stippled falloff that matches the dither
  aesthetic; smooth optional), and color mode: image colors or a custom
  picked color (widget + hex).
- **LINES** — full-frame scan lines that **bend around the brightness of
  the image beneath** (distort-by-image slider), with a wide additive glow
  skirt (also dithered or smooth), direction, spacing, thickness, opacity,
  color mode (image / custom), and **balance**: balanced, heavier left/top,
  or heavier right/bottom (skewed).
- **STAR** — added one by one with **+ STAR**, each an anamorphic lens
  star (streak + vertical spike + core) with its own color, and
  **draggable directly on the canvas**.

Overlays render in image mode, live video preview, and all exports.

### Custom colors

The dither palette select includes **custom (your colors)**: pick up to
three colors with the color widgets or type hex codes, and the dithering
engine quantizes the whole image to exactly those colors (the third color
is optional — two-color palettes work too). Built-in palettes: 1-bit,
paper, Game Boy, CGA, flareware, vaporwave, thermal, grayscale.

## Exports

- **PNG** — the canvas as-is (current frame in video mode).
- **SVG** — true vector output: the result is sampled on a coarse grid
  (the dither pixel grid when dithering is on), run-length encoded per
  row, and emitted as one `<path>` per color. Best with dither enabled
  and a small palette; scales to any size with crisp pixel edges.
- **MOV (video)** — offline render: every frame of the 10-second clip is
  seeked, run through the effect chain **at preview resolution — so the
  export looks exactly like the live preview** — then upscaled to
  **1080p or 4K** with hard nearest-neighbor pixels and encoded via
  WebCodecs (H.264) into an MP4/QuickTime container muxed by the vendored
  [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT). Because
  encoding is offline with exact 30 fps timestamps, output is smooth even
  when effects run slower than realtime — no dropped frames. Click the
  button again mid-render to cancel. Browsers without H.264 encode fall
  back to VP9-in-MP4; browsers without WebCodecs fall back to a realtime
  MediaRecorder capture of the preview.

## Video mode

- the preview plays live **through the effect chain** — every change shows
  up immediately on the moving picture before you export
- glitch randomness is re-seeded per frame (deterministically), so slices,
  blocks and jitter animate; the offline export reproduces exactly what
  the preview showed
- play/pause, frame-PNG grab and hold-for-original work during preview
- preview is capped at 960 px for realtime feel; export renders at the
  resolution you pick regardless

## Dithering math

Floyd–Steinberg quantizes each pixel to the nearest palette color
`Î(x,y) = nearest(I(x,y))`, computes the error `e(x,y) = I(x,y) − Î(x,y)`,
and diffuses it to unprocessed neighbors:

```
            x     7/16
3/16  5/16  1/16
```

Serpentine mode alternates scan direction each row (mirroring the kernel)
to break up directional worm artifacts. Ordered modes use Bayer threshold
matrices; Atkinson diffuses 6/8 of the error for a brighter look.

## iPhone files

- **HEIC photos** work everywhere: Safari decodes them natively, and other
  browsers fall back to the vendored [libheif](https://github.com/strukturag/libheif)
  WASM decoder (lazy-loaded only when a HEIC file arrives). Files with a
  missing/odd MIME type are sniffed by extension too.
- **HEVC (H.265) videos** decode wherever the browser/hardware supports
  them (Safari, most modern devices). Where they can't, the app now shows
  a clear explanation (with the iPhone "Most Compatible" camera setting
  tip) instead of a silent black canvas.

## Phones

The mobile layout is app-like (VSCO-style): the preview sticks to the top,
a horizontally scrolling **chip bar** lists every tool, and tapping a chip
opens that tool's controls in a **bottom sheet** — no scrolling through a
long panel. Touch targets and sliders are enlarged on touch screens.

The studio is also a **PWA**: open it in the browser, choose "Add to Home
Screen", and it installs with the versions icon and works offline (the app
shell is pre-cached by a service worker; the HEIC decoder caches on first
use).

On iPhone and Android, exports open the **native share sheet** (Web Share
API) instead of a plain download, so results can go straight to Photos,
AirDrop, or socials. If the share prompt can't fire after a long render
(the tap "expired"), the button switches to **TAP TO SHARE** — one more
tap opens the sheet. Desktop browsers keep normal downloads.

## Extras

- **reroll seed** — same settings, new random glitch (all randomness is seeded)
- **randomize all** — rolls a whole new effect chain (including random custom colors)
- **sticky preview** — the canvas stays in view while you scroll the
  effect chain, so tweaking never means scrolling back up
- **hold for original** — flip back to the source
- paste from clipboard or drag-and-drop to load
- demo pattern built in if you have no image handy
