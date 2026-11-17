# Toolify: Implementation Plan

A private, local-first web toolbox. Every file is processed on the user's device (WASM, Web Workers, WebCodecs, WebGPU/WebGL, OffscreenCanvas). There are no uploads, no telemetry and no runtime third-party requests.

> Status: **plan only**, no feature code yet. Research date: 2026-11-17. Versions were checked against the npm registry on that date. Items marked ⚠ are unverified and must be confirmed by the Phase 0 spikes.
>
> **Current focus (2026-11-17): image tools.** The first release is the lean foundation (Phase 0) plus the converter, optimizer and resizer (Phase 1, detailed in §1b). Markdown, the keyboard tester, PDF/Word and video are **parked** (§7, "Later"). Their research stays in this document so nothing has to be redone.

---

## 0. Starting point

| Item | State |
|---|---|
| Scaffold | Fresh Nuxt **4.6.4**, Vue 3.5, vue-router 5. `app/app.vue` shows `<NuxtWelcome/>`. Default `nuxt.config.ts`. No modules, no commits. |
| Runtime | Node 26.13, npm 12.2 |
| Implication | Everything below is greenfield. Keep the Nuxt 4 `app/` srcDir layout. |

---

## 1. Key decisions (summary)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | UI kit | **Nuxt UI 4.12.2** (MIT) on Tailwind CSS 4.3 + Reka UI 2.11. Decided by the user 2026-11-17, replacing PrimeVue. | MIT with no licence key (PrimeVue 5 moved to a keyed "PrimeUI License"). Built for Nuxt 4 (`@nuxt/kit ^4.6`), peer TS `^7` OK. Accessible Reka primitives. Has Dashboard/Page layouts, FileUpload, Splitter, Kbd, CommandPalette, Empty. |
| D2 | Rendering | `nuxt generate` (SSG): prerender every route from the tool registry. Tool workspaces are `<ClientOnly>` / `.client.vue`. | Static output with real `<title>`/meta per tool for SEO. Nitro runs at build time only. |
| D3 | Server | **No runtime server.** A static host that can set headers (Cloudflare Pages or Netlify `_headers`). | The only server-side need is response headers, and the host file handles that. |
| D4 | Isolation | Site-wide `COOP: same-origin` + `COEP: require-corp`. The app also **works without** isolation through single-thread fallbacks. | Everything is same-origin, so `require-corp` costs nothing. Safari lacks `credentialless`. Isolation unlocks threaded WASM (avif-mt, ffmpeg-mt). |
| D5 | Video engine | **Mediabunny 1.66 (MPL-2.0) + WebCodecs** primary. ffmpeg.wasm 0.12 as a lazy, opt-in "compatibility pack". | Hardware encode, streaming I/O, tiny bundle. ffmpeg is GPL, ~30 MB, and the whole file sits in memory. |
| D6 | Image engine | Native fast path (`createImageBitmap` + `OffscreenCanvas.convertToBlob`), with **jSquash** WASM codecs as the quality/fallback path, **pica** for high-quality resize, and hand-rolled BMP/ICO writers. | Smallest load, best quality, runtime-probed. |
| D7 | Word↔PDF | Tier 1 in-browser heuristics (mammoth/docx-preview → print; pdf.js → `docx`). Tier 2 LibreOffice-WASM (ZetaOffice) is a time-boxed **spike**, opt-in and desktop-only. | Honest fidelity. LibreOffice WASM is huge (≥100 MB ⚠) and still beta. |
| D8 | Markdown | markdown-it + DOMPurify + Shiki (fine-grained, JS regex engine) + CodeMirror 6 | GFM plugins, safe output, no extra WASM. |
| D9 | Workers | Comlink 4.4.2 + an in-house job queue with priorities, cancel and progress | Tiny, typed RPC. The queue adds what Comlink lacks. |
| D10 | PWA | @vite-pwa/nuxt 2.0.1 (generateSW). Precache the shell; WASM is cached CacheFirst at runtime on first use. | Offline after the first use of each tool. |
| D11 | Icons/fonts | `@nuxt/icon` (bundled with Nuxt UI) in **client-bundle-only** mode with a local `@iconify-json/lucide`, and no Iconify API fallback. Disable `@nuxt/fonts` (`ui.fonts: false`) and use `@fontsource-variable/inter`. | Nuxt UI's defaults fetch icons from the Iconify API or a server endpoint, and fonts from providers at build time. Both would break "no runtime third-party calls" or a static host. |

---

## 1b. Image tools: detailed spec (current focus)

### 1b.1 One shared engine, three tools

All three tools share **one image worker** (pooled, `clamp(cores-1,1,4)`; 1 when an input is over 24 MP on a phone) and one pipeline:

```
File ─▶ probe (sniff magic bytes, dims, alpha, animation, EXIF/GPS, colour space)
     ─▶ decode  → ImageBitmap | ImageData | Frame[]   (native first, WASM fallback)
     ─▶ ops[]   → resize? · flatten(bg)? · pad/crop? · square(ICO)?
     ─▶ encode  → Blob (+ chosen path, timings)
     ─▶ result  → size in/out, dims, warnings[]
```

```ts
type ImageFormat = 'jpeg'|'png'|'webp'|'avif'|'gif'|'bmp'|'ico'
interface ImageJobInput { file: File; ops: ImageOp[]; output: EncodeOptions; guard: { maxPixels: number } }
type ImageOp =
  | { kind: 'resize'; width: number; height: number; fit: 'contain'|'cover'|'fill'|'pad'; quality: 'fast'|'high'; sharpen?: number; noUpscale: boolean; bg?: string }
  | { kind: 'flatten'; bg: string }               // auto-added when alpha → JPEG/BMP
interface EncodeOptions { format: ImageFormat | 'same'; quality?: number; lossless?: boolean; effort?: number;
  targetBytes?: number; preferWasm?: boolean; png?: { quantize?: number /*colours*/; oxipngLevel?: number };
  ico?: { sizes: number[] }; gif?: { colours: number; dither: boolean } }
interface ImageJobResult { blob: Blob; format: ImageFormat; width: number; height: number;
  bytesIn: number; bytesOut: number; path: 'native'|'wasm'|'wasm-mt'; ms: number; warnings: string[] }
```

Engine modules live in `app/tools/_image-engine/` (`probe.ts`, `decode.ts`, `ops.ts`, `encoders/*.ts`, `worker.ts`, `resolvePath.ts`). Each encoder is a **separate dynamic import**, so choosing WebP never downloads AVIF.

### 1b.2 Format matrix

| Format | Decode (native → fallback) | Encode (default path → alt) | Options exposed |
|---|---|---|---|
| JPEG | native | Converter: native `convertToBlob`. Optimizer: **MozJPEG** (@jsquash/jpeg). | quality 1–100 (def 80), progressive (MozJPEG), chroma 4:2:0/4:4:4 |
| PNG | native | native → **oxipng** (lossless, levels 1–6, def 2). Lossy PNG via palette quantisation (**image-q** 4.0, MIT) | lossless level, "reduce colours" 2–256 + dither |
| WebP | native → @jsquash/webp | native (probe `blob.type`) → **@jsquash/webp** | quality, lossless toggle, effort 0–6 |
| AVIF | native (Chrome 85+, Safari 16.4+, FF 93+) → @jsquash/avif | **@jsquash/avif** only (mt build when `crossOriginIsolated`) | quality, speed 0–10 (def 6), lossless |
| GIF | native first frame; animated via `ImageDecoder` → **modern-gif** decode | **modern-gif** 2.1 | colours 2–256, dither, keep animation |
| BMP | native | hand-rolled 24-bit (32-bit if alpha) | none |
| ICO | **icojs** 1.0.1 (largest entry) | hand-rolled PNG-in-ICO | sizes ☑16 ☑32 ☑48 ☐64 ☐128 ☑256, square mode (pad/crop) |
| HEIC/HEIF (input only) | native (Safari) → **libheif-js** lazy chunk (Q2) | n/a | n/a |
| TIFF, SVG, JXL, animated WebP/APNG output | n/a | **out of scope v1** | n/a |

