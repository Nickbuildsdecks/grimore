/**
 * The board's own atmosphere: mana embers in the five colours, drifting behind the table.
 *
 * A second canvas rather than a reuse of `AmbientCanvas`, and the difference is the point. That one
 * is the app's backdrop — violet runes and sigil rings, fixed to the viewport, the same on every
 * page. This one belongs to the game: WUBRG embers at the table's own layer, so they move with the
 * board rather than under it, and they lean towards the cursor the way the spec for the Play Realm
 * asks for. A player looking at a board should be able to tell, without reading anything, that
 * this page is the game and the others are the library around it.
 *
 * Four rules keep it from costing anything a player would notice:
 *
 * - **Reduced motion means none of it.** The effect returns before allocating anything if the
 *   viewer asked for less movement, which is the same check `AmbientCanvas` makes.
 * - **It stops when nobody is looking.** A hidden tab keeps its `requestAnimationFrame` callbacks
 *   queued in some browsers and runs them at a crawl in others; either way a table left open in a
 *   background tab should not be drawing. `visibilitychange` cancels and restarts the loop.
 * - **The count is capped by width**, not by the board: a four-seat pod on a phone is the smallest
 *   screen with the most to draw, so the phone budget is the one that matters.
 * - **Nothing here is interactive.** `pointer-events-none` and `aria-hidden`, because it is a
 *   decoration: every cursor press belongs to a card underneath it, and a screen reader hearing
 *   about embers is being told about nothing.
 */
import { useEffect, useRef } from "react"

/** The five colours, as the table's own CSS already names them. Hue only — the rest is alpha. */
const MANA_HUES = [
  48, // W, the parchment gold the table uses for white
  205, // U
  278, // B, violet rather than black, because black on black is nothing
  8, // R
  128, // G
]

interface Ember {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  hue: number
  /** Peak alpha. Low on purpose: this sits under a board that has to stay readable. */
  alpha: number
  /** Where in its pulse it is, so a field of embers does not breathe in unison. */
  pulse: number
  pulseSpd: number
}

/** How far from the cursor an ember feels it, in CSS pixels. The spec's number. */
const AURA_RADIUS = 160

export function ArenaEmbers({ className }: { className?: string }) {
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
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const newEmber = (atBottom: boolean): Ember => ({
      x: Math.random() * Math.max(1, w),
      // Seeded across the whole board on the first frame and from the bottom edge afterwards, so
      // the table does not start empty and then rain upwards into view.
      y: atBottom ? h + Math.random() * 40 : Math.random() * Math.max(1, h),
      vx: (Math.random() - 0.5) * 0.14,
      vy: -(Math.random() * 0.22 + 0.06),
      size: Math.random() * 1.6 + 0.9,
      hue: MANA_HUES[Math.floor(Math.random() * MANA_HUES.length)] ?? 278,
      alpha: Math.random() * 0.16 + 0.07,
      pulse: Math.random() * Math.PI * 2,
      pulseSpd: Math.random() * 0.02 + 0.006,
    })

    const compact = window.matchMedia("(max-width: 767px)").matches
    const embers = Array.from({ length: compact ? 22 : 46 }, () => newEmber(false))

    /*
      Where the cursor is, in the canvas's own coordinates, or null when it is somewhere else.

      Tracked on the canvas's parent rather than on the canvas, because the canvas cannot receive
      pointer events — it is behind the whole board and `pointer-events-none`. The listener goes on
      `window` and converts, which also means the aura follows the cursor across a card instead of
      dying the moment it crosses one.
    */
    let mouse: { x: number; y: number } | null = null
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      mouse = x < -AURA_RADIUS || y < -AURA_RADIUS || x > r.width + AURA_RADIUS || y > r.height + AURA_RADIUS
        ? null
        : { x, y }
    }
    const onLeave = () => { mouse = null }
    window.addEventListener("pointermove", onMove, { passive: true })
    window.addEventListener("pointerleave", onLeave)

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      for (const eb of embers) {
        /*
          The magnetic half: an ember inside the aura is pulled towards the cursor, harder the
          closer it is, and the pull is added to its drift rather than replacing it — so the field
          bends around the pointer instead of collapsing into it.
        */
        if (mouse !== null) {
          const dx = mouse.x - eb.x
          const dy = mouse.y - eb.y
          const dist = Math.hypot(dx, dy)
          if (dist > 1 && dist < AURA_RADIUS) {
            const pull = (1 - dist / AURA_RADIUS) * 0.045
            eb.vx += (dx / dist) * pull
            eb.vy += (dy / dist) * pull
          }
        }
        // Friction, so a long hover cannot accelerate an ember into a streak.
        eb.vx *= 0.985
        eb.vy = eb.vy * 0.985 - 0.0012
        eb.x += eb.vx
        eb.y += eb.vy
        eb.pulse += eb.pulseSpd

        if (eb.y < -12 || eb.x < -20 || eb.x > w + 20) Object.assign(eb, newEmber(true))

        const glow = eb.alpha * (0.65 + Math.sin(eb.pulse) * 0.35)
        ctx.beginPath()
        ctx.arc(eb.x, eb.y, eb.size, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${eb.hue}, 85%, 70%, ${glow})`
        ctx.fill()
      }
      raf = requestAnimationFrame(draw)
    }

    const start = () => {
      if (raf === 0) raf = requestAnimationFrame(draw)
    }
    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }
    document.addEventListener("visibilitychange", onVisibility)
    start()

    return () => {
      stop()
      ro.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerleave", onLeave)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-testid="arena-embers"
      className={className ?? "pointer-events-none absolute inset-0 -z-10 h-full w-full"}
    />
  )
}
