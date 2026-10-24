/**
 * What just happened, on the board rather than behind a button.
 *
 * `aria-live` rather than a decoration: the same lines a sighted player reads are the ones a screen
 * reader should announce, and the table already has the text. `pointer-events-none` for the same
 * reason the combat overlay has it — this sits over the board, and a card underneath must stay
 * tappable while somebody is reading about the last one.
 *
 * Fixed to the viewport rather than to the board, which the first version got wrong and a
 * screenshot caught: the board is a column taller than the screen, so `absolute bottom-*` put the
 * line at the bottom of the *document*, several hundred pixels below anything a player could see.
 *
 * Right-aligned, for the one thing it must not cover: the card the player is about to tap. The
 * hand fills from the left on every screen size, so the right end of that row is the emptiest
 * place on the board — which a screenshot of the left-aligned version, sitting across the first
 * card's name, made obvious.
 */
import { useEffect, useRef, useState } from "react"
import type { FeedLine } from "@/lib/useTableFeed"

/** The bar at the bottom of the table, whichever of the two this table has. */
const controlBar = (): Element | null =>
  document.querySelector('[data-testid="arena-bar"], [data-testid="controls"]')

/**
 * How far off the bottom to sit: just above the control bar, measured rather than guessed.
 *
 * It used to be a constant — `bottom-[6.5rem]`, chosen to clear a bar that is one row on a manual
 * table and two with the engine running. On a phone the engine's bar is 111px, the constant was
 * 104, and the feed sat across the bottom of it: three lines of "Opponent III mulliganed to 6"
 * over the top of "Keep this hand, or mulligan?". The suite that was written to catch exactly
 * that had been measuring the two rectangles at desktop width, where the numbers happen to work.
 *
 * So the same answer the combat overlay reached for the same reason: the layout is the layout's
 * business, and the only way to know where the bar is is to ask it.
 */
function useClearOfTheBar(lines: number): number {
  const [bottom, setBottom] = useState(104)
  const latest = useRef(bottom)
  latest.current = bottom
  useEffect(() => {
    const read = (): void => {
      const bar = controlBar()
      const next = bar === null
        ? 104
        : Math.max(8, Math.round(window.innerHeight - bar.getBoundingClientRect().top) + 8)
      // Idempotent on purpose. `ResizeObserver` fires on every layout pass, and a `setState` that
      // always sets is a re-render that resizes something, which is how the combat overlay once
      // produced seven thousand React warnings in a single game.
      if (next !== latest.current) setBottom(next)
    }
    read()
    const bar = controlBar()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read)
    if (observer !== null && bar !== null) observer.observe(bar)
    window.addEventListener("resize", read)
    window.addEventListener("scroll", read, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", read)
      window.removeEventListener("scroll", read, true)
    }
  }, [lines])
  return bottom
}

export function TableFeed({ lines }: { lines: readonly FeedLine[] }) {
  const bottom = useClearOfTheBar(lines.length)
  if (lines.length === 0) return null
  return (
    <div
      data-testid="table-feed"
      aria-live="polite"
      className="pointer-events-none fixed left-2 right-2 z-30 flex flex-col items-end gap-1"
      style={{ bottom }}
    >
      {lines.map((line) => (
        <p
          key={line.key}
          data-testid="feed-line"
          className="max-w-full truncate rounded-md border border-white/10 bg-black/70 px-2 py-1 text-xs text-[var(--g-text-high)] shadow-lg backdrop-blur-sm"
        >
          {line.text}
        </p>
      ))}
    </div>
  )
}
