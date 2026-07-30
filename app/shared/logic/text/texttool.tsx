// Text tool: create a text object and style it. Unlike the Properties tool
// (plain rows), this is the stylised editor — content, font, fill, size,
// spacing, align, style, curve, warp, background, outline. Binds to the selected
// text object; edits go straight onto its TextSpec.
import type { ComponentChildren } from 'preact'
import { Icon } from '../ui/icon'
import {
  selectedClipId,
  findClip,
  addText,
  patchText,
  snapshot,
  isText,
  type TextSpec,
  type TextAlign,
} from '../timeline/timeline'
import { FontPicker } from './fonts'
import { applyProp, sampleClip, setTextContent, editableText, animatingClipId, animPlayhead } from '../timeline/anim'

const ALIGNS: [TextAlign, string][] = [
  ['left', 'format_align_left'],
  ['center', 'format_align_center'],
  ['right', 'format_align_right'],
  ['justify', 'format_align_justify'],
]

// --- little building blocks (match the stylised mockup) ---
function Field({ label, children, right }: { label: string; children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="txt-field">
      <div class="txt-field__head">
        <span class="txt-field__label">{label}</span>
        {right}
      </div>
      {children}
    </div>
  )
}
function Slider({ label, value, min, max, step = 1, onInput }: {
  label: string; value: number; min: number; max: number; step?: number; onInput: (v: number) => void
}) {
  return (
    <Field label={label} right={<span class="txt-field__val">{Math.round(value * 100) / 100}</span>}>
      <input
        class="txt-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => snapshot()}
        onInput={(e) => onInput(+(e.target as HTMLInputElement).value)}
      />
    </Field>
  )
}
function Swatch({ value, onInput }: { value: string; onInput: (v: string) => void }) {
  return (
    <label class="txt-swatch" style={{ background: value }}>
      <input type="color" value={value} onPointerDown={() => snapshot()} onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
    </label>
  )
}
// section with an on/off switch (Curve / Warp / Background / Outline)
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button class={'txt-switch' + (on ? ' is-on' : '')} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span class="txt-switch__knob" />
    </button>
  )
}

