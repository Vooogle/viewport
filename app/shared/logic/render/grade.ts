// Per-object colour grading.
//
// Nine scalars, applied in the fragment shader that already draws every object,
// so grading costs a handful of uniforms and some ALU rather than a pass. They
// are ordinary animatable properties (see ANIM_PROPS) — a grade can be
// keyframed the same way position can, which is the whole reason the preview
// went through one renderer.
//
// The values live in `clip.grade`, not as flat fields, so "is anything graded
// here" is one null check. That matters: the draw loop samples every property
// of every visible object every frame, and nine more samples on every object in
// a project that grades none of them is pure cost. `gradeActive` is the gate.
import type { Clip } from '../timeline/timeline'
import { LUT_GLSL } from './lut'

/** The graded values on an object. Absent = never touched, and skipped whole. */
export interface GradeSpec {
  /** stops, 0 = untouched */
  exposure?: number
  /** -1..1 around mid grey */
  contrast?: number
  /** 0 = greyscale, 1 = untouched */
  saturation?: number
  /** -1 (cool) .. 1 (warm) */
  temperature?: number
  /** -1 (green) .. 1 (magenta) */
  tint?: number
  /** shadows offset, added in linear light */
  lift?: number
  /** midtones, 1 = untouched */
  gamma?: number
  /** highlights multiplier, 1 = untouched */
  gain?: number
}
// There is no hue scalar here on purpose. `hueR/G/B` was a constant multiply per
// channel — which is exactly a curve channel with slope 1+v, and the curve
// editor already owns per-channel pushing with handles you can see. Two controls
// doing one job, named the same thing, stacked in the same panel. The curves won
// because they can shape as well as scale; the scalars only had keyframes over
// them, and now the curves have those too.

/** A curve point, both axes 0..1. */
export type CurvePt = [number, number]
/** The four curve channels. Absent channel = identity. */
export interface CurveSpec {
  master?: CurvePt[]
  r?: CurvePt[]
  g?: CurvePt[]
  b?: CurvePt[]
}
export const CURVE_CHANNELS = ['master', 'r', 'g', 'b'] as const
export type CurveChannel = (typeof CURVE_CHANNELS)[number]
/** A channel nobody has touched: the straight line in, straight line out. */
export const IDENTITY_CURVE: CurvePt[] = [
  [0, 0],
  [1, 1],
]

/**
 * The animation channel each curve keyframes on.
 *
 * A curve is a set of points, not a number, so it can't ride the numeric
 * `AnimTrack.value` — it gets `Keyframe.pts` instead, the same way text content
 * got `Keyframe.str`. One track per channel, so R can animate while G sits
 * still.
 */
export const CURVE_ANIM = [
  { id: 'curveMaster', ch: 'master', label: 'Curve RGB' },
  { id: 'curveR', ch: 'r', label: 'Curve R' },
  { id: 'curveG', ch: 'g', label: 'Curve G' },
  { id: 'curveB', ch: 'b', label: 'Curve B' },
] as const satisfies readonly { id: string; ch: CurveChannel; label: string }[]
const CH_BY_PROP = new Map<string, CurveChannel>(CURVE_ANIM.map((c) => [c.id, c.ch]))
const PROP_BY_CH = new Map<string, string>(CURVE_ANIM.map((c) => [c.ch, c.id]))
/** animation channel id → curve channel, and back */
export const curveChannelOf = (prop: string) => CH_BY_PROP.get(prop)
export const curveAnimId = (ch: CurveChannel) => PROP_BY_CH.get(ch)!

/**
 * Blend two curves — what makes a keyframed curve actually move.
 *
 * Same number of points (the ordinary case: keyframe a curve, then drag its
 * points) means the handles interpolate one-for-one, so a point literally
 * slides from where it was to where it ends up, in both axes.
 *
 * Different counts have no such pairing — point 3 of five is not point 3 of
 * two — so the CURVES are blended instead of the points: sample both shapes at
 * every x either one has a point at, and cross-fade the heights. The result
 * passes through both endpoints exactly, so at f=0 and f=1 you get back what
 * you drew, and in between the line morphs rather than jumping.
 */
export function lerpCurves(a: CurvePt[], b: CurvePt[], f: number): CurvePt[] {
  if (f <= 0) return a
  if (f >= 1) return b
  if (a.length === b.length)
    return a.map(([ax, ay], i) => [ax + (b[i][0] - ax) * f, ay + (b[i][1] - ay) * f] as CurvePt)
  const fa = curveFn(a)
  const fb = curveFn(b)
  const xs = [...new Set([...a, ...b].map(([x]) => Math.round(x * 1e4) / 1e4))].sort((p, q) => p - q)
  return xs.map((x) => [x, fa(x) + (fb(x) - fa(x)) * f] as CurvePt)
}

