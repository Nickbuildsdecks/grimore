import { useEffect, useRef } from "react"

/* The original Grimore atmosphere: violet runes and sigil rings with
   cyber-gold sparks. Ported from the legacy canvas renderer. */

const RUNE_CHARS = ["ᚠ","ᚢ","ᚦ","ᚨ","ᚱ","ᚲ","ᚷ","ᚹ","ᚺ","ᚾ","ᛁ","ᛃ","ᛇ","ᛈ","ᛉ","ᛊ","ᛏ","ᛒ","ᛖ","ᛗ","ᛚ","ᛜ","ᛞ","ᛟ"]
const MTG_SYMBOLS = ["⬡","⬢","◈","⧖","⊕","⊗","⊘","⊙","✦","✧","❋"]

interface Rune {
  x: number; y: number; char: string; size: number
  alpha: number; maxAlpha: number; phase: "in" | "hold" | "out"
  fadeSpd: number; hold: number; hue: number
  drift: number; bob: number; bobSpd: number
}

interface Ember {
  x: number; y: number; vx: number; vy: number
  size: number; alpha: number; hue: number; life: number; decay: number
}

export function AmbientCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let w = 0
    let h = 0
    let raf = 0

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const newRune = (): Rune => ({
      x: Math.random() * w,
      y: Math.random() * h,
      char: (Math.random() < 0.7 ? RUNE_CHARS : MTG_SYMBOLS)[
        Math.floor(Math.random() * (Math.random() < 0.7 ? RUNE_CHARS.length : MTG_SYMBOLS.length))
      ] ?? "✦",
      size: Math.random() * 10 + 10,
      alpha: 0,
      maxAlpha: Math.random() * 0.3 + 0.3,
      phase: "in",
      fadeSpd: Math.random() * 0.0025 + 0.001,
      hold: Math.random() * 300 + 180,
      hue: 270 + Math.random() * 28,
      drift: (Math.random() - 0.5) * 0.12,
      bob: Math.random() * Math.PI * 2,
      bobSpd: Math.random() * 0.008 + 0.003,
    })

    const newEmber = (): Ember => ({
      x: Math.random() * w,
      y: h + Math.random() * 50,
      vx: (Math.random() - 0.5) * 0.15,
      vy: -(Math.random() * 0.35 + 0.15),
      size: Math.random() * 1.2 + 0.6,
      alpha: Math.random() * 0.22 + 0.08,
      hue: 36 + Math.random() * 14,
      life: 1,
      decay: Math.random() * 0.0012 + 0.0004,
    })

    const compact = window.matchMedia("(max-width: 767px)").matches
    const runes = Array.from({ length: compact ? 14 : 24 }, newRune)
    const embers = Array.from({ length: compact ? 28 : 60 }, newEmber)
    const circles = [
      { rot: 0, baseR: 0.32, speed: 0.0009, dir: 1, alpha: 0.5, dash: [6, 14], hue: 276 },
      { rot: 0, baseR: 0.2, speed: 0.0015, dir: -1, alpha: 0.36, dash: [3, 22], hue: 292 },
      { rot: 0, baseR: 0.44, speed: 0.0005, dir: 1, alpha: 0.25, dash: [12, 30], hue: 265 },
    ].slice(0, compact ? 2 : 3)

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2

      circles.forEach((c) => {
        c.rot += c.speed * c.dir
        const r = Math.min(w, h) * c.baseR
        ctx.save()
        ctx.strokeStyle = `hsla(${c.hue},70%,60%,${c.alpha * 0.35})`
        ctx.lineWidth = 1.2
        ctx.setLineDash(c.dash)
        ctx.lineDashOffset = -c.rot * r
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      })

      ctx.save()
      runes.forEach((rn) => {
        rn.x += rn.drift
        rn.bob += rn.bobSpd
        const bobY = Math.sin(rn.bob) * 1.8

        if (rn.phase === "in") {
          rn.alpha += rn.fadeSpd
          if (rn.alpha >= rn.maxAlpha) {
            rn.alpha = rn.maxAlpha
            rn.phase = "hold"
          }
        } else if (rn.phase === "hold") {
          rn.hold--
          if (rn.hold <= 0) rn.phase = "out"
        } else {
          rn.alpha -= rn.fadeSpd
          if (rn.alpha <= 0) Object.assign(rn, newRune())
        }

        if (rn.x < -40) rn.x = w + 20
        if (rn.x > w + 40) rn.x = -20

        ctx.font = `${rn.size}px 'Fira Code', monospace`
        ctx.fillStyle = `hsla(${rn.hue},70%,72%,${rn.alpha * 0.5})`
        ctx.textAlign = "center"
        ctx.fillText(rn.char, rn.x, rn.y + bobY)
      })
      ctx.restore()

      embers.forEach((eb) => {
        eb.x += eb.vx
        eb.y += eb.vy
        eb.life -= eb.decay
        if (eb.life <= 0 || eb.y < -10) Object.assign(eb, newEmber())
        ctx.fillStyle = `hsla(${eb.hue}, 80%, 75%, ${eb.alpha * eb.life})`
        ctx.fillRect(eb.x, eb.y, eb.size, eb.size)
      })

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={className ?? "pointer-events-none fixed inset-0 -z-10 h-full w-full"}
    />
  )
}