export function TextTool() {
  const id = selectedClipId.value
  const f = id ? findClip(id) : null
  const clip = f && isText(f.clip) ? f.clip : null
  const t = clip?.text

  const patch = (p: Partial<TextSpec>) => clip && patchText(clip.id, p, false)
  const setBg = (p: Partial<TextSpec['bg']>) => t && patch({ bg: { ...t.bg, ...p } })
  const setOutline = (p: Partial<TextSpec['outline']>) => t && patch({ outline: { ...t.outline, ...p } })
  // animatable numeric props go through applyProp: keyframes at the playhead
  // while animating this object, else writes the static value. `av` shows the
  // value at the playhead while animating.
  const animating = !!clip && animatingClipId.value === clip.id
  const av = (prop: string, stat: number) => (animating && clip ? sampleClip(clip, prop, animPlayhead.value) : stat)
  const setNum = (prop: string) => (v: number) => clip && applyProp(clip.id, prop, v, false)

  return (
    <div class="txt">
      <button class="txt-add" onClick={() => addText()}>
        <Icon name="text_fields" size={16} /> Add text
      </button>

      {!t ? (
        <div class="txt-empty">Select a text object, or add one.</div>
      ) : (
        <div class="txt-body">
          <Field label="Text">
            <textarea
              class="txt-area"
              rows={3}
              // the content channel owns the string while animating; the static
              // field doesn't move, so binding to it fought every keystroke
              value={animating && clip ? editableText(clip, animPlayhead.value) : t.content}
              onFocus={() => snapshot()}
              onInput={(e) => clip && setTextContent(clip.id, (e.target as HTMLTextAreaElement).value, false)}
            />
          </Field>

          <Field label="Font">
            <FontPicker value={t.font} onPick={(font) => { snapshot(); patch({ font }) }} />
          </Field>

          <Field label="Fill" right={<Swatch value={t.fill} onInput={(fill) => patch({ fill })} />}>
            <div />
          </Field>

          <Slider label="Size" value={av('size', t.size)} min={4} max={600} onInput={setNum('size')} />
          <Slider label="Line spacing" value={av('lineSpacing', t.lineSpacing)} min={-40} max={200} onInput={setNum('lineSpacing')} />
          <Slider label="Letter spacing" value={av('letterSpacing', t.letterSpacing)} min={-20} max={80} onInput={setNum('letterSpacing')} />

          <Field label="Align">
            <div class="txt-seg">
              {ALIGNS.map(([a, icon]) => (
                <button key={a} class={'txt-seg__btn' + (t.align === a ? ' is-on' : '')} onClick={() => { snapshot(); patch({ align: a }) }}>
                  <Icon name={icon} size={16} />
                </button>
              ))}
            </div>
          </Field>

          <Field label="Style">
            <div class="txt-seg">
              <button class={'txt-seg__btn' + (t.caps ? ' is-on' : '')} title="Uppercase" onClick={() => { snapshot(); patch({ caps: !t.caps }) }}>
                <Icon name="format_size" size={16} />
              </button>
              <button class={'txt-seg__btn' + (t.italic ? ' is-on' : '')} title="Italic" onClick={() => { snapshot(); patch({ italic: !t.italic }) }}>
                <Icon name="format_italic" size={16} />
              </button>
              <button class={'txt-seg__btn' + (t.bold ? ' is-on' : '')} title="Bold" onClick={() => { snapshot(); patch({ bold: !t.bold }) }}>
                <Icon name="format_bold" size={16} />
              </button>
              <button class={'txt-seg__btn' + (t.underline ? ' is-on' : '')} title="Underline" onClick={() => { snapshot(); patch({ underline: !t.underline }) }}>
                <Icon name="format_underlined" size={16} />
              </button>
            </div>
          </Field>

          <Field label="Curve" right={<Toggle on={t.curve !== 0} onChange={(v) => { snapshot(); patch({ curve: v ? 40 : 0 }) }} />}>
            {t.curve !== 0 && <Slider label="Amount" value={av('curve', t.curve)} min={-100} max={100} onInput={setNum('curve')} />}
          </Field>

          <Field label="Warp" right={<Toggle on={t.warp !== 0} onChange={(v) => { snapshot(); patch({ warp: v ? 40 : 0 }) }} />}>
            {t.warp !== 0 && <Slider label="Amount" value={av('warp', t.warp)} min={-100} max={100} onInput={setNum('warp')} />}
          </Field>

          <Field label="Background" right={<Toggle on={t.bg.on} onChange={(v) => { snapshot(); setBg({ on: v }) }} />}>
            {t.bg.on && (
              <div class="txt-sub">
                <Field label="Color" right={<Swatch value={t.bg.color} onInput={(color) => setBg({ color })} />}><div /></Field>
                <Slider label="Padding" value={av('bgPadding', t.bg.padding)} min={0} max={120} onInput={setNum('bgPadding')} />
                <Slider label="Radius" value={av('bgRadius', t.bg.radius)} min={0} max={120} onInput={setNum('bgRadius')} />
              </div>
            )}
          </Field>

          <Field label="Outline" right={<Toggle on={t.outline.on} onChange={(v) => { snapshot(); setOutline({ on: v }) }} />}>
            {t.outline.on && (
              <div class="txt-sub">
                <Field label="Color" right={<Swatch value={t.outline.color} onInput={(color) => setOutline({ color })} />}><div /></Field>
                <Slider label="Width" value={av('outlineWidth', t.outline.width)} min={0} max={40} onInput={setNum('outlineWidth')} />
              </div>
            )}
          </Field>
        </div>
      )}
    </div>
  )
}
