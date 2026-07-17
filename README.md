# PIXELWRECK — glitch art generator

Drop an image in, wreck it, download the result. Everything runs client-side
in the browser (vanilla JS + canvas) — no build step, no server, images never
leave your machine.

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
| **POSTER BURN** | posterize + hue rotate + solarize for flareware-style color |
| **DITHER** | ditherboy-style: pixelate + retro palette + ordered (Bayer 4×4/8×8), Floyd–Steinberg (raster or serpentine), Atkinson, or hard threshold |
| **PIXEL SORT** | sorts runs of pixels by brightness inside a threshold band |
| **RGB SHIFT** | chromatic aberration / channel displacement at any angle |
| **SLICE GLITCH** | horizontal bands ripped sideways with optional channel tear |
| **BLOCK CORRUPT** | databend-style blocks copied to the wrong place |
| **WAVE WARP** | sinusoidal displacement warping |
| **VHS / CRT** | scanlines, chroma bleed, noise, tracking jitter, vignette |

Palettes include 1-bit, Game Boy, CGA, flareware, vaporwave, thermal, and
8-level grayscale.

## Dithering math

The Floyd–Steinberg mode quantizes each pixel to the nearest palette color
`Î(x,y) = nearest(I(x,y))`, computes the quantization error
`e(x,y) = I(x,y) − Î(x,y)`, and diffuses it to unprocessed neighbors:

```
            x     7/16
3/16  5/16  1/16
```

Serpentine mode alternates scan direction each row (mirroring the kernel) to
break up directional worm artifacts. Ordered modes use Bayer threshold
matrices; Atkinson diffuses 6/8 of the error for a brighter, punchier look.

## Extras

- **reroll seed** — same settings, new random glitch (all randomness is seeded)
- **randomize all** — rolls a whole new effect chain
- **hold for original** — flip back to the source image
- paste from clipboard or drag-and-drop to load
- demo pattern built in if you have no image handy