Rules:
- Alpha → JPEG/BMP flattens on a background colour (default white, user-selectable) and adds a warning.
- Animated input → static format uses the first frame, with a warning. GIF→GIF keeps all frames.
- Output is always sRGB 8-bit. Wide-gamut or 16-bit input gets a "colours may shift slightly" warning.
- **Metadata stripped by default.** Probe reads EXIF with **exifr** 7.1.3 (lite) and flags GPS ("This photo contains a location, which will be removed"). An optional "Keep EXIF" (JPEG→JPEG only) splices the APP1 segment back, with Orientation reset to 1. That option ships in 1d.

### 1b.3 Tool specs

**Image Converter** (`/tools/image-convert`)
- **Input:** any decodable format, multi-file, folder drop (Chromium `webkitGetAsEntry`), paste.
- **Options:** target format (big `UTabs`: JPG · PNG · WebP · AVIF · GIF · BMP · ICO), plus a contextual quality slider and format-specific options in a collapsible panel. "Smaller files (slower)" makes it prefer the WASM encoders. Background colour appears only when needed.
- **Output:**
  - Default name is `{name}.{ext}`; collisions get `-1`.
  - Per-file download/share.
  - "Download all" builds a **zip via client-zip** 2.5.1 (streaming, store-only, MIT). On Chromium, "Save to folder…" uses `showDirectoryPicker`.
- **Extras:** an "Optimize these" / "Resize these" hand-off passes results in memory to the next tool, with no re-drop.

**Image Optimizer** (`/tools/image-optimize`)
- **Modes** (`UTabs`):
  - **Smart** (default): keeps the format, uses the WASM encoder at a tuned quality (JPEG 78, WebP 75, AVIF 55), and strips metadata.
  - **Lossless:** PNG→oxipng, WebP→lossless, JPEG→metadata strip only. True lossless JPEG recompression is not available in jSquash; say so in the UI.
  - **Target size:** "under N KB". Binary search on quality, at most 7 encodes, with the best attempt reported.
  - **Custom:** quality slider plus format switch.
- **Never bigger:** if output ≥ input, keep the original and label it "Already optimized".
- **Compare:** the `BeforeAfter` slider with 1:1 zoom and pan, plus a `UModal` fullscreen view. Shows per-file savings % and a total ("Saved 18.4 MB, −63 %").
- **Hint:** "Converting to AVIF would save ~X % more", from a quick estimate on a 256 px thumbnail. It is a hint, not an action.

**Image Resizer** (`/tools/image-resize`)
- **Size modes:** width × height (aspect lock 🔗 default on), percentage, longest edge, exact (with fit).
- **Fit:** contain / cover (centre crop) / stretch / pad (bg colour). A "don't enlarge" toggle is on by default.
- **Presets** (`USelectMenu`, grouped):
  - Social: IG square 1080², IG portrait 1080×1350, Story 1080×1920, X header 1500×500, YouTube thumb 1280×720, LinkedIn banner 1584×396.
  - Screen: HD, Full HD, 4K.
  - Web: 800w email, 1200w blog, 512 icon.
  - Plus user-saved custom presets (persisted).
- **Quality:** **High** (default) is **pica** 10 Lanczos3 + optional unsharp (amount 0–100). **Fast** is native `createImageBitmap({resizeWidth, resizeQuality:'high'})`.
- **Large downscales:** when the image shrinks more than 2×, `createImageBitmap` pre-shrinks it to 2× the target, then pica runs. This keeps memory and time down on phones.
- **Output:** same format as input by default, with an optional format/quality override. Name is `{name}-{w}x{h}.{ext}`.

### 1b.4 Shared batch UX
- Each file is a `JobRow` showing thumbnail (256 px, decoded once), name, dims in→out, size in→out, `UProgress`, path badge, warnings (`UTooltip`) and actions.
- Options apply to the whole batch. A per-file override comes in 1d.
- Changing options after a run marks results stale. A "Re-run" button appears; there is no auto re-run on big batches.
- Mobile: a sticky bottom bar with the primary action and "Download all". Options sit in a `UDrawer` sheet.
- Options persist per tool (Pinia). "Reset to defaults" is available.
- **Samples:** three bundled sample images (a photo, a transparent PNG and an animated GIF) let users try a tool without their own files.

### 1b.5 Memory and performance guards
- `estBytes = w*h*4 × (1 decode + 1 working + encoder factor)`.
- Inputs over 100 MP are refused. On phones, inputs over 50 MP get a warning and are pre-shrunk if resizing.
- Batches run with concurrency `min(pool, floor(budget/estBytes))`.
- `ImageBitmap.close()` is called right after use. Results are held as Blobs (disk-backed when large) and released after download or zip.
- OOM (`RangeError` or a worker crash) gives a per-file error "Too large for this device; try Resize first". The batch continues.

### 1b.6 Image library additions (beyond §2.2)

| Package | Version | Licence | Role |
|---|---|---|---|
| client-zip | 2.5.1 | MIT | Streaming zip for "Download all" |
| image-q | 4.0.0 | MIT | Palette quantisation (lossy PNG, GIF). Stale since 2022 but pure JS. ⚠ Compare quality with libimagequant-wasm 0.5.0, whose "MIT" label conflicts with upstream libimagequant (GPL-3 since 2.12). Do not adopt that one until its licence is confirmed. |
| exifr | 7.1.3 | MIT | EXIF/GPS read for warnings (lite bundle). Stale but stable. |
| icojs | 1.0.1 | MIT | ICO input parsing |

---

## 2. Library choices per tool

### 2.1 Platform

