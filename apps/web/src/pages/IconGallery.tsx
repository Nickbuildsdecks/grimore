import { useState } from "react"
import { GRIMORE_ICONS, type GrimoreIconName } from "@/icons"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const WEIGHTS = [1.5, 1.75, 2] as const
const TONES = [
  { label: "Foreground", cls: "text-foreground" },
  { label: "Brass", cls: "text-brass-bright" },
  { label: "Arcane", cls: "text-arcane-bright" },
  { label: "Muted", cls: "text-muted-foreground" },
] as const

export function IconGallery() {
  const [weight, setWeight] = useState<(typeof WEIGHTS)[number]>(1.75)
  const [tone, setTone] = useState<(typeof TONES)[number]>(TONES[1])
  const [animate, setAnimate] = useState(true)
  const [twoTone, setTwoTone] = useState(true)

  return (
    <div className="page-wrap">
      <PageHeader
        title="Grimore Icons"
        description="The wizard's cookbook set. Stroke icons on a 24px grid, styled with Tailwind like any lucide icon."
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          {WEIGHTS.map((w) => (
            <Button key={w} size="sm" variant={weight === w ? "default" : "ghost"} onClick={() => setWeight(w)}>
              {w}
            </Button>
          ))}
        </div>
        <Button size="sm" variant={animate ? "default" : "secondary"} onClick={() => setAnimate((v) => !v)}>
          {animate ? "Animating" : "Animate"}
        </Button>
        <Button size="sm" variant={twoTone ? "default" : "secondary"} onClick={() => setTwoTone((v) => !v)}>
          {twoTone ? "Two-tone" : "Mono"}
        </Button>
        <div className="flex items-center gap-1 rounded-lg border border-border p-1">
          {TONES.map((t) => (
            <Button key={t.label} size="sm" variant={tone.label === t.label ? "default" : "ghost"} onClick={() => setTone(t)}>
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {(Object.keys(GRIMORE_ICONS) as GrimoreIconName[]).map((name) => {
          const Icon = GRIMORE_ICONS[name]
          return (
            <figure
              key={name}
              className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card/60 p-5 backdrop-blur transition-colors hover:border-brass/30"
            >
              <span className={cn("flex h-16 w-16 items-center justify-center", tone.cls, twoTone && "gi-accent-arcane")}>
                <Icon size={40} strokeWidth={weight} animated={animate || "hover"} />
              </span>
              <div className={cn("flex items-center gap-3 text-muted-foreground", twoTone && "gi-accent-arcane")}>
                <Icon size={24} strokeWidth={weight} animated={animate || "hover"} />
                <Icon size={16} strokeWidth={weight} animated={animate || "hover"} />
              </div>
              <figcaption className="font-mono text-xs text-muted-foreground">{name}</figcaption>
            </figure>
          )
        })}
      </div>
    </div>
  )
}
