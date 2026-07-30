// The renderer. Every picture the app shows of a project comes from here: the
// viewport preview, the export, and project thumbnails.
//
// That is the point of it. The preview used to be CSS-3D planes and the export
// WebGL quads — two implementations of one picture, which drifted five separate
// times (underline, letter spacing, curve, warp, text background) before being
// merged. A difference between what you see and what you get is no longer
// something this codebase can express. (True multi-line justify is still
// approximated; audio is muxed separately.)
//
// Shared, not platform code: it needs nothing but WebGL, <video> and canvas.
// `live` is the one behavioural fork — a preview lets its decoders run, an
// export parks each on an exact frame.
import {
  timeline,
  isText,
  setMediaStalled,
  clearMediaStall,
  type Clip,
  type TextSpec,
} from '@shared/logic/timeline/timeline'
import { type Project } from '@shared/logic/project/project'
import { assets } from '@shared/logic/tools/files/assets'
import { sampleClip, sampleText, sampleCurveSpec } from '@shared/logic/timeline/anim'
import { GRADE_GLSL, GRADE_PROPS, gradeActive, curvesActive, buildCurveLut } from './grade'
import { findLut, type Lut } from './lut'

const D = Math.PI / 180
type MediaEl = HTMLImageElement | HTMLVideoElement

// --- shared projection (mirrors viewport's projector), returns NDC + persp w ---
function project3(clip: Clip, local: number, project: Project) {
  const sv = (k: string) => sampleClip(clip, k, local)
  const rx = sv('rotX') * D, ry = sv('rotY') * D, rz = sv('rotZ') * D
  const s = sv('scale'), tx = sv('x'), ty = sv('y'), tz = sv('z')
  const P = Math.max(project.width, project.height)
  const cl = sv('cropL'), cr = sv('cropR'), ctp = sv('cropT'), cb = sv('cropB')
  return (w: number, h: number, u: number, v: number) => {
    // u,v in [0,1] over the VISIBLE (cropped) rect → plane-local pixels
    const lx = (-1 + 2 * cl + u * (2 - 2 * cl - 2 * cr)) // [-1..1] of full plane
    const ly = (-1 + 2 * ctp + v * (2 - 2 * ctp - 2 * cb))
    let x = ((lx * w) / 2) * s
    let y = ((ly * h) / 2) * s
    let z = 0
    let c = Math.cos(rz), sn = Math.sin(rz)
    ;[x, y] = [x * c - y * sn, x * sn + y * c]
    c = Math.cos(ry); sn = Math.sin(ry)
    ;[x, z] = [x * c + z * sn, -x * sn + z * c]
    c = Math.cos(rx); sn = Math.sin(rx)
    ;[y, z] = [y * c - z * sn, y * sn + z * c]
    x += tx; y += ty; z += tz
    const depth = Math.max(P - z, P * 0.05) // same clamp as the viewport
    const f = P / depth
    const sx = project.width / 2 + x * f
    const sy = project.height / 2 + y * f
    // `w` is the homogeneous divisor for perspective-correct interpolation, so
    // it must track DEPTH (∝ P−z), not the magnification f (= P/(P−z)). Passing
    // f here inverts the correction and warps the texture across tilted planes.
    return { ndx: (2 * sx) / project.width - 1, ndy: 1 - (2 * sy) / project.height, w: depth / P }
  }
}

function sizeOf(clip: Clip, local: number, project: Project, el?: MediaEl): { w: number; h: number } {
  const hasW = clip.w != null || clip.anim?.w
  const hasH = clip.h != null || clip.anim?.h
  const nat = () => {
    const nw = el instanceof HTMLImageElement ? el.naturalWidth : el instanceof HTMLVideoElement ? el.videoWidth : 0
    const nh = el instanceof HTMLImageElement ? el.naturalHeight : el instanceof HTMLVideoElement ? el.videoHeight : 0
    if (nw && nh) {
      const s = Math.min(project.width / nw, project.height / nh)
      return { w: nw * s, h: nh * s }
    }
    return { w: project.width, h: project.height }
  }
  if (!hasW && !hasH) return nat()
  const n = hasW && hasH ? null : nat()
  return { w: hasW ? sampleClip(clip, 'w', local) : n!.w, h: hasH ? sampleClip(clip, 'h', local) : n!.h }
}

// --- curved text ---
// Canvas has no textPath, so the arc is sampled into an arc-length table and
// each glyph is placed and rotated along it by hand. This used to have to agree
// with a separate SVG implementation in the preview; the preview now draws
// through here, so there is nothing left to disagree with.
const CURVE_STEPS = 200
type CurvePt = { x: number; y: number; a: number; s: number }

function curveLUT(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): CurvePt[] {
  const pts: CurvePt[] = []
  let s = 0
  let px = x0
  let py = y0
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS
    const u = 1 - t
    const x = u * u * x0 + 2 * u * t * cx + t * t * x1
    const y = u * u * y0 + 2 * u * t * cy + t * t * y1
    if (i) s += Math.hypot(x - px, y - py)
    // derivative of the quadratic → tangent, which is the glyph's rotation
    const dx = 2 * u * (cx - x0) + 2 * t * (x1 - cx)
    const dy = 2 * u * (cy - y0) + 2 * t * (y1 - cy)
    pts.push({ x, y, a: Math.atan2(dy, dx), s })
    px = x
    py = y
  }
  return pts
}

/** Point + tangent at distance `d` along a sampled curve. */
function atLength(lut: CurvePt[], d: number): CurvePt {
  const total = lut[lut.length - 1].s
  const c = Math.max(0, Math.min(total, d))
  let i = 1
  while (i < lut.length - 1 && lut[i].s < c) i++
  const a = lut[i - 1]
  const b = lut[i]
  const f = b.s === a.s ? 0 : (c - a.s) / (b.s - a.s)
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, a: a.a + (b.a - a.a) * f, s: c }
}

