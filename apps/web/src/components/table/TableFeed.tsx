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
 * The offset clears the control bar, which is one row on a manual table and two with the engine
 * running, and the browser suite measures the two rectangles rather than trusting the number.
 *
 * Right-aligned, for the one thing it must not cover: the card the player is about to tap. The
 * hand fills from the left on every screen size, so the right end of that row is the emptiest
 * place on the board — which a screenshot of the left-aligned version, sitting across the first
 * card's name, made obvious.
 */
import type { FeedLine } from "@/lib/useTableFeed"

export function TableFeed({ lines }: { lines: readonly FeedLine[] }) {
  if (lines.length === 0) return null
  return (
    <div
      data-testid="table-feed"
      aria-live="polite"
      className="pointer-events-none fixed bottom-[6.5rem] left-2 right-2 z-30 flex flex-col items-end gap-1"
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
