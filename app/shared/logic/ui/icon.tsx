// Icon — renders a white SVG from app/shared/assets/icons as a mask so it
// inherits `color` (currentColor). Lets icons theme with CSS instead of being
// locked to white. Emoji/text icons are never used.

const urls = import.meta.glob('../../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const byName: Record<string, string> = {}
for (const path in urls) {
  const name = path.split('/').pop()!.replace('.svg', '')
  byName[name] = urls[path]
}

export type IconName = string

interface IconProps {
  name: IconName
  size?: number
  title?: string
}

export function Icon({ name, size = 20, title }: IconProps) {
  const url = byName[name]
  if (!url) {
    // Missing icon: log once so it can be added to MISSING_SVGS.md.
    if (typeof console !== 'undefined') console.warn(`[icon] missing: ${name}.svg`)
    return <span class="icon icon--missing" style={{ width: size, height: size }} title={title ?? name} />
  }
  return (
    <span
      class="icon"
      title={title}
      style={{
        width: size,
        height: size,
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
      }}
    />
  )
}