// --- text → 2D canvas (used as a texture) ---
function textCanvas(
  clip: Clip,
  local: number,
  w: number,
  h: number,
  // Reused across frames. Animating a clip's width changes the layout, so the
  // glyphs genuinely have to be redrawn — but allocating a fresh canvas element
  // and a fresh 2D context to do it, 60 times a second per clip, is pure waste.
  cv: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  /**
   * Texture pixels per project pixel.
   *
   * The glyphs are laid out in PROJECT units either way — only the surface they
   * land on changes size. An export wants 1:1, so a 1920-wide plane gets a
   * 1920-wide texture. A preview showing that plane 800px wide does not, and
   * paying full resolution per frame on an animated title is the difference
   * between a smooth preview and a slideshow.
   */
  scale = 1,
): HTMLCanvasElement {
  const raw = clip.text as TextSpec
  const cw = Math.max(1, Math.round(w * scale))
  const chh = Math.max(1, Math.round(h * scale))
  if (cv.width !== cw || cv.height !== chh) {
    cv.width = cw // resizing also clears
    cv.height = chh
  } else {
    ctx.clearRect(0, 0, cw, chh)
  }
  ctx.save()
  // draw in project units regardless of how big the surface actually is
  ctx.scale(cw / Math.max(1, w), chh / Math.max(1, h))
  const size = sampleClip(clip, 'size', local)
  if (raw.bg.on) {
    ctx.fillStyle = raw.bg.color
    ctx.fillRect(0, 0, w, h)
  }
  ctx.font = `${raw.italic ? 'italic ' : ''}${raw.bold ? '700 ' : '400 '}${size}px '${raw.font}', sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = raw.align === 'right' ? 'right' : raw.align === 'center' ? 'center' : 'left'
  // Canvas2D gained letterSpacing after the DOM types were written; the webview
  // is Chromium so it's there, and assigning it on an engine without it is a
  // no-op rather than an error.
  ;(ctx as { letterSpacing?: string }).letterSpacing = `${sampleClip(clip, 'letterSpacing', local)}px`
  const sampled = sampleText(clip, local)
  const text = raw.caps ? sampled.toUpperCase() : sampled
  const lines = text.split('\n')
  const lh = size + sampleClip(clip, 'lineSpacing', local)
  const x = raw.align === 'right' ? w : raw.align === 'center' ? w / 2 : 0
  const outline = sampleClip(clip, 'outlineWidth', local)
  const cy0 = h / 2 - (lines.length * lh) / 2 + lh / 2

  // Warp is a horizontal skew about the plane's centre, matching the preview's
  // `skewX`. Applied to the glyphs only — the background is a full-canvas rect
  // here, and skewing that would just open gaps at the edges.
  const warp = sampleClip(clip, 'warp', local)
  if (warp) {
    const k = Math.tan((-warp / 100) * 28 * D)
    ctx.translate(w / 2, h / 2)
    ctx.transform(1, 0, k, 1, 0, 0)
    ctx.translate(-w / 2, -h / 2)
  }

  const curve = sampleClip(clip, 'curve', local)
  if (curve) {
    // Single line while curved, same as the preview: the arc replaces the box.
    const line = text.replace(/\n+/g, ' ')
    const pad = Math.max(size * 0.6, 20)
    const bend = (curve / 100) * (h / 2 - size * 0.3)
    const baseY = h / 2 + size * 0.35 + bend / 2
    const lut = curveLUT(pad, baseY, w / 2, baseY - 2 * bend, w - pad, baseY)
    const total = lut[lut.length - 1].s
    const chars = [...line]
    const widths = chars.map((ch) => ctx.measureText(ch).width)
    const runWidth = widths.reduce((a, b) => a + b, 0)
    // textPath startOffset 50% + text-anchor middle = centred on the arc
    const start = (total - runWidth) / 2
    ctx.textAlign = 'center'
    /** Walk the glyphs, placing each on the arc with its tangent. */
    const eachGlyph = (draw: (ch: string) => void) => {
      let d = start
      for (let i = 0; i < chars.length; i++) {
        const p = atLength(lut, d + widths[i] / 2)
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.a)
        draw(chars[i])
        ctx.restore()
        d += widths[i]
      }
    }
    // Two passes, like SVG's paint-order="stroke": a glyph's outline has to go
    // behind EVERY glyph's fill, not just its own. Stroking and filling one
    // letter at a time let each outline cover the letter before it.
    if (raw.outline.on && outline > 0) {
      ctx.lineWidth = outline * 2
      ctx.strokeStyle = raw.outline.color
      ctx.lineJoin = 'round'
      eachGlyph((ch) => ctx.strokeText(ch, 0, 0))
    }
    ctx.fillStyle = raw.fill
    eachGlyph((ch) => ctx.fillText(ch, 0, 0))
    ctx.restore()
    return cv
  }

  // Stroke every line before filling any — with negative line spacing the lines
  // overlap, and a per-line stroke-then-fill would outline over the line above.
  if (raw.outline.on && outline > 0) {
    ctx.lineWidth = outline * 2
    ctx.strokeStyle = raw.outline.color
    ctx.lineJoin = 'round'
    lines.forEach((ln, i) => ctx.strokeText(ln, x, cy0 + i * lh))
  }
  ctx.fillStyle = raw.fill
  lines.forEach((ln, i) => {
    const y = cy0 + i * lh
    ctx.fillText(ln, x, y)
    // Canvas has no text-decoration, so the rule is drawn by hand. Proportions
    // match what a browser picks for the same font size.
    if (raw.underline && ln) {
      const lw = ctx.measureText(ln).width
      const x0 = raw.align === 'right' ? x - lw : raw.align === 'center' ? x - lw / 2 : x
      ctx.fillRect(x0, y + size * 0.34, lw, Math.max(1, size / 16))
    }
  })
  ctx.restore()
  return cv
}

// --- GL renderer ---
const VS = `attribute vec2 aPos; attribute float aW; attribute vec2 aUV;
varying vec2 vUV; void main(){ vUV = aUV; gl_Position = vec4(aPos * aW, 0.0, aW); }`
// highp, not mediump: grading does pow() in linear light, and mediump loses
// enough in the shadows to band them visibly.
const FS = `precision highp float; varying vec2 vUV; uniform sampler2D uTex; uniform float uAlpha;
${GRADE_GLSL}
void main(){ vec4 c = texture2D(uTex, vUV); gl_FragColor = vec4(grade(c.rgb), c.a * uAlpha); }`

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    // An empty info log almost always means the context went away rather than
    // the source being wrong — say which, since the two have nothing to do with
    // each other and 'shader' on its own sends you reading GLSL for no reason.
    const log = gl.getShaderInfoLog(s)
    throw new Error(
      gl.isContextLost()
        ? 'the GPU context was lost while building the renderer'
        : `shader failed to compile: ${log || '(no log)'}`,
    )
  }
  return s
}

// --- RGBA → planar yuv420p, packed for a single readPixels ---
//
// RGBA is 4 bytes per pixel, yuv420p is 1.5 — 62.5% less to push to ffmpeg. The
// conversion has to be on the GPU to be a saving, so a second pass renders into
// a (W/4)x(H*1.5) RGBA framebuffer where each texel is four consecutive planar
// bytes. readPixels then returns a ready-made yuv420p frame and ffmpeg takes it
// verbatim, skipping swscale (which alone more than doubled its ingest rate).
//
// BT.601 limited range, 2x2 box average for chroma — what swscale was already
// doing here, verified against ffmpeg's output. Changing these shifts the colour
// of every export.
const PACK_VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`

const PACK_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uScene;
uniform int uW; uniform int uH; uniform int uPW;
out vec4 outColor;

// c is 0..1, the classic 0..255 coefficients fold into it directly
float lumaY(vec3 c){ return (16.0 + 65.481*c.r + 128.553*c.g + 24.966*c.b) / 255.0; }
float chromaU(vec3 c){ return (128.0 - 37.797*c.r - 74.203*c.g + 112.000*c.b) / 255.0; }
float chromaV(vec3 c){ return (128.0 + 112.000*c.r - 93.786*c.g - 18.214*c.b) / 255.0; }

// The scene texture holds the image already flipped (row 0 = image top), the
// same trick the draw pass uses so readPixels comes out top-down.
vec3 texel(int x, int y){ return texelFetch(uScene, ivec2(x, y), 0).rgb; }

vec3 box2x2(int x, int y){
  return (texel(x, y) + texel(x + 1, y) + texel(x, y + 1) + texel(x + 1, y + 1)) * 0.25;
}

// one output byte, addressed by its offset into the planar frame
float planarByte(int off){
  int ysz = uW * uH;
  int cw = uW / 2;
  int csz = cw * (uH / 2);
  if (off < ysz) return lumaY(texel(off % uW, off / uW));
  if (off < ysz + csz){
    int o = off - ysz;
    return chromaU(box2x2((o % cw) * 2, (o / cw) * 2));
  }
  int o = off - ysz - csz;
  return chromaV(box2x2((o % cw) * 2, (o / cw) * 2));
}

void main(){
  ivec2 f = ivec2(gl_FragCoord.xy);
  // gl_FragCoord.y == 0 is the row readPixels returns first, so this is simply
  // the linear byte offset into the output buffer
  int base = (f.y * uPW + f.x) * 4;
  outColor = vec4(
    planarByte(base), planarByte(base + 1), planarByte(base + 2), planarByte(base + 3)
  );
}`

export interface Renderer {
  render: (t: number) => Promise<void>
  /** ms the last `render` spent waiting on video seeks, as opposed to drawing.
   *  The two are bundled into one number otherwise, and they pull in opposite
   *  directions: seek time is decode/IO, draw time is GPU. */
  lastSeekMs: number
  /**
   * Live preview: let the video elements run and draw whatever frame they are
   * showing, instead of parking each on an exact time.
   *
   * An export wants the second behaviour — every frame must be the right frame,
   * however long the seek takes. A preview wants the first: seeking sixty times
   * a second restarts the decoder sixty times and never actually plays. Set this
   * from the transport each frame; it is false for an export, which is why an
   * export is unaffected by any of it.
   */
  live: boolean
  /**
   * An object to draw regardless of the playhead, at its own local time.
   *
   * The animation editor scrubs one object independently of the timeline, and
   * has to keep showing it at its very last frame — which the half-open range
   * test hides, since a clip ends the instant the playhead reaches its end. Null
   * for an export, where drawing an object outside its range would be wrong.
   */
  hold: { clipId: string; local: number } | null
  /**
   * Force the GPU to finish each frame before returning.
   *
   * An export needs it: draw calls only QUEUE work, so without a sync the cost
   * lands in whatever phase happens to touch the GPU next and the per-frame
   * accounting is a fiction. A preview needs the opposite — the sync stalls the
   * pipeline for numbers nobody reads.
   */
  measure: boolean
  /** current frame in `pixFmt`, top-down, into a caller's buffer */
  readFrame: (into: Uint8Array) => Uint8Array
  /** what ffmpeg should be told to expect on stdin */
  pixFmt: 'rgba' | 'yuv420p'
  /** bytes one frame occupies in `pixFmt` */
  frameBytes: number
  dispose: () => void
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  project: Project,
  /** assetId → proxy to read instead of the original (all-intra export
   *  proxies), with the source's frame rate (0 when unknown) */
  srcOverride?: Map<string, { url: string; fps: number }>,
  /** false when the frame is consumed from the canvas itself (WebCodecs), which
   *  needs the scene in the default framebuffer rather than packed in an FBO */
  packed = true,
): Promise<Renderer> {
  // WebGL2 buys the yuv420p pack pass (integer maths + texelFetch). Only the
  // WebGL1 path strictly needs preserveDrawingBuffer, since it reads the default
  // framebuffer, which the compositor may clear before readPixels. Kept on for
  // both: the pack path renders to an FBO so the flag costs it nothing, and
  // WebGL2 still falls back to RGBA when the dimensions aren't packable.
  // A sleep/resume, a driver reset or a GPU switch can take the context away
  // mid-export. Nothing downstream would notice on its own: draws become no-ops
  // and readPixels returns zeroes, so the export runs to completion and writes a
  // silently black file. Fail loudly instead.
  let lost = false
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault() // keep the canvas restorable for the next attempt
    lost = true
  })

  const opts = { premultipliedAlpha: false, preserveDrawingBuffer: true }
  const gl2 = canvas.getContext('webgl2', opts) as WebGL2RenderingContext | null
  const gl: WebGLRenderingContext | null =
    gl2 ?? (canvas.getContext('webgl', opts) as WebGLRenderingContext | null)
  if (!gl) throw new Error('WebGL not available')
  const W = canvas.width
  const H = canvas.height
  // packing needs whole texels per row and whole 2x2 chroma blocks
  const useYuv = packed && !!gl2 && W % 4 === 0 && H % 2 === 0
  // -1 stores the scene upside down for readPixels; +1 leaves it as displayed,
  // which is what anything reading the canvas directly needs (see drawQuad)
  const fy = packed ? -1 : 1
  const PW = W / 4
  const PH = (H * 3) / 2
  const prog = gl.createProgram()!
  try {
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS))
  } catch (e) {
    // Hand the context back before giving up. A context that outlives its
    // failed renderer still counts against the browser's limit, so failing to
    // release one here makes the NEXT attempt likelier to fail the same way.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw e
  }
  gl.linkProgram(prog)
  gl.useProgram(prog)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  const aW = gl.getAttribLocation(prog, 'aW')
  const aUV = gl.getAttribLocation(prog, 'aUV')
  const uAlpha = gl.getUniformLocation(prog, 'uAlpha')
  const uGradeOn = gl.getUniformLocation(prog, 'uGradeOn')
  const uCurveOn = gl.getUniformLocation(prog, 'uCurveOn')
  const uLutOn = gl.getUniformLocation(prog, 'uLutOn')
  const uLutSize = gl.getUniformLocation(prog, 'uLutSize')
  const uLutMix = gl.getUniformLocation(prog, 'uLutMix')
  // the object's own texture stays on unit 0; the curve bake rides on unit 1
  // and the LUT on unit 2, so neither disturbs the media upload path
  gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'uCurve'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'uLut'), 2)
  // A sampler pointing at a unit with nothing bound is an INCOMPLETE texture,
  // which the driver is entitled to complain about (and Chrome does, once per
  // draw) even though the branch never samples it. One white texel each, bound
  // once, and the units are never empty again.
  {
    const stub = gl.createTexture()!
    for (const unit of [gl.TEXTURE1, gl.TEXTURE2]) {
      gl.activeTexture(unit)
      gl.bindTexture(gl.TEXTURE_2D, stub)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    gl.activeTexture(gl.TEXTURE0)
  }
  // looked up once, in registry order, so the draw loop is a plain zip
  const uGrade = GRADE_PROPS.map((p) => gl.getUniformLocation(prog, 'u' + p.id[0].toUpperCase() + p.id.slice(1)))
  const buf = gl.createBuffer()
  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  // NOT flipped: our quad UVs already put v=0 at the top (tl→0,0), matching an
  // unflipped upload where image row 0 lands at t=0. Flipping here too would
  // invert every texture.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)

  // media elements + persistent GL textures (images uploaded once; videos + text each frame)
  const images = new Map<string, HTMLImageElement>()
  /** assetId → url, so a second decoder for the same source can be opened later */
  const videoSrc = new Map<string, string>()
  /**
   * assetId → its decoders. Several, because a `<video>` parks on one time at a
   * time and the same source often appears twice in a frame at DIFFERENT times
   * (reused b-roll, a multicam angle, a split clip overlapping its own tail).
   * One element per asset meant seeking those in sequence inside the draw loop,
   * so per-frame cost became the SUM of the seeks. A decoder each seeks at once.
   */
  const pools = new Map<string, (HTMLVideoElement | undefined)[]>()
  /** assetId → source frame rate, 0 when unknown (originals, old proxy cache) */
  const srcFps = new Map<string, number>()
  // keyed by element, not asset: with a pool there are several per asset, and
  // each is parked on its own frame
  const tex = new Map<MediaEl, WebGLTexture>()
  const jobs: Promise<void>[] = []

  /** A muted decoder on `url`, plus a promise for its metadata. */
  function openVideo(url: string): [HTMLVideoElement, Promise<void>] {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    // Chromium defaults to 'metadata' for an element that never plays, which
    // decodes no frames at all. MAX_DECODERS already bounds how many of these
    // exist, so the read-ahead this costs is capped.
    v.preload = 'auto'
    // every frame in a proxy is a keyframe, so seeking is a direct read
    // rather than a decode from the previous keyframe
    v.src = url
    return [
      v,
      new Promise<void>((r) =>
        v.readyState >= 1 ? r() : ((v.onloadedmetadata = () => r()), (v.onerror = () => r())),
      ),
    ]
  }

  const seen = new Set<string>()
  for (const tr of timeline.value.tracks)
    for (const c of tr.clips) {
      if (c.audioOnly || isText(c) || !c.assetId || seen.has(c.assetId)) continue
      const a = assets.value.find((x) => x.id === c.assetId)
      if (!a || a.missing) continue
      seen.add(a.id)
      if (a.kind === 'image') {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.src = a.url
        images.set(a.id, img)
        jobs.push(new Promise((r) => (img.complete ? r() : ((img.onload = () => r()), (img.onerror = () => r())))))
      } else if (a.kind === 'video') {
        // Registered, NOT opened: see MAX_DECODERS.
        const over = srcOverride?.get(a.id)
        videoSrc.set(a.id, over?.url ?? a.url)
        srcFps.set(a.id, over?.fps ?? 0)
        pools.set(a.id, [])
      }
    }
  await Promise.all(jobs)

  /**
   * How many decoders may be alive at once.
   *
   * Opening one per source upfront meant a half-hour project sat on dozens of
   * live decoders reading ahead through 50-100 Mbps intra proxies, to draw a
   * frame showing two of them. Past Chromium's hardware-decoder limit the
   * surplus goes software, burning CPU on the same media threads the hardware
   * ENCODER uses — which is how project *length* ended up setting encode rate.
   *
   * On demand, LRU eviction. A frame's own decoders are never evicted, so a
   * frame needing more than this still works; it just doesn't keep them.
   */
  const MAX_DECODERS = 8
  /** frame counter, for LRU ordering */
  let useClock = 0
  /** element → `useClock` when it was last drawn */
  const lastUsed = new Map<HTMLVideoElement, number>()

  /** The n-th decoder for an asset, opened on first use. Extra ones per asset
   *  are only created when a frame genuinely needs the source at two times at
   *  once, so a project that never does that pays nothing. */
  function poolAt(assetId: string, n: number): [HTMLVideoElement, Promise<void> | null] {
    const p = pools.get(assetId)!
    const have = p[n]
    if (have) return [have, null]
    const [v, ready] = openVideo(videoSrc.get(assetId)!)
    elFps.set(v, srcFps.get(assetId) ?? 0)
    elKey.set(v, `${assetId}:${n}`) // stable id for stall reporting
    p[n] = v
    return [v, ready]
  }

  /** Release one decoder and everything keyed to it. */
  function closeDecoder(el: HTMLVideoElement) {
    for (const p of pools.values()) {
      const i = p.indexOf(el)
      if (i >= 0) {
        p[i] = undefined // a hole; poolAt reopens on demand
        break
      }
    }
    const t = tex.get(el)
    if (t) {
      gl!.deleteTexture(t)
      tex.delete(el)
      texSize.delete(t)
      filled.delete(t)
    }
    const k = elKey.get(el)
    if (k) clearMediaStall(k)
    elKey.delete(el)
    unreadySince.delete(el)
    lastUp.delete(el)
    lastUsed.delete(el)
    elFps.delete(el)
    lastSeekIdx.delete(el)
    el.pause()
    el.removeAttribute('src')
    el.load() // dropping the reference isn't enough; the element must let go
  }

  /** Close the longest-idle decoders until we're back under the cap. `keep` is
   *  the set this frame is about to draw from and is never touched. */
  function evictDecoders(keep: Set<HTMLVideoElement>) {
    let live = 0
    const spare: HTMLVideoElement[] = []
    for (const p of pools.values())
      for (const el of p)
        if (el) {
          live++
          if (!keep.has(el)) spare.push(el)
        }
    if (live <= MAX_DECODERS) return
    spare.sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))
    for (const el of spare) {
      if (live <= MAX_DECODERS) break
      closeDecoder(el)
      live--
    }
  }

  // --- yuv420p pack pass: scene FBO, pack FBO, and the program between them ---
  let sceneFbo: WebGLFramebuffer | null = null
  let sceneTex: WebGLTexture | null = null
  let packFbo: WebGLFramebuffer | null = null
  let packTex: WebGLTexture | null = null
  let packProg: WebGLProgram | null = null
  let packBuf: WebGLBuffer | null = null
  let uScene: WebGLUniformLocation | null = null

  function attach(w: number, h: number): [WebGLFramebuffer, WebGLTexture] {
    const t = gl!.createTexture()!
    gl!.bindTexture(gl!.TEXTURE_2D, t)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null)
    // exact texel reads only — any filtering here would blend planar bytes
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    const f = gl!.createFramebuffer()!
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, f)
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, t, 0)
    if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE)
      throw new Error('framebuffer incomplete')
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
    return [f, t]
  }

  if (useYuv) {
    ;[sceneFbo, sceneTex] = attach(W, H)
    ;[packFbo, packTex] = attach(PW, PH)
    packProg = gl.createProgram()!
    gl.attachShader(packProg, compile(gl, gl.VERTEX_SHADER, PACK_VS))
    gl.attachShader(packProg, compile(gl, gl.FRAGMENT_SHADER, PACK_FS))
    gl.linkProgram(packProg)
    if (!gl.getProgramParameter(packProg, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(packProg) || 'pack program')
    gl.useProgram(packProg)
    uScene = gl.getUniformLocation(packProg, 'uScene')
    gl.uniform1i(uScene, 0)
    gl.uniform1i(gl.getUniformLocation(packProg, 'uW'), W)
    gl.uniform1i(gl.getUniformLocation(packProg, 'uH'), H)
    gl.uniform1i(gl.getUniformLocation(packProg, 'uPW'), PW)
    // one oversized triangle covers the target with no seam down the middle
    packBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, packBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.useProgram(prog)
  }

  function newTex(): WebGLTexture {
    const t = gl!.createTexture()!
    gl!.bindTexture(gl!.TEXTURE_2D, t)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
    return t
  }

  /**
   * clipId → its baked tone curve, kept until the curve changes.
   *
   * Baking is 768 samples of a spline; doing it per frame per object would put
   * it in the same budget as the drawing. The key is the curve itself — SHAPED
   * at this frame's local time, since a keyframed curve is a different curve
   * each frame — so an object being dragged around rebakes nothing, an edited
   * curve rebakes on the next frame without anything having to tell us, and an
   * animated one rebakes only while it is actually moving.
   */
  const curveTex = new Map<string, { tex: WebGLTexture; key: string }>()
  function curveTexture(c: Clip, local: number): WebGLTexture {
    const spec = sampleCurveSpec(c, local)
    const key = JSON.stringify(spec)
    const have = curveTex.get(c.id)
    if (have && have.key === key) return have.tex
    const tex = have?.tex ?? gl!.createTexture()!
    gl!.bindTexture(gl!.TEXTURE_2D, tex)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, 256, 1, 0, gl!.RGB, gl!.UNSIGNED_BYTE, buildCurveLut(spec))
    curveTex.set(c.id, { tex, key })
    return tex
  }

  /**
   * lutId → the uploaded cube. Shared by every object using that look, and
   * uploaded once: a 33³ LUT is 144KB of texture, which is nothing to hold and
   * a waste to re-send per object per frame.
   */
  const lutTex = new Map<string, WebGLTexture>()
  function lutTexture(l: Lut): WebGLTexture | null {
    if (!l.data) return null
    const have = lutTex.get(l.id)
    if (have) return have
    const tex = gl!.createTexture()!
    gl!.bindTexture(gl!.TEXTURE_2D, tex)
    // CLAMP + LINEAR, and no mipmaps: the cube is not a power of two, and the
    // red/green taps are kept half a texel inside each tile so the filter never
    // blends across a blue slice
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, l.size * l.size, l.size, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, l.data)
    lutTex.set(l.id, tex)
    return tex
  }

  // Rasterising text means allocating a canvas and re-drawing every glyph. Most
  // text is static for most of its life, so key a cache on everything that
  // affects the pixels and only redraw when that signature moves.
  // Texture pixels per project pixel. 1:1 for an export (W is the project
  // width); a fraction of that for a preview canvas, which is the whole reason
  // rasterised text is affordable there.
  const texScale = Math.min(1, W / Math.max(1, project.width))
  const textCache = new Map<
    string,
    { sig: string; tex: WebGLTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
  >()
  function textTexture(clip: Clip, local: number, w: number, h: number) {
    const t = clip.text as TextSpec
    const sig = [
      sampleText(clip, local), Math.round(w), Math.round(h),
      sampleClip(clip, 'size', local), sampleClip(clip, 'lineSpacing', local),
      sampleClip(clip, 'letterSpacing', local), sampleClip(clip, 'outlineWidth', local),
      sampleClip(clip, 'curve', local), sampleClip(clip, 'warp', local),
      t.font, t.fill, t.align, t.bold, t.italic, t.caps, t.underline,
      t.bg.on, t.bg.color, t.outline.on, t.outline.color,
    ].join('|')
    let e = textCache.get(clip.id)
    if (!e) {
      const canvas = document.createElement('canvas')
      e = { sig: '', tex: newTex(), canvas, ctx: canvas.getContext('2d')! }
      textCache.set(clip.id, e)
    }
    const changed = e.sig !== sig
    if (changed) {
      textCanvas(clip, local, w, h, e.canvas, e.ctx, texScale)
      e.sig = sig
    }
    return { tex: e.tex, canvas: e.canvas, changed }
  }

  /** element → the `currentTime` its texture currently holds */
  const lastUp = new Map<MediaEl, number>()
  /** texture → the dimensions it is currently allocated at */
  const texSize = new Map<WebGLTexture, [number, number]>()

  /** Natural pixel size of anything we upload, or [0,0] if not known yet. */
  function srcSize(s: TexImageSource): [number, number] {
    if (s instanceof HTMLVideoElement) return [s.videoWidth, s.videoHeight]
    if (s instanceof HTMLImageElement) return [s.naturalWidth, s.naturalHeight]
    if (s instanceof HTMLCanvasElement) return [s.width, s.height]
    return [0, 0]
  }

  /** Textures that have actually received pixels. `newTex` allocates no storage,
   *  so until this holds it, the texture is not usable as a draw source. */
  const filled = new Set<WebGLTexture>()

  /**
   * Does this source have pixels yet?
   *
   * A `<video>` at HAVE_METADATA already reports videoWidth/videoHeight but has
   * decoded nothing. Uploading one is silently a no-op — which is the trap
   * below: the size looked valid, so `texSize` was recorded, and every later
   * frame then took the `texSubImage2D` path against a texture that had never
   * been allocated. That fails with INVALID_OPERATION, so the source never drew
   * again for the rest of the export.
   */
  function hasFrame(s: TexImageSource): boolean {
    if (s instanceof HTMLVideoElement) return s.readyState >= 2 // HAVE_CURRENT_DATA
    if (s instanceof HTMLImageElement) return s.complete && s.naturalWidth > 0
    return true
  }

  /**
   * Push a frame into the bound texture.
   *
   * `texImage2D` re-specifies the texture — reallocating GPU storage every call,
   * which on a multi-layer scene is most of the per-frame GPU cost, for a size
   * that never changes. `texSubImage2D` writes into the existing allocation, so
   * the reallocation happens once per source instead of sixty times a second.
   */
  function upload(tx: WebGLTexture, source: TexImageSource) {
    if (!hasFrame(source)) return // nothing to copy; leave the texture untouched
    const [sw, sh] = srcSize(source)
    const cur = texSize.get(tx)
    if (sw && sh && cur && cur[0] === sw && cur[1] === sh) {
      gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, source)
    } else {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source)
      if (sw && sh) texSize.set(tx, [sw, sh])
    }
    filled.add(tx)
  }

  /** element → its source's frame rate, copied from srcFps when it's opened */
  const elFps = new Map<HTMLVideoElement, number>()
  /** element → source frame index of its last completed seek */
  const lastSeekIdx = new Map<HTMLVideoElement, number>()
  /** element → a stable id, so a stall can be reported and later cleared */
  const elKey = new Map<HTMLVideoElement, string>()

  function seek(v: HTMLVideoElement, tt: number): Promise<void> {
    return new Promise((res) => {
      // A 24fps source in a 60fps export gets 60 seek requests a second but
      // only 24 NEW frames — the other 36 land inside the frame the decoder is
      // already parked on. Each of those no-op seeks still costs a pipeline
      // flush and a decode in Chromium's media process, which the hardware
      // encoder shares: on a full-res proxy that churn is what starved the
      // encoder and dragged a whole export down. Skip them.
      const fps = elFps.get(v) ?? 0
      const idx = fps > 0 ? Math.floor(tt * fps + 1e-4) : -1
      // Neither shortcut may fire before the decoder holds a frame: a freshly
      // opened element sits at currentTime 0 with nothing decoded, so a clip
      // starting at 0 matched "already parked" and was handed to the uploader
      // empty.
      const ready = v.readyState >= 2
      if (ready && idx >= 0 && lastSeekIdx.get(v) === idx) return res()
      const parked = Math.abs(v.currentTime - tt) < 1e-3
      if (ready && parked) {
        if (idx >= 0) lastSeekIdx.set(v, idx)
        return res()
      }
      const done = () => {
        v.removeEventListener('seeked', done)
        v.removeEventListener('loadeddata', done)
        v.removeEventListener('error', done)
        if (idx >= 0) lastSeekIdx.set(v, idx)
        res()
      }
      v.addEventListener('seeked', done)
      v.addEventListener('error', done) // undecodable: draw nothing, don't hang
      // Already on the right time but still empty — no 'seeked' will ever fire,
      // so the first decoded frame is the signal instead.
      if (parked) v.addEventListener('loadeddata', done)
      else v.currentTime = Math.max(0, tt)
    })
  }

  function drawQuad(
    tx: WebGLTexture,
    source: TexImageSource,
    alpha: number,
    corners: { ndx: number; ndy: number; w: number }[],
    fresh = true,
  ) {
    // two triangles: TL,TR,BL / TR,BR,BL  (uv: 0,0 top-left)
    const [tl, tr, bl, br] = corners
    // On the readPixels paths ndy is negated so the framebuffer is stored upside
    // down; readPixels returns rows bottom-up, and the two cancel to give the
    // top-down order rawvideo expects. Flipping here is free — flipping 8MB of
    // rows per frame afterwards would not be.
    //
    // When the frame is taken from the canvas instead (WebCodecs reads it as
    // displayed) there is no second inversion to cancel against, so that flip
    // would ship the whole video upside down. Hence: flip only when we read.
    const data = new Float32Array([
      tl.ndx, fy * tl.ndy, tl.w, 0, 0,
      tr.ndx, fy * tr.ndy, tr.w, 1, 0,
      bl.ndx, fy * bl.ndy, bl.w, 0, 1,
      tr.ndx, fy * tr.ndy, tr.w, 1, 0,
      br.ndx, fy * br.ndy, br.w, 1, 1,
      bl.ndx, fy * bl.ndy, bl.w, 0, 1,
    ])
    gl!.bindBuffer(gl!.ARRAY_BUFFER, buf)
    gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.DYNAMIC_DRAW)
    const st = 5 * 4
    gl!.enableVertexAttribArray(aPos); gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, st, 0)
    gl!.enableVertexAttribArray(aW); gl!.vertexAttribPointer(aW, 1, gl!.FLOAT, false, st, 8)
    gl!.enableVertexAttribArray(aUV); gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, st, 12)
    // A still image's pixels never change, so uploading it every frame is a
    // full texture transfer (33MB for a 4K photo) for nothing. Video and text
    // do change, and pass fresh=true.
    if (fresh) upload(tx, source)
    gl!.uniform1f(uAlpha, alpha)
    gl!.drawArrays(gl!.TRIANGLES, 0, 6)
  }

  /**
   * Live playback: let each element run and correct it only when it has drifted.
   *
   * Never awaited. A preview that waited on a seek per element would run at the
   * decoder's pace instead of the display's, and every frame would restart a
   * decode it was about to throw away. `DRIFT` is deliberately loose — a fifth
   * of a second is invisible against moving video, and tightening it turns this
   * back into a seek per frame.
   */
  const DRIFT = 0.2
  /**
   * How long a decoder must be unready before it may hold the transport.
   *
   * Holding it is expensive in a way that isn't obvious from here: the audio
   * mixer's voices run in real time against the playhead, so a frozen playhead
   * becomes drift, and past its tolerance the mixer yanks currentTime back —
   * heard as the audio cutting out. Decoders are re-opened routinely (proxies
   * arriving, eviction under MAX_DECODERS), and each re-open is a moment of
   * readyState 0. Reporting those immediately turned ordinary churn into
   * repeated audio drops. A real buffering stall lasts; a re-open does not.
   */
  const STALL_MS = 250
  /** element → when it first went unready, or 0 while it is fine */
  const unreadySince = new Map<HTMLVideoElement, number>()
  function runLive(parked: Map<HTMLVideoElement, number>) {
    const now = performance.now()
    // Anything not on screen this frame can't hold the transport up. Without
    // this, a clip that was buffering when the playhead left it stayed marked
    // stalled for good, and the transport — and the audio riding on it —
    // never started again.
    for (const p of pools.values())
      for (const el of p) {
        if (!el || parked.has(el)) continue
        unreadySince.delete(el)
        const k = elKey.get(el)
        if (k) clearMediaStall(k)
      }
    for (const [el, at] of parked) {
      const key = elKey.get(el)
      if (el.readyState < 1) continue // nothing to sync against yet
      if (Math.abs(el.currentTime - at) > DRIFT) el.currentTime = Math.max(0, at)
      // muted: the mixer owns preview audio, and it needs the whole timeline's
      // levels rather than whatever one element happens to be playing
      el.muted = true
      if (el.paused) void el.play().catch(() => {})
      // Buffering holds the transport rather than letting the playhead run on
      // past frames that haven't arrived. HAVE_CURRENT_DATA — it has a frame to
      // show — is the threshold the CSS preview used.
      if (key) {
        const ok = el.readyState >= 2
        if (ok) {
          unreadySince.delete(el)
          clearMediaStall(key)
        } else {
          const since = unreadySince.get(el) ?? now
          unreadySince.set(el, since)
          if (now - since > STALL_MS) setMediaStalled(key, true)
        }
      }
    }
  }

  /** Stop every decoder this renderer owns (playback stopped, or it's going). */
  function pauseAll() {
    for (const p of pools.values())
      for (const el of p)
        if (el) {
          if (!el.paused) el.pause()
          // nothing is waiting on it any more; a stale stall would freeze the
          // transport for good
          const k = elKey.get(el)
          if (k) clearMediaStall(k)
        }
  }

  async function render(t: number) {
    if (lost)
      throw new Error(
        'the GPU rendering context was lost — this usually means the machine slept or the ' +
          'graphics driver reset. The part exported so far was saved; start the export again.',
      )
    // Two passes: seek everything, then draw. Seeking inside the draw loop made
    // per-frame cost the SUM of every seek on screen, since each waited on the
    // last. They're independent, so issue them together and let the draw pass
    // find every element already parked. A source needed at two times gets a
    // second decoder here rather than a second seek later, so the pass stays
    // parallel however many layers stack up.
    const tracks = timeline.value.tracks
    type Draw = { c: Clip; local: number; el?: MediaEl }
    const draws: Draw[] = []
    /** element → the time it must be parked on for this frame */
    const parked = new Map<HTMLVideoElement, number>()
    /** assetId → time → the decoder already serving that time this frame */
    const serving = new Map<string, Map<number, HTMLVideoElement>>()
    /** assetId → how many of its decoders are spoken for this frame */
    const taken = new Map<string, number>()
    const opening: Promise<void>[] = []
    /** decoders this frame draws from — exempt from eviction */
    const keep = new Set<HTMLVideoElement>()
    useClock++
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
      for (const c of tracks[ti].clips) {
        if (c.audioOnly) continue
        const held = out.hold?.clipId === c.id
        if (!held && (t < c.start || t >= c.start + c.duration)) continue
        const local = held ? out.hold!.local : t - c.start
        const d: Draw = { c, local }
        if (c.assetId && pools.has(c.assetId)) {
          const at = (c.in ?? 0) + local
          let byTime = serving.get(c.assetId)
          if (!byTime) serving.set(c.assetId, (byTime = new Map()))
          // clips landing on the same source frame share one decoder, which is
          // the common case (a cut that doesn't move in time)
          let el = byTime.get(at)
          if (!el) {
            const n = taken.get(c.assetId) ?? 0
            const [got, ready] = poolAt(c.assetId, n)
            if (ready) opening.push(ready)
            el = got
            taken.set(c.assetId, n + 1)
            byTime.set(at, el)
            parked.set(el, at)
          }
          keep.add(el)
          lastUsed.set(el, useClock)
          d.el = el
        } else if (c.assetId) {
          d.el = images.get(c.assetId)
        }
        draws.push(d)
      }
    }
    // Free what this frame doesn't need BEFORE it decodes, so the surplus isn't
    // competing for decoder slots with the frame that's about to be drawn.
    evictDecoders(keep)

    const s0 = performance.now()
    // a decoder opened just now has no metadata yet; seeking it before that
    // lands is ignored, and the frame draws from an empty element
    if (opening.length) await Promise.all(opening)
    if (out.live) runLive(parked)
    else {
      // A stopped transport must not leave decoders running on: they would keep
      // advancing past the frame we are about to park them on.
      pauseAll()
      await Promise.all([...parked].map(([el, at]) => seek(el, at)))
    }
    out.lastSeekMs = performance.now() - s0

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, sceneFbo)
    gl!.useProgram(prog)
    gl!.viewport(0, 0, W, H)
    gl!.clearColor(0, 0, 0, 1)
    gl!.clear(gl!.COLOR_BUFFER_BIT)
    for (const { c, local, el } of draws) {
      // Grading is per object, so its uniforms are set per draw — and set to
      // OFF for every object that isn't graded, since a uniform left over from
      // the previous quad would grade the next one. The properties are only
      // sampled when it's on: nine samples per object per frame is a real cost
      // on a project that grades nothing, which is most of them.
      if (gradeActive(c)) {
        gl!.uniform1f(uGradeOn, 1)
        for (let i = 0; i < GRADE_PROPS.length; i++)
          gl!.uniform1f(uGrade[i], sampleClip(c, GRADE_PROPS[i].id, local))
      } else {
        gl!.uniform1f(uGradeOn, 0)
      }
      if (curvesActive(c)) {
        gl!.activeTexture(gl!.TEXTURE1)
        gl!.bindTexture(gl!.TEXTURE_2D, curveTexture(c, local))
        // back to unit 0 — everything else here binds the object's own texture
        // to whatever is active, and leaving unit 1 selected would upload the
        // next video frame over the curve
        gl!.activeTexture(gl!.TEXTURE0)
        gl!.uniform1f(uCurveOn, 1)
      } else {
        gl!.uniform1f(uCurveOn, 0)
      }
      // A LUT that hasn't loaded (project reopened, file not re-read yet) draws
      // ungraded rather than black — the clip keeps pointing at it, so it comes
      // back the moment the file does.
      const lut = c.gradeOff ? undefined : findLut(c.lutId)
      const lt = lut ? lutTexture(lut) : null
      if (lt) {
        gl!.activeTexture(gl!.TEXTURE2)
        gl!.bindTexture(gl!.TEXTURE_2D, lt)
        gl!.activeTexture(gl!.TEXTURE0)
        gl!.uniform1f(uLutOn, 1)
        gl!.uniform1f(uLutSize, lut!.size)
        gl!.uniform1f(uLutMix, sampleClip(c, 'lutMix', local))
      } else {
        gl!.uniform1f(uLutOn, 0)
      }
      const size = sizeOf(c, local, project, el)
      const p = project3(c, local, project)
      const corners = [p(size.w, size.h, 0, 0), p(size.w, size.h, 1, 0), p(size.w, size.h, 0, 1), p(size.w, size.h, 1, 1)]
      const alpha = Math.max(0, Math.min(1, sampleClip(c, 'opacity', local)))
      if (isText(c)) {
        const tt = textTexture(c, local, size.w, size.h)
        gl!.bindTexture(gl!.TEXTURE_2D, tt.tex)
        drawQuad(tt.tex, tt.canvas, alpha, corners, tt.changed)
      } else if (el) {
        let tx = tex.get(el)
        const fresh = !tx
        if (!tx) { tx = newTex(); tex.set(el, tx) }
        // A video only needs re-uploading when it is actually showing a new
        // decoded frame. `currentTime` after a seek is the frame the element
        // landed on, not what we asked for, so it catches both a second clip
        // sharing this decoder and an export running faster than the source
        // (60fps out of a 30fps proxy uploads each frame once, not twice).
        // `!filled` keeps retrying a texture whose upload was skipped for want
        // of a decoded frame — otherwise a source that wasn't ready on its first
        // frame would never be asked again.
        let needsUpload = fresh || !filled.has(tx)
        if (el instanceof HTMLVideoElement) {
          const ct = el.currentTime
          if (lastUp.get(el) !== ct) {
            lastUp.set(el, ct)
            needsUpload = true
          }
        }
        gl!.bindTexture(gl!.TEXTURE_2D, tx)
        drawQuad(tx, el, alpha, corners, needsUpload)
      }
    }
    // Draw calls only QUEUE work. The readback paths sync on `readPixels`, so
    // that cost lands in the readback phase. The WebCodecs path reads nothing
    // and `new VideoFrame(canvas)` is zero-copy, so `draw` measured 0ms however
    // heavy the scene and the GPU work resurfaced as the encoder failing to
    // drain — a multi-layer project looked exactly like a slow codec. Sync
    // here: same wait, charged to the phase that caused it.
    if (!packed && out.measure) gl!.finish()
  }

  /** Read into a caller-supplied buffer, so the export can rotate buffers and
   *  keep a frame in flight over IPC while the next one renders. */
  function readFrame(into: Uint8Array): Uint8Array {
    if (!useYuv) {
      gl!.readPixels(0, 0, W, H, gl!.RGBA, gl!.UNSIGNED_BYTE, into)
      return into
    }
    // convert the scene to planar yuv420p on the GPU, then take it in one read
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, packFbo)
    gl!.viewport(0, 0, PW, PH)
    gl!.useProgram(packProg)
    // the scene is opaque and this pass writes raw byte values, so blending
    // here would corrupt them rather than composite anything
    gl!.disable(gl!.BLEND)
    gl!.activeTexture(gl!.TEXTURE0)
    gl!.bindTexture(gl!.TEXTURE_2D, sceneTex)
    gl!.bindBuffer(gl!.ARRAY_BUFFER, packBuf)
    const aP = gl!.getAttribLocation(packProg!, 'aPos')
    gl!.enableVertexAttribArray(aP)
    gl!.vertexAttribPointer(aP, 2, gl!.FLOAT, false, 0, 0)
    gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    gl!.readPixels(0, 0, PW, PH, gl!.RGBA, gl!.UNSIGNED_BYTE, into)
    gl!.enable(gl!.BLEND)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, sceneFbo)
    gl!.useProgram(prog)
    return into
  }

  function dispose() {
    pauseAll()
    for (const t of tex.values()) gl!.deleteTexture(t)
    tex.clear()
    texSize.clear()
    filled.clear()
    for (const e of textCache.values()) gl!.deleteTexture(e.tex)
    textCache.clear()
    for (const e of curveTex.values()) gl!.deleteTexture(e.tex)
    curveTex.clear()
    for (const t of lutTex.values()) gl!.deleteTexture(t)
    lutTex.clear()
    if (sceneFbo) gl!.deleteFramebuffer(sceneFbo)
    if (packFbo) gl!.deleteFramebuffer(packFbo)
    if (sceneTex) gl!.deleteTexture(sceneTex)
    if (packTex) gl!.deleteTexture(packTex)
    if (packBuf) gl!.deleteBuffer(packBuf)
    if (packProg) gl!.deleteProgram(packProg)

    // Each <video> here owns a decoder and keeps the proxy file open. Dropping
    // the reference isn't enough — the element has to be told to let go, or
    // every export leaves its decoders alive until GC eventually notices.
    for (const p of pools.values())
      for (const el of p) {
        if (!el) continue
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
    pools.clear()
    images.clear()
    lastUp.clear()
    lastUsed.clear()
    elFps.clear()
    lastSeekIdx.clear()

    // An export makes a fresh canvas and a fresh context every time, and the
    // browser caps how many live contexts it will keep — past the limit it drops
    // the oldest, which is how a long-lived app ends up rendering through a lost
    // context. Hand it back explicitly instead of waiting to be collected.
    gl!.getExtension('WEBGL_lose_context')?.loseContext()
  }

  const out: Renderer = {
    render,
    readFrame,
    dispose,
    lastSeekMs: 0,
    live: false,
    hold: null,
    measure: true,
    pixFmt: useYuv ? 'yuv420p' : 'rgba',
    frameBytes: useYuv ? (W * H * 3) / 2 : W * H * 4,
  }
  return out
}