export interface GradeProp {
  id: keyof GradeSpec
  label: string
  min: number
  max: number
  default: number
}

/**
 * The registry. Order is the order they apply in and the order they're shown
 * in — exposure and white balance first (they describe the capture), then the
 * tonal controls, then hue and saturation.
 */
export const GRADE_PROPS: GradeProp[] = [
  { id: 'exposure', label: 'Exposure', min: -5, max: 5, default: 0 },
  { id: 'temperature', label: 'Temperature', min: -1, max: 1, default: 0 },
  { id: 'tint', label: 'Tint', min: -1, max: 1, default: 0 },
  { id: 'lift', label: 'Lift', min: -0.5, max: 0.5, default: 0 },
  { id: 'gamma', label: 'Gamma', min: 0.1, max: 4, default: 1 },
  { id: 'gain', label: 'Gain', min: 0, max: 4, default: 1 },
  { id: 'contrast', label: 'Contrast', min: -1, max: 1, default: 0 },
  { id: 'saturation', label: 'Saturation', min: 0, max: 3, default: 1 },
]

/** id → default, for the sampler's fallback */
export const GRADE_DEFAULTS: Record<string, number> = Object.fromEntries(
  GRADE_PROPS.map((p) => [p.id, p.default]),
)
const GRADE_IDS = new Set<string>(GRADE_PROPS.map((p) => p.id))
/** true if `prop` is one of the grading scalars */
export const isGradeProp = (prop: string) => GRADE_IDS.has(prop)

/**
 * Is this object graded at all?
 *
 * False for the overwhelming majority of objects, and the draw loop leans on
 * that: no sampling, no uniforms, one branch in the shader. Keyframes count
 * even with no static values, since animating a property from its default is a
 * perfectly ordinary thing to do. The bypass wins over both — that's what it's
 * for, and it has to be free to be worth having.
 */
export function gradeActive(c: Clip): boolean {
  if (c.gradeOff) return false
  if (c.grade) for (const k in c.grade) if (GRADE_IDS.has(k)) return true
  if (c.anim) for (const k in c.anim) if (GRADE_IDS.has(k)) return true
  return false
}

/** A channel that isn't a straight line from (0,0) to (1,1). */
function bent(pts?: CurvePt[]): boolean {
  if (!pts || pts.length < 2) return false
  return pts.some(([x, y]) => Math.abs(x - y) > 1e-4) || pts.length > 2
}
/**
 * Does this object have a curve worth uploading?
 *
 * Keyframes count even with no static curve, exactly as they do for the
 * scalars: animating a channel from identity is the ordinary way to dissolve a
 * curve on, and skipping it because the static field is empty would draw the
 * whole animation as nothing.
 */
export function curvesActive(c: Clip): boolean {
  if (c.gradeOff) return false
  if (c.curves && CURVE_CHANNELS.some((k) => bent(c.curves![k]))) return true
  return !!c.anim && CURVE_ANIM.some((x) => c.anim![x.id]?.keys.length)
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson) through the control points.
 *
 * Not a natural cubic spline, which overshoots: two points close in x with
 * different y make a natural spline swing outside the range it was given, and
 * on a tone curve that reads as a bright halo where the user drew a smooth
 * ramp. This one cannot overshoot by construction — the price is that it isn't
 * C², which nobody can see.
 */
export function curveFn(pts: CurvePt[]): (x: number) => number {
  const p = [...pts].sort((a, b) => a[0] - b[0])
  const n = p.length
  if (n === 0) return (x) => x
  if (n === 1) return () => p[0][1]
  // secant slopes, then per-point tangents limited to keep it monotone
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1][0] - p[i][0]
    d.push(dx > 1e-9 ? (p[i + 1][1] - p[i][1]) / dx : 0)
  }
  const m: number[] = [d[0]]
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = (3 / Math.sqrt(s)) * d[i]
      m[i] = t * a
      m[i + 1] = t * b
    }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1]
    if (x >= p[n - 1][0]) return p[n - 1][1]
    let i = 0
    while (i < n - 2 && x > p[i + 1][0]) i++
    const h = p[i + 1][0] - p[i][0]
    const t = (x - p[i][0]) / h
    const t2 = t * t
    const t3 = t2 * t
    // Hermite basis
    return (
      (2 * t3 - 3 * t2 + 1) * p[i][1] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * p[i + 1][1] +
      (t3 - t2) * h * m[i + 1]
    )
  }
}