| Package | Version | Licence | Role |
|---|---|---|---|
| nuxt | 4.6.4 | MIT | Framework, SSG |
| @nuxt/ui | 4.12.2 | MIT | UI components, theming via `app.config.ts` + Tailwind `@theme` (D1) |
| tailwindcss (via Nuxt UI) | 4.3.5 | MIT | Utility CSS, compiled at build time |
| @nuxtjs/color-mode (via Nuxt UI) | 4.1.0 | MIT | light/dark/system, no-flash script |
| @nuxt/icon (via Nuxt UI) + @iconify-json/lucide | 2.6.2 / 1.2.156 | MIT / ISC | Icons, client bundle only |
| pinia / @pinia/nuxt | 4.1.0 / 1.0.3 | MIT | State |
| pinia-plugin-persistedstate | 4.7.1 | MIT | Persist settings. Register via our own Nuxt plugin; **not** `@pinia-plugin-persistedstate/nuxt`, whose peer is `@pinia/nuxt ^0.5`. |
| @vueuse/core / @vueuse/nuxt | 14.x (match Nuxt UI's `^14.4`; 15.0 is out ⚠ check dedupe) | MIT | `useDropZone`, `useMediaQuery`, `useEventListener` |
| @vite-pwa/nuxt | 2.0.1 | MIT | SW and manifest. Depends on `@nuxt/kit ^4.6.4`. |
| comlink | 4.4.2 | Apache-2.0 | Worker RPC. Last release 2024-11; stable, low-churn. |
| @fontsource-variable/inter | 5.3.0 | OFL-1.1 | Self-hosted font (`ui.fonts: false`) |
| nuxt-security | 2.7.0 | MIT | Optional: build-time CSP hash generation (or our own post-build script) |

### 2.2 Images (converter, optimizer, resizer)

| Need | Fast path | Quality / fallback | Licence | Lazy WASM (est. ⚠) |
|---|---|---|---|---|
| Decode JPG/PNG/WebP/AVIF/GIF/BMP | `createImageBitmap` (EXIF orientation applied) | jSquash decoders | Apache-2.0 | 0–1 MB |
| Animated GIF/WebP decode | `ImageDecoder` (Chromium, Firefox 133+) | modern-gif 2.1.0 decoder | MIT | 0 |
| HEIC input | Native `createImageBitmap` (Safari) | **libheif-js 1.23.5**, separate chunk | **LGPL-3.0** + HEVC patents | ~1.5–3 MB |
| Encode JPEG | `convertToBlob('image/jpeg', q)` | **@jsquash/jpeg 1.6.0** (MozJPEG) | Apache-2.0 | ~0.3 MB |
| Encode PNG / lossless | `convertToBlob('image/png')` | **@jsquash/png 3.1.1** + **@jsquash/oxipng 2.3.0** | Apache-2.0 | ~0.4 MB |
| Encode WebP | `convertToBlob('image/webp')` (probe `blob.type`) | **@jsquash/webp 1.5.0** (lossy + lossless) | Apache-2.0 | ~0.5 MB |
| Encode AVIF | none (not reliable natively) | **@jsquash/avif 2.1.1**, mt build when isolated | Apache-2.0 | ~3–4 MB |
| Encode GIF | none | **modern-gif 2.1.0** (maintained) over gifenc (stale since 2022) | MIT | 0 (JS) |
| Encode BMP / ICO | none | Hand-rolled writers: BMP header + BGRA; ICO wraps PNGs, multi-size | n/a | 0 |
| Resize | `createImageBitmap({resizeWidth, resizeQuality:'high'})` ("Fast") | **pica 10.0.3**: Lanczos, tiled, unsharp; worker features `['js','wasm']` ("High quality", default) | MIT | ~0.1 MB |

Rejected:
- heic2any: abandoned since 2023.
- heic-to: LGPL, 26 MB; libheif-js is leaner.
- gif.js: stale.
- wasm-vips: 13 MB.
- @jsquash/jxl and qoi: not in scope.
- WebGPU resize: pica is enough. Revisit only if profiling shows a need.

Notes:
- Re-encoding strips EXIF/XMP/ICC by default, which is a privacy win. Show this in the UI.
- Wide-gamut (P3) images shift to sRGB. Warn the user.
- Animated input in a static-format conversion uses the first frame, with a warning. GIF→GIF and WebP→GIF keep frames.
- jSquash: avoid nested-worker builds (jSquash #19). Init with explicit self-hosted WASM URLs.

### 2.3 Word ↔ PDF

| Direction | Tier 1 (default, ~1–3 MB) | Libraries | Tier 2 (spike, opt-in) |
|---|---|---|---|
| DOCX → PDF | docx-preview renders to paginated DOM in an isolated print iframe. **Print / Save as PDF** gives selectable text and the best fidelity. **Quick download PDF**: mammoth → sanitized HTML → pdfmake (real text, bundled Inter + Noto subsets). | docx-preview 0.4.1 (Apache-2.0), mammoth 1.13.0 (BSD-2), pdfmake 0.3.14 (MIT), dompurify 3.4.18 | ZetaOffice / zetajs 1.2.0 (MIT wrapper, LibreOffice MPL-2.0) headless `convertpdf` |
| PDF → DOCX | pdf.js `getTextContent` items → lines → paragraphs (y-gaps), heading inference from font size/weight, list detection, image extraction → `docx` writer. Option **"Page images"** puts one image per page into the DOCX (visually exact, not editable). Optional **OCR pack** for scanned PDFs. | pdfjs-dist 6.5.438 (Apache-2.0), docx 9.15.4 (MIT), tesseract.js 7.0.0 (Apache-2.0, self-hosted core + `eng` data) | LibreOffice Draw import (still lossy) |

Rejected:
- **mupdf** (AGPL-3.0) unless the project goes AGPL.
- jsPDF `html()`: it rasterises.
- pdf-lib 1.17.1: stale since 2022. Use `@cantoo/pdf-lib` 2.11.1 if PDF editing is ever needed; not needed in v1.

#### Honest fidelity limits

| Feature | DOCX→PDF T1 | PDF→DOCX T1 | T2 (LibreOffice) |
|---|---|---|---|
| Text, headings, bold/italic, lists | ✅ Good | 🟡 Good for simple docs | ✅ |
| Simple tables | ✅ | 🟡 Heuristic (ruled tables OK, borderless poor) | ✅ |
| Inline images | ✅ | ✅ | ✅ |
| Page size, margins, headers/footers | 🟡 docx-preview approximates | ❌ (headers become body text) | ✅ |
| Multi-column, text boxes, floating shapes, SmartArt, charts | ❌ / 🟡 | ❌ | 🟡 |
| Exact line breaks / font metrics | 🟡 Font substitution (no MS fonts) | n/a | 🟡 Needs bundled fonts |
| Tracked changes, comments, fields/TOC | ❌ | ❌ | 🟡 |
| Scanned PDF | n/a | ❌ unless OCR pack | ❌ unless OCR |
| RTL / CJK | 🟡 Needs Noto subsets | 🟡 | 🟡 |

UI copy: label PDF→Word as **"extracts text and structure"** and show a per-file fidelity note ("3 floating objects were not converted").

**Tier 2 go/no-go (spike in Later B):**
- Measure the download size (gzip/br), peak memory, cold-start time and whether isolation is required.
- **Go** only if it is under 150 MB transferred, under 1.5 GB peak, and works in desktop Chrome and Firefox.
- Otherwise drop it from v1.

### 2.4 Markdown

| Role | Choice | Version | Licence | Notes |
|---|---|---|---|---|
| Parser | markdown-it | 15.0.3 | MIT | GFM tables/strikethrough built in. Task lists via a small in-repo plugin (markdown-it-task-lists is stale since 2022), plus footnote and anchor plugins. |
| Sanitiser | DOMPurify | 3.4.18 | MPL-2.0/Apache-2.0 | Mandatory on every render |
| Highlighting | Shiki | 4.6.0 | MIT | `shiki/core` + JS regex engine, ~20 curated languages lazy-loaded, dual light/dark themes |
| Editor | CodeMirror 6 (`@codemirror/view` 6.43, `lang-markdown` 6.5.2) | 6.x | MIT | Lazy chunk. Toolbar for mobile. |
| Export | MD (Blob), standalone HTML (inlined CSS + Shiki colours), PDF via print view | n/a | n/a | `@page` CSS. No PDF lib needed. |

Rendering is debounced (150 ms). Parsing and highlighting move to a worker only if a 1 MB doc janks (measure first).

### 2.5 Video (editor + optimizer)

| Path | Engine | Licence | Size | Needs isolation | Used for |
|---|---|---|---|---|---|
| **Primary** | Mediabunny 1.66.0 + WebCodecs (+ `@mediabunny/aac-encoder` 1.66.0 when AAC encode is missing, e.g. Firefox) | MPL-2.0 | Tree-shaken, tens of KB | No | Everything below whenever `canDecode`/`canEncode` pass |
| **Compat pack** | @ffmpeg/ffmpeg 0.12.15 + core 0.12.10 (st), or core-mt when `crossOriginIsolated` | MIT wrapper / **GPL-2.0+ core** | ~30 MB WASM | mt only | AVI/FLV/WMV/exotic codecs, browsers without WebCodecs (Firefox Android), missing encoders |

| Operation | Implementation (primary path) |
|---|---|
| Trim | `Conversion` `trim`. Offer a keyframe-aligned "fast trim" (packet copy, no re-encode) or a frame-accurate trim (re-encode). |
| Cut (remove middle) | Two segments → merge pipeline |
| Crop / rotate / flip / resize | `Conversion` `video.crop/rotate/width/height/fit`. Custom transforms use `VideoSample` → OffscreenCanvas (WebGL2) → `CanvasSource`. |
| Mute / replace audio | Discard the audio track / add a decoded `AudioBufferSource` (trim or loop to video length) |
| Merge clips | Single `Output`. Normalise resolution/fps on canvas, offset timestamps per clip, re-encode if codecs differ. |
| Optimise | Presets (Web 1080p, Mobile 720p, Tiny, Custom): codec (H.264/VP9/AV1/HEVC as probed), bitrate/CRF-like quality, resolution, fps, container MP4/WebM/MKV/MOV |
| Preview | `<video>` on an object URL for playback. `CanvasSink` thumbnails for the filmstrip. Range `Slider` for the trim handles. |
| I/O | Read lazily from `File`. Write via `StreamTarget` to an OPFS sync handle in the worker, then `showSaveFilePicker` or `<a download>`. |

Pitfalls to handle:
- MP4 `fastStart` vs streaming targets.
- VFR input.
- Rotation metadata order (crop after rotate).
- Progress reaching 1 is not completion.
- HEVC/AV1 encode is patchy.
- iOS memory and background-tab suspension: warn the user, use Wake Lock while encoding.

### 2.6 Keyboard tester

No dependencies. Layouts are data keyed by `KeyboardEvent.code`:

```ts
interface KeyDef { c: string; l: string; w?: number; h?: number; s?: string; g?: 'f'|'nav'|'arrows'|'num' }
type Item = KeyDef | number                // number = horizontal gap (u)
interface Row { dy?: number; items: Item[] }
interface Layout { id: string; name: string; rows: Row[]; clusters?: Record<string, Row[]> }
```

- **Layouts.** ANSI-104 and ISO-105 are defined once. TKL, 75% and 60% are derived by filtering cluster tags (`g`). ISO adds `IntlBackslash`, uses a 1.25u LShift and a tall Enter (`h:2`).
- **Labels.** Use `navigator.keyboard.getLayoutMap()` on Chromium for localised keycaps. Fall back to static labels.
- **Features:**
  - Live highlight, plus a "tested" heatmap.
  - Event log showing `key`/`code`/`location`/`repeat`/modifiers.
  - **Rollover meter**: max simultaneous keys held.
  - **Ghosting test**: guided combos, report missing keys.
  - **Stuck/chatter detection**: keydown without keyup for over 3 s; repeat bursts under 30 ms.
  - Reset on `blur`/`visibilitychange`.
- Capture uses `preventDefault` for Tab, Space, F-keys and the like while the tester has focus, with a visible "capturing" toggle. OS-reserved combos can't be captured; say so in the UI.
- **Mobile fallback:** soft keyboards emit `key:'Unidentified'`/`keyCode 229`. Show an input-event/text-mode tester and a hint to connect a hardware keyboard, which gives the full mode.

---

## 3. Architecture

### 3.1 Folder structure (Nuxt 4 `app/` srcDir)

```
app/
  app.vue                     # <UApp> (toasts, tooltips, overlays) + SW update prompt
  app.config.ts               # ui.colors (primary/neutral) + component slot/variant overrides
  layouts/default.vue         # UDashboardGroup/Sidebar (desktop) / bottom nav + UDrawer (mobile)
  pages/
    index.vue                 # dashboard: search + categories + tool cards
    tools/[slug].vue          # resolves registry entry → lazy tool module
    settings.vue  about.vue  licenses.vue  privacy.vue
  components/
    shell/  (AppTopBar, AppBottomNav, AppDrawer, PrivacyBadge, CapabilityBadge, ThemeToggle)
    tool/   (ToolLayout, DropZone, FileList, JobRow, OptionsPanel, OutputPanel, BeforeAfter, EmptyState, ErrorState)
  composables/
    useCapabilities.ts        # one-time probe → reactive caps
    useFileInput.ts           # drop/paste/picker/share-target → FileRef[]
    useFileOutput.ts          # save (FS Access) / download / zip batch / share
    useJob.ts                 # submit + track a job from a component
    useOpfs.ts                # temp files, cleanup on boot
  stores/  settings.ts jobs.ts capabilities.ts  (+ per-tool stores inside tool modules; theme = useColorMode)
  tools/                      # self-contained tool modules
    registry.ts               # metadata only (no heavy imports)
    image-convert/  { meta.ts, Tool.vue, store.ts, worker.ts, engines/*.ts, tests/ }
    image-optimize/ image-resize/ docx-to-pdf/ pdf-to-docx/ markdown/ video-edit/ video-optimize/ keyboard-test/
  workers/
    pool.ts  queue.ts  rpc.ts  types.ts   # shared job infrastructure
  lib/        # pure utilities (bmp.ts, ico.ts, bytes.ts, mime.ts, zip.ts using CompressionStream/fflate)
  assets/css/ main.css        # @import "tailwindcss"; @import "@nuxt/ui"; @theme tokens; Inter
public/
  _headers  manifest icons
scripts/      postgenerate.mjs (CSP hashes → _headers)  check-no-external.mjs  serve.mjs  gen-pwa-icons.mjs  gen-licenses.mjs
tests/        unit/  e2e/  fixtures/
```

### 3.2 Tool registry

```ts
// app/tools/registry.ts: imported by dashboard & router; must stay tiny
export interface ToolMeta {
  slug: string; title: string; description: string
  category: 'image' | 'document' | 'video' | 'utility'
  icon: string; keywords: string[]
  accepts?: string[]            // MIME/extensions for DropZone + share target
  requires?: CapabilityKey[]    // hard requirements → "unsupported" state
  heavyAssets?: { label: string; approxMB: number }[]  // shown before first download
  load: () => Promise<{ default: Component }>          // () => import('./image-convert/Tool.vue')
}
```

- `pages/tools/[slug].vue` renders `defineAsyncComponent(meta.load)` inside `<ClientOnly>`, with a skeleton.
- `nitro.prerender.routes` is generated from the registry.
- The heavy libraries are imported only inside each tool's `worker.ts` / `engines/`, so the route chunk stays small and codecs load on demand per output format.

### 3.3 Worker and job layer

```ts
type Priority = 'interactive' | 'batch'
type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
interface JobSpec<I> { tool: string; kind: string; input: I; priority?: Priority; transfer?: Transferable[]; estBytes?: number }
interface JobProgress { ratio: number; phase?: string; etaMs?: number }
interface ToolWorkerApi<I, O> {
  init(caps: Capabilities, assets: AssetUrls): Promise<void>
  run(jobId: string, input: I, onProgress: (p: JobProgress) => void): Promise<O>
  cancel(jobId: string): Promise<void>      // cooperative
}
```

- **Pool.**
  - One lazily created pool per tool kind.
  - Size is `clamp(hardwareConcurrency - 1, 1, 4)`; it is 1 for video/ffmpeg/LibreOffice, and 1 when `deviceMemory <= 4` or on iOS.
  - Idle workers are terminated after 60 s to free WASM memory.
- **Queue.**
  - Priority FIFO in the `jobs` store (metadata only).
  - The heavy `File`/`Blob`/result data lives in a non-reactive `Map` keyed by job id.
  - Batch results are released after they are saved or zipped.
- **Cancel.** Cancellation comes from an `AbortSignal`:
  - A queued job is removed.
  - A running job gets `api.cancel()` (Mediabunny `conversion.cancel()`).
  - If there is no acknowledgement within 500 ms, or the engine is non-interruptible WASM, the queue calls `worker.terminate()` and respawns.
- **Data transfer.**
  - `File` objects are passed by structured clone; they are disk-backed, so nothing is copied.
  - `ArrayBuffer`/`ImageBitmap`/`VideoFrame` are always moved via `Comlink.transfer`.
  - Large outputs go to OPFS (`createSyncAccessHandle` in the worker) and come back as a `File` handle.
  - Temp OPFS files are deleted on job end and swept on boot.
- **Memory guard.**
  - Each job has an `estBytes` (for images, `w*h*4*k`). The budget is roughly `min(deviceMemory*128MB, 1GB)`, with about 256 MB on iOS.
  - Over budget: run sequentially, downscale on decode (resizer), or refuse with guidance.
  - Catch `RangeError`/OOM and surface "file too large for this device".
- **Bundling.**
  - Workers are created with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, client-only.
  - **WASM (spike 0c result):** jSquash glue uses `new URL('x.wasm', import.meta.url)`, so Vite emits each codec as a hashed same-origin asset under `/_nuxt/`. No copy step or `locateFile` is needed. Libraries that locate WASM differently (e.g. ffmpeg cores) will get a copy step when they are added.
  - No `unpkg` default URLs anywhere (lint rule plus a build check).

### 3.4 Capability detection and "path in use"

The `useCapabilities()` probe runs once at boot (cheap checks) and per tool (expensive probes). It checks:

- `crossOriginIsolated`, `SharedArrayBuffer`
- `hardwareConcurrency`, `deviceMemory` (default 4)
- WebCodecs `VideoEncoder.isConfigSupported` for avc/hevc/vp9/av1 at the target size, and `AudioEncoder` for aac/opus
- `ImageDecoder`
- `navigator.gpu.requestAdapter()`
- OffscreenCanvas 2D/WebGL2 in a worker
- OPFS + sync handle (probed inside a worker)
- `showSaveFilePicker`, `navigator.canShare({files})`, `storage.persisted()`
- 1×1 `convertToBlob` probes for webp/avif

Each engine module exports `resolvePath(caps, options) → 'webcodecs' | 'ffmpeg-mt' | 'ffmpeg-st' | 'native' | 'wasm-mt' | 'wasm'`. The UI shows a `Tag` such as "⚡ Hardware accelerated", "🧵 Multithreaded WASM" or "🐢 Compatibility mode", with a tooltip listing the failed checks. A debug override is available in Settings → Advanced.

### 3.5 Pinia stores

| Store | State | Persisted |
|---|---|---|
| theme | handled by `useColorMode()` from @nuxtjs/color-mode (`preference: 'system'\|'light'\|'dark'`) | ✅ its own localStorage key; no Pinia store |
| `settings` | default output formats/quality, auto-download, keep metadata, reduced motion, debug path override | ✅ |
| `capabilities` | probe results | ❌ (re-probed each session) |
| `jobs` | `{id, tool, label, status, progress, path, sizeIn, sizeOut, error}` | ❌ |
| per-tool (`useImageConvertStore`, …) | options only | ✅ options only |

Setup-style stores. No `File`/`Blob` in reactive state.

### 3.6 Theming

- **Colours:** `app.config.ts` sets `ui.colors: { primary: 'indigo', neutral: 'zinc' }` (brand TBD, checked for AA). Semantic colours (success/warning/error) stay at their defaults.
- **Tokens:** `main.css` has Tailwind 4 `@theme` overrides for the brand palette, `--font-sans: 'Inter Variable'` and radius. Nuxt UI CSS variables (`--ui-radius`, `--ui-bg`, `--ui-text-*`) go under `:root` and `.dark`.
- **Component defaults** in `app.config.ts` `ui.<component>` (slots/variants):
  - `button`/`input` default size `lg` on touch layouts, so targets are ≥44px.
  - Larger `slider` thumb.
  - Visible focus rings.
- **Light/dark/system:** `@nuxtjs/color-mode` (`classSuffix: ''`, `.dark` on `<html>`). Its inline head script prevents the flash of the wrong theme. That script is static, so it is **sha256-hashed into the CSP** by `scripts/csp-hashes.ts`. `UColorModeSelect` lives in Settings, and a toggle button in the top bar.
- **Custom CSS:** limited to the keyboard grid, the before/after compare and the drop-zone highlight, around 150 lines. Everything else uses Tailwind utilities and Nuxt UI props.
- **Bundle:** components are auto-imported on use, so the tiptap/embla/table dependencies are tree-shaken unless used. Check this with `nuxi analyze` in CI.

---

## 4. UI/UX spec

### 4.1 Layouts

| | Phone (<768px) | Tablet | Desktop (≥1024px) |
|---|---|---|---|
| Nav | Fixed **bottom nav** (Home, Images, Docs, Video, More→`UDrawer`). Custom `<nav>` with `ULink`s. | Same, or collapsed sidebar | `UDashboardGroup` + `UDashboardSidebar` (collapsible, `UNavigationMenu` by category) + `UDashboardNavbar` (search button, colour-mode toggle, privacy badge) |
| Tool page | Single column: drop zone → collapsible options (`UAccordion`) → results list → sticky bottom action bar (Convert / Download all) | Two columns | `UDashboardPanel`s: inputs/queue (left), preview (centre), options (right, resizable) |
| Markdown | `UTabs` (Edit / Preview) | `USplitter` | `USplitter` + scroll sync |
| Video | Preview top, filmstrip + range slider, options sheet (`UDrawer` bottom) | | Preview + timeline + options panel |

### 4.2 Home dashboard
- Hero line: **"Everything stays on your device."** with a link to `/privacy`, and a live counter "0 bytes uploaded".
- Search uses `UDashboardSearch`/`UCommandPalette` (fuse.js built in) over title and keywords, opened with ⌘K or `/`. There is also an inline `UInput` filter on the grid.
- `UTabs` (pill variant) category filter (All / Image / Document / Video / Utility).
- `UPageGrid` of `UPageCard`s (1 / 2 / 3–4 cols) showing an icon, a one-line description and a "works offline" or "⬇ 12 MB on first use" `UBadge`.
- Recent tools come from settings.

### 4.3 Shared tool layout (`ToolLayout.vue`)
1. **Drop zone** (custom, accessible):
   - The button opens the picker. Drag-and-drop and paste (Ctrl+V) also work.
   - Multiple files.
   - A PWA `share_target` / `launchQueue` file handler where supported.
   - The empty state shows accepted formats.
2. **Options**: `UFormField`-wrapped `USelect`, `USlider` + `UInputNumber` pairs, `USwitch`, `URadioGroup`, `UTabs`/`UFieldGroup` presets, with "Reset to defaults".
3. **Preview**:
   - Custom `BeforeAfter.vue` (Nuxt UI has no image-compare). It uses `clip-path` plus a native `<input type="range">` for keyboard and screen-reader support, about 60 lines.
   - Size delta via `UBadge` (green −62 %).
   - Zoom via `UModal` fullscreen.
4. **Output**:
   - Per-file `JobRow` showing name, `UProgress`, path badge, size in→out and actions (Download / Share / Remove / Retry).
   - Batch actions: Download all (zip), Clear.

### 4.4 States
| State | Treatment |
|---|---|
| Empty | `UEmpty` + accepted formats + "or try a sample file" (bundled fixtures) |
| Loading engine | `UProgress` with "Downloading AVIF encoder (3.1 MB), one time only" and a Cancel button |
| Processing | Per-job `UProgress` with ETA. Global count in a nav `UChip`. `beforeunload` guard. |
| Done | `useToast()` summary ("12 files, saved 8.4 MB"). Download all. |
| Error | Inline `UAlert color="error"` on the job with a human cause (unsupported codec / too large for this device / corrupt file) and a fix-it action (try compatibility mode, downscale). |
| Unsupported browser | `UAlert` listing missing capabilities plus suggested browsers |
| Offline | Shell works. Tools whose engine is not yet cached show "Needs a one-time download, connect once". Settings has "Make all tools available offline". |

### 4.5 Nuxt UI component map (verified against the @nuxt/ui 4.12.2 tarball)
| Need | Component |
|---|---|
| Shell | `UApp` (required root: toasts, tooltips, overlays), `UDashboardGroup`, `UDashboardSidebar`, `UDashboardNavbar`, `UDashboardPanel`, `UNavigationMenu`, `UDrawer` (mobile "More" / option sheets), custom bottom nav |
| Search / filters | `UDashboardSearch` / `UCommandPalette`, `UInput`, `UTabs`, `UBadge`, `UChip` |
| Cards / lists | `UPageGrid`, `UPageCard`, `UCard`, `USkeleton`; job list is a plain `v-for` of `JobRow` (`UTable` only for the desktop batch view) |
| Drop zone | **`UFileUpload`** (dropzone + file list, no upload semantics; `v-model` of `File[]`), wrapped in our `DropZone` for paste/share-target |
| Options | `UFormField`, `USlider` (multi-thumb for trim range), `UInputNumber`, `USelect`/`USelectMenu`, `USwitch`, `URadioGroup`, `UCheckbox`, `UAccordion`, `UCollapsible`, `UColorPicker` (ICO background) |
| Feedback | `UProgress`, `useToast`, `UAlert`, `UBadge`, `UTooltip`, `UEmpty` |
| Dialogs | `UModal` (confirm large download, cancel batch), `USlideover` |
| Layout | `USplitter`, `UTabs`, `UStepper` (PDF→Word wizard if needed), `UScrollArea` |
| Keyboard tester | `UKbd` for event-log chips; the board itself is a custom CSS grid |
| Markdown | CodeMirror 6 for raw-markdown editing (primary). `UEditor` (tiptap + `@tiptap/markdown`) is an optional WYSIWYG mode later. |
| Custom (no Nuxt UI equivalent) | `BeforeAfter` compare, video filmstrip/timeline, keyboard board, bottom nav |

### 4.6 Accessibility (WCAG 2.2 AA)
- Contrast is AA for both themes; checked in CI with axe.
- Targets are ≥44×44 on coarse pointers via `app.config.ts` size defaults and `pointer-coarse:` Tailwind variants.
- Reka UI primitives handle focus management and ARIA. We supply labels: `aria-label` on every `USlider`, `BeforeAfter` and icon-only `UButton`.
- Visible focus.
- `aria-live="polite"` region for job progress and completion.
- Transitions are off under `prefers-reduced-motion`, via `motion-reduce:` variants and motion-v.
- Keyboard tester: an explicit capture toggle and an escape hatch (Esc held 1 s releases capture).

---

## 5. Security, headers and offline

### 5.1 Response headers (`public/_headers`, applied to `/*`)
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <sha256 hashes>; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; style-src 'self' 'sha256-<nuxt-ui-colors>'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
X-Content-Type-Options: nosniff
```
- `'wasm-unsafe-eval'` is required for WASM compilation. There is **no** `'unsafe-eval'`.
- `connect-src 'self'` enforces the "no third-party calls" promise at the browser level.
- **Inline scripts:** Nuxt's inline config script and the color-mode no-flash script get sha256 hashes. `scripts/csp-hashes.ts` computes them after `nuxt generate` and rewrites `_headers`. JSON-typed payload scripts need no hash.
- **Styles:**
  - Tailwind and Nuxt UI CSS are static files.
  - The only inline `<style>` is Nuxt UI's `#nuxt-ui-colors` block, generated from `app.config.ui.colors`. It is deterministic per build, so the same script hashes it. Its client-side fallback inserts an identical `<style>` element, so the hash matches ⚠ verify.
  - Reka/floating-ui positioning sets `element.style` via CSSOM, which CSP allows.
  - `style-src-attr 'unsafe-inline'` stays only for `style=""` attributes in prerendered HTML. Drop it if Phase 0 shows none are needed.
- Markdown preview and DOCX render happen in a sandboxed `iframe srcdoc` (`sandbox="allow-same-origin"` without scripts) where practical.
- **Dev server:** use the same headers via `vite.server.headers` (and `nitro.routeRules` for preview) so isolation bugs surface in development.

### 5.2 Cross-origin isolation effects
- Every subresource must be same-origin, which is already true.
- No third-party embeds or iframes are possible, which is acceptable.
- `blob:` workers are fine.
- Hosts without header control (GitHub Pages) get a fallback: a Workbox plugin re-adds COOP/COEP on SW-served responses (the coi-serviceworker technique). It costs one reload on first visit. Documented, not the default.
- Offline navigations from the SW cache keep the headers. The SW also re-adds them defensively so a bad cached response can't break isolation.

### 5.3 PWA
- @vite-pwa/nuxt with `registerType: 'prompt'`.
- Precache: shell JS, CSS, HTML, fonts, icons. Budget ≤ 3 MB.
- `globIgnores: ['wasm/**']`.
- Runtime `CacheFirst` for `*.wasm` (content-hashed paths, so no staleness).
- Update toast is shown via `useRegisterSW`; the reload is blocked while jobs are running.
- `navigator.storage.persist()` is requested after the first successful job. `storage.estimate()` is shown in Settings with "Clear cached engines".
- Manifest: standalone, maskable icons, `share_target` (POST files handled by the SW → `launchQueue`), `file_handlers` (Chromium).

---

## 6. Testing strategy

| Layer | Tooling | Scope |
|---|---|---|
| Unit | Vitest 5.1 (node + happy-dom) | Pure libs (BMP/ICO writers, layout derivation, PDF line-grouping heuristics, queue logic, `resolvePath`), stores |
| Browser unit | `@vitest/browser` 5.1 + Playwright provider (Chromium, Firefox, WebKit) | Workers, codecs, OPFS, WebCodecs probes, round-trip encode/decode on fixtures |
| Component | @nuxt/test-utils 4.4 | ToolLayout, DropZone, JobRow states |
| E2E | @playwright/test 1.65 with projects: desktop Chromium/Firefox/WebKit, Pixel 7, iPhone 15 | One happy path per tool, batch, cancel, errors, theme, mobile nav |
| Privacy | Playwright: `page.route('**', …)` aborts and fails on any non-same-origin request across all E2E. A build-time `scripts/check-no-external.ts` greps `.output/public` for `http(s)://` outside an allowlist. | The "no third-party calls" promise |
| Offline | Load → wait for SW → `context.setOffline(true)` → reload → run each tool whose engine was warmed | PWA |
| Isolation | Assert `crossOriginIsolated === true` in preview. A second suite runs without headers to prove fallbacks. | Headers |
| A11y | `@axe-core/playwright` on every page, both themes | WCAG AA |

**Fixtures** (`tests/fixtures`, generated by `scripts/gen-fixtures.ts` and committed, ≤ 5 MB total):
- Images: tiny JPG with EXIF orientation 6, PNG with alpha, animated GIF/WebP, AVIF, HEIC sample, BMP, ICO, one 24 MP JPG (generated at test time, not committed).
- DOCX: headings, lists, table, image, header/footer, two-column.
- PDF: text-only, table, multi-column, scanned page.
- Video: 3 s H.264/AAC MP4, VP9/Opus WebM, rotated phone clip, AVI/MPEG-4 Part 2 (fallback path).
- Markdown: GFM kitchen-sink.

**Performance budgets** (enforced in CI via the build-size check and a Lighthouse CI mobile profile):
| Metric | Budget |
|---|---|
| Shell JS (gz), first load of `/` | ≤ 180 KB |
| Per-tool route chunk (gz, excl. WASM) | ≤ 150 KB (markdown editor ≤ 350 KB) |
| Precache total | ≤ 3 MB |
| LCP (mid-tier mobile, 4G) / INP | < 2.0 s / < 200 ms |
| Main-thread long tasks during a job | none > 50 ms |
| 12 MP JPEG → WebP q75 (desktop / mid phone) | < 1.5 s / < 4 s |
| 1080p 60 s H.264 → 720p (WebCodecs, desktop) | < 1× realtime |

---

## 7. Phased roadmap

### Phase 0: Foundation, shell, PWA (≈1.5 weeks)
- **Spikes first, 1–2 days each:**
  - (a) Nuxt UI offline/CSP hardening on `nuxt generate`:
    - Icons come only from the client bundle (no `/api/_nuxt_icon`, no `api.iconify.design`).
    - `ui.fonts: false` with Inter from fontsource.
    - Hash the `#nuxt-ui-colors` and color-mode inline blocks.
    - Count the `style=""` attributes left in prerendered HTML.
    - Check the tree-shaken bundle size (tiptap/embla must not leak into the shell).
    - Check for a VueUse 14/15 duplicate.
  - (b) TypeScript 7.0 (native) with vue-tsc 3.3. **Result:** vue-tsc fails on TS 7 (`typescript/lib/tsc` is no longer exported), so TypeScript is **pinned to 6.0.3**. Revisit when vue-tsc supports TS 7.
  - (c) A jSquash + Comlink worker under the Nuxt/Vite build with self-hosted WASM.
  - (d) COOP/COEP plus PWA offline round trip.
- Modules and config:
  - Modules: `@nuxt/ui`, `@pinia/nuxt`, `@vueuse/nuxt`, `@vite-pwa/nuxt`. Config sketch:
    ```ts
    modules: ['@nuxt/ui', '@pinia/nuxt', '@vueuse/nuxt', '@vite-pwa/nuxt'],
    css: ['~/assets/css/main.css'],
    ui: { fonts: false, theme: { colors: ['primary','secondary','success','info','warning','error','neutral'] } },
    icon: { provider: 'none', fallbackToApi: false, clientBundle: { scan: true, icons: [/* dynamic names */] } },  // ⚠ verify option names on @nuxt/icon 2.6
    colorMode: { preference: 'system', fallback: 'light', classSuffix: '' },
    ```
  - `strict` TS, ESLint (`@nuxt/eslint`) (no Prettier; ESLint handles style).
  - `app.config.ts` colours and size defaults, plus `main.css` `@theme` tokens.
- App code:
  - Layouts (top bar / bottom nav / drawer), dashboard, registry, `tools/[slug]`.
  - Settings, privacy, about and licences pages. Licences are generated from `node_modules` plus source offers.
  - Capabilities, job queue, worker pool, file I/O composables, OPFS cleanup.
- Build and CI:
  - `_headers` and CSP hash script, no-external check, static preview server with headers.
  - CI: lint, typecheck, unit, E2E smoke, size budgets.

**Acceptance:**
- `nuxt generate` gives a static site with headers.
- `crossOriginIsolated === true` on the preview host.
- Lighthouse PWA installable.
- Offline reload works.
- Zero external requests (E2E guard green).
- Light, dark and system modes with no flash.
- Axe clean.
- A dummy worker job shows progress and cancels correctly, including by terminate.

**Phase 0 status (2026-11-17): implemented.** Verified:
- `nuxt generate` builds a static site; `postgenerate` writes `_headers` with CSP hashes and the no-external check passes.
- Unit tests: 22/22 pass. ESLint and vue-tsc are clean.
- E2E on Chromium desktop and Pixel 7 emulation: 26/26 pass. Covered: smoke, cross-origin isolation, no CSP violations, axe (light and dark), offline after SW install, zero external requests, and the WASM + native encode spike.

Not yet verified:
- **Firefox and WebKit/iPhone E2E.** The sandbox could not install matching Playwright browsers. Run `npx playwright install` locally.
- Lighthouse installability audit.
- An E2E test for cancel. Cancel is covered by unit tests only.

Findings folded back into this plan:
- TypeScript is pinned to 6.0.3.
- WASM is emitted by Vite, with no copy step.
- `@nuxt/icon` must use `mode: 'svg'`; CSS mode injects inline styles that the CSP blocks.
- vaul-vue's runtime `<style>` is hashed from the bundle.
- 256 prerendered `style=""` attributes from the resizable sidebar, so `style-src-attr 'unsafe-inline'` stays.
- Light-mode semantic colours are darkened to pass AA contrast.

**Phase 0 scope for the image-first release:**
- **Keep:** everything above.
- **Simplify:** the dashboard shows only the three image tools, plus "coming soon" cards for the parked tools (no routes).
- **Skip:** the WebCodecs/WebGPU probes. Only image-relevant capabilities are probed: native encode types, `ImageDecoder`, OffscreenCanvas in workers, `crossOriginIsolated`, cores and memory.
- **Spike (c)** uses the real image worker (MozJPEG + WebP), so the work isn't thrown away.

### Phase 1: Image tools (≈3 weeks), **current focus**

| Milestone | Scope | Acceptance |
|---|---|---|
| **1a Engine + Converter** (≈1 wk) | `_image-engine` (probe/decode/ops/encoders, resolvePath), native + jSquash JPEG/PNG/WebP/AVIF, BMP/ICO writers, ICO input, alpha flatten, converter UI, batch, client-zip, folder save | Every input×output pair in §1b.2 round-trips in Chromium, Firefox and WebKit (Vitest browser), with dims preserved and the alpha rule respected. The path badge shows native or WASM correctly with isolation on and off. 20-file batch → zip works offline after first use. |
| **1b Optimizer** (≈1 wk) | Smart / Lossless / Target size / Custom, oxipng, image-q PNG quantise, never-bigger rule, `BeforeAfter` with zoom, savings summary, AVIF hint | Smart mode cuts the photo fixtures by ≥40 % with SSIM ≥ 0.95 (measured in test). Target size is hit within ±5 % or the best attempt is reported. The lossless mode output is pixel-identical (decoded-pixel hash). |
| **1c Resizer** (≈0.5 wk) | Size modes, fit modes, presets + custom presets, pica high-quality + unsharp, fast native path, pre-shrink | Output dims are exact for every mode × fit. A 48 MP → 1080 px batch of 10 completes on an iPhone-class device or emulated low-memory profile with no crash. pica output shows no aliasing on the zone-plate fixture (SSIM against the reference). |
| **1d Polish** (≈0.5 wk) | HEIC (per Q2), animated GIF keep-frames, GPS warning + optional keep-EXIF, hand-off between tools, per-file overrides, sample images, empty/error states, a11y and mobile pass | Fixtures for HEIC (iPhone), animated GIF and EXIF orientation 6 all handled. Axe clean in both themes. Touch targets ≥44 px. No main-thread task over 50 ms during a 50-file batch. Zero external requests. |

**Release v0.1** = Phase 0 + Phase 1, deployed to the chosen host (Q3).

### Later (parked, in this order unless you reprioritise)
The scope and acceptance criteria below are kept unchanged from the original plan.

### Later A: Markdown editor + keyboard tester (≈1.5 weeks)
- Markdown editor: CodeMirror, markdown-it, DOMPurify, Shiki, exports. Acceptance: XSS suite green, exported HTML is self-contained, print PDF has selectable text.
- Keyboard tester: ANSI/ISO × full/TKL/75/60, rollover, ghosting, stuck keys, mobile fallback. Acceptance: every `code` is registered in a Playwright keyboard sweep.

### Later B: PDF ↔ Word (≈2.5 weeks + spike)
- DOCX→PDF: docx-preview print path and pdfmake quick path.
- PDF→DOCX: pdf.js heuristics, page-image mode, OCR pack (tesseract.js, self-hosted, opt-in download).
- Fidelity report UI.
- **Spike (≤3 days):** ZetaOffice go/no-go against the §2.3 criteria.

**Acceptance:**
- Fixture DOCX→PDF keeps headings, lists, tables and images, with selectable text.
- PDF→DOCX of text and table fixtures opens in Word/LibreOffice with correct paragraph order. A text diff against the source is at least 95% the same, measured with the Levenshtein ratio.
- Scanned fixture plus OCR gives at least 90% word accuracy.
- Honest limitation copy shown.
- Engine downloads only after explicit consent, with the size shown.
- Spike written up as an ADR.

### Later C: Video (≈4 weeks)
- Probe layer (`canDecode`/`canEncode` per track).
- Mediabunny pipeline in a worker with OPFS streaming output.
- Optimizer presets.
- Editor: timeline filmstrip, trim, cut, crop overlay, rotate/flip, mute/replace audio, merge with normalisation.
- Wake Lock, `beforeunload` guard.
- **C2:** ffmpeg.wasm compatibility pack (st, plus mt when isolated), opt-in, with a GPL source-offer page. Ships only after the licence decision (Q6).

**Acceptance:**
- 1080p H.264 60 s clip → 720p in under 1× realtime on desktop Chrome (hardware path), and it completes on iPhone (Safari 26).
- Cancel within 1 s with no leaked OPFS files.
- 2 GB input does not OOM on desktop (streamed).
- Trim and cut accurate to ±1 frame in frame-accurate mode.
- Merge of mixed-resolution clips plays in VLC and browsers.
- Firefox AAC export works via the polyfill.
- AVI fixture converts via the compat pack.
- Path badge shows WebCodecs or ffmpeg correctly.

---

## 8. Execution: task breakdown and model assignment

Rule:
- **Opus** handles architecture, cross-cutting work and hard integration.
- **Sonnet** handles most feature work.
- **Haiku** handles boilerplate, config, simple components, copy and tests from clear specs.

| Phase | Task | Model |
|---|---|---|
| 0 | Spikes a–d (Nuxt UI offline/CSP hardening, TS7, worker+WASM bundling, COI+PWA) | **Opus** (a, c, d), **Haiku** (b) |
| 0 | `nuxt.config.ts`, modules, ESLint/TS strict, CI workflow | **Haiku** |
| 0 | Theming: `app.config.ts` colours/size defaults, `@theme` tokens, colour-mode toggle, AA contrast pass | **Sonnet** |
| 0 | `BeforeAfter` compare component (custom, a11y range input) | **Sonnet** |
| 0 | Layouts: top bar, bottom nav, drawer, responsive shell | **Sonnet** |
| 0 | Tool registry, `[slug]` loader, prerender route generation | **Opus** |
| 0 | Worker pool, job queue, Comlink RPC, cancel/terminate, memory guard, OPFS | **Opus** |
| 0 | `useCapabilities` + `resolvePath` contract + CapabilityBadge | **Opus** (contract) / **Sonnet** (probes + UI) |
| 0 | File I/O composables (drop/paste/share-target, save/zip/share) | **Sonnet** |
| 0 | `_headers`, CSP hash script, no-external check, preview server, PWA icons | **Sonnet** |
| 0 | PWA config, update prompt, persistence UI | **Sonnet** |
| 0 | Dashboard, search, settings/privacy/about/licences pages + copy | **Haiku** |
| 0 | Playwright scaffolding, network guard, axe, offline smoke | **Sonnet** (setup) / **Haiku** (cases) |
| 1a | Image engine core: job types, probe/decode/ops pipeline, `resolvePath`, encoder lazy-loading, memory guard integration | **Opus** |
| 1a | Encoder adapters (native, jSquash jpeg/png/webp/avif incl. mt switch) | **Sonnet** |
| 1a | BMP & ICO writers, ICO reader wrapper + unit tests | **Haiku** |
| 1a | Converter UI, batch rows, client-zip download, folder save | **Sonnet** |
| 1a | Image fixtures script + format round-trip test matrix | **Haiku** |
| 1b | Optimizer modes, target-size search, never-bigger rule, oxipng/image-q | **Sonnet** |
| 1b | SSIM/pixel-hash test helpers + optimizer quality tests | **Sonnet** (helpers) / **Haiku** (cases) |
| 1c | Resizer modes/fit/presets, pica + pre-shrink, custom presets | **Sonnet** |
| 1c | Preset data + copy | **Haiku** |
| 1d | HEIC chunk, animated GIF pipeline (ImageDecoder + modern-gif), EXIF/GPS + keep-EXIF splice | **Sonnet** |
| 1d | Tool hand-off, per-file overrides, empty/error states, sample images | **Sonnet** / **Haiku** (states, copy) |
| 1d | Mobile + a11y pass, perf profiling of 50-file batch | **Opus** (review) / **Sonnet** (fixes) |
| A | Markdown editor (CodeMirror, markdown-it plugins, DOMPurify, Shiki, exports) | **Sonnet** |
| A | Keyboard layout data (ANSI/ISO, derivations) | **Haiku** |
| A | Keyboard tester logic (rollover, ghosting, stuck, mobile fallback) + UI | **Sonnet** |
| B | DOCX→PDF (docx-preview print iframe, pdfmake quick path, fonts) | **Sonnet** |
| B | PDF→DOCX heuristics (line/paragraph/table/heading inference) | **Opus** (algorithm design) / **Sonnet** (implementation) |
| B | OCR pack integration (self-hosted tesseract) | **Sonnet** |
| B | ZetaOffice spike + ADR | **Opus** |
| B | Fidelity copy, doc fixtures, E2E | **Haiku** |
| C | Video pipeline architecture: probe, Mediabunny worker, OPFS streaming, merge/normalise, cancel | **Opus** |
| C | Optimizer presets + UI | **Sonnet** |
| C | Editor UI: filmstrip, range trim, crop overlay, audio replace | **Sonnet** |
| C | ffmpeg.wasm compat pack (st/mt switch, command builders) | **Opus** (integration) / **Sonnet** (commands) |
| C | Video fixtures + E2E + perf benchmarks | **Haiku** (fixtures/cases) / **Sonnet** (benchmarks) |
| All | Final code review per phase, integration across tools | **Opus** |

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Nuxt UI defaults make network calls (Iconify API / icon server endpoint, `@nuxt/fonts` provider downloads) | Breaks privacy promise or static hosting | Spike 0a config. The no-external build check and the E2E network guard catch regressions. |
| Nuxt UI's large dependency tree (tiptap, embla, tanstack, motion-v) | Install size, accidental shell bloat | Auto-import tree-shaking. `nuxi analyze` budget check in CI. |
| Nuxt UI pins VueUse `^14.4` while 15.0 is current | Duplicate VueUse in the bundle | Use VueUse 14.x ourselves until Nuxt UI moves |
| TypeScript 7 (native) vs vue-tsc 3.3 | Typecheck breakage | **Confirmed**: pinned TS 6.0.3. |
| ffmpeg.wasm stale (0.12.x, Apr 2025) and GPL | Maintenance / licence | Fallback only, opt-in, isolated lazy chunk, source offer. Can be dropped entirely. |
| libheif LGPL + HEVC patents | Licence | Separate replaceable chunk, attribution, source offer. Native-first on Safari. Can be gated behind a toggle. |
| iOS Safari memory limits / background suspension | Crashes mid-job | Memory guard, sequential batches, downscale-on-decode, Wake Lock, resumable batch (completed results kept). |
| WebCodecs codec gaps (AAC on Firefox/Linux, HEVC/AV1 encode) | Feature holes | Per-track probes, AAC polyfill, Opus/WebM alternative, compat pack. |
| PDF→Word quality expectations | User trust | Clear labelling, fidelity report, page-image mode. |
| `style-src-attr 'unsafe-inline'` may still be needed for prerendered `style=""` attributes | Slightly weaker CSP | Hash the `<style>` blocks. Drop attr-inline if the spike shows none. No third-party script; DOMPurify; sandboxed render iframes. |
| jSquash slow maintenance, nested-worker bundling quirk | Build issues | Single-thread/explicit-URL init. Vendor builds if needed. |
| Static host must support custom headers | No isolation | Cloudflare Pages/Netlify. SW header fallback. App degrades gracefully. |
| Storage eviction (Safari 7-day rule for non-installed) | Engines re-download | Ask for persist, encourage install, show cache status. |

---

## 10. Out of scope for v1
Server-side conversion, accounts and sync, PDF editing/merging, image editing beyond resize/convert, multi-track video timelines, effects/transitions, subtitles, i18n beyond English (strings are kept in one file to allow it later).

---

## 11. Open questions for you

**Needed for the image-first release (v0.1):**
1. ~~UI kit~~ **Decided:** Nuxt UI 4 (MIT).
2. **HEIC input** via libheif (LGPL-3.0, HEVC patents; ~1.5–3 MB lazy chunk): include it, or limit HEIC to Safari's native decoder? Most iPhone photos are HEIC. Recommendation: include it as an opt-in download with attribution and a source offer.
3. **Hosting target:** Cloudflare Pages (recommended), Netlify, or GitHub Pages (needs the SW header workaround)?
4. **Brand:** primary colour, logo and domain (needed for the manifest and prerendered meta). Default if unanswered: indigo/zinc, placeholder logo.
5. **Project licence.** Will Toolify be open source? This affects the LGPL/GPL choices (Q2 here, Q6 below) and whether AGPL mupdf becomes an option later.

**Parked until those tools resume:**

6. **ffmpeg.wasm compat pack (GPL)** (Later C): ship it opt-in with a source offer, or skip it? Recommendation: C2, opt-in.
7. **DOCX→PDF UX** (Later B): is the print dialog acceptable as the high-fidelity path?
8. **LibreOffice WASM** (Later B): run the spike at all, given the likely 100 MB+ download?
9. **OCR languages** (Later B): English only, or a downloadable language picker?