/**
 * Bake a curve set into 256 RGB texels: what each input level becomes.
 *
 * The per-channel curve and the master are composed here rather than in the
 * shader, so grading with curves costs the same one texture fetch per channel
 * however many of them are drawn on.
 */
export function buildCurveLut(spec: CurveSpec): Uint8Array {
  const master = bent(spec.master) ? curveFn(spec.master!) : null
  const per = { r: bent(spec.r) ? curveFn(spec.r!) : null, g: bent(spec.g) ? curveFn(spec.g!) : null, b: bent(spec.b) ? curveFn(spec.b!) : null }
  const out = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    for (let ch = 0; ch < 3; ch++) {
      const f = per[(['r', 'g', 'b'] as const)[ch]]
      let v = f ? f(x) : x
      if (master) v = master(v)
      out[i * 3 + ch] = Math.max(0, Math.min(255, Math.round(v * 255)))
    }
  }
  return out
}

/**
 * The grading half of the object fragment shader.
 *
 * Tonal work happens in linear light, which is where exposure and lift/gamma/
 * gain mean what they say — the same operations on gamma-encoded values pull
 * the midtones around in ways that look like a mistake. Contrast, hue and
 * saturation are deliberately NOT linear: they are perceptual controls, and
 * doing them in display space is what makes a contrast slider behave the way
 * everyone expects it to.
 *
 * `uGradeOn` is a uniform, so the branch is coherent across the whole draw —
 * ungraded objects pay for the compare and nothing else.
 */
const GRADE_CORE_GLSL = `
uniform float uGradeOn;
uniform float uExposure, uContrast, uSaturation, uTemperature, uTint;
uniform float uLift, uGamma, uGain;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 toLinear(vec3 c){ return pow(max(c, 0.0), vec3(2.2)); }
vec3 toDisplay(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }

uniform float uCurveOn;
uniform sampler2D uCurve;

/** Tone curves, as one fetch per channel of a 256-texel bake. */
vec3 applyCurves(vec3 c){
  if (uCurveOn < 0.5) return c;
  // texel CENTRES: sampling at the raw value lands half a texel low, which
  // shows up as a curve that never quite reaches white
  vec3 x = (clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  return vec3(
    texture2D(uCurve, vec2(x.r, 0.5)).r,
    texture2D(uCurve, vec2(x.g, 0.5)).g,
    texture2D(uCurve, vec2(x.b, 0.5)).b);
}

vec3 gradeScalars(vec3 c){
  vec3 lin = toLinear(c);
  lin *= exp2(uExposure);
  // White balance as a channel scale: warm lifts red and drops blue, tint
  // trades green against the other two. Gentle coefficients — this is a
  // correction control, not a colour wheel.
  lin.r *= 1.0 + uTemperature * 0.30;
  lin.b *= 1.0 - uTemperature * 0.30;
  lin.g *= 1.0 - uTint * 0.30;
  lin.r *= 1.0 + uTint * 0.15;
  lin.b *= 1.0 + uTint * 0.15;
  // lift / gamma / gain, in that order — shadows, midtones, highlights
  lin = lin * uGain + uLift;
  lin = pow(max(lin, 0.0), vec3(1.0 / max(uGamma, 0.01)));

  vec3 d = toDisplay(lin);
  d = (d - 0.5) * (1.0 + uContrast) + 0.5;
  d = mix(vec3(dot(d, LUMA)), d, uSaturation);
  return clamp(d, 0.0, 1.0);
}
`

/**
 * The whole colour chain, in the order a shader can compile it: helpers first,
 * then the LUT (which the entry point calls), then the entry point.
 *
 * GLSL ES has no forward declarations — every function must appear before it is
 * used — so this is assembled here rather than concatenated by the renderer,
 * where the order would look arbitrary and break the first time someone tidied
 * the imports.
 */
export const GRADE_GLSL = `${GRADE_CORE_GLSL}
${LUT_GLSL}
/** scalars → curves → LUT: the correction, then the shaping, then the look. */
vec3 grade(vec3 c){
  vec3 d = uGradeOn < 0.5 ? c : gradeScalars(c);
  return applyLut(applyCurves(d));
}
`
