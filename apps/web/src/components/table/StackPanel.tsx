/**
 * The stack, top first.
 *
 * Drawn as a list rather than as cards in a zone, for two reasons. An ability on the stack has no
 * card at all — it is a thing a permanent is doing — so a row of card faces could not show it. And
 * what matters about an object waiting to resolve is what it will do and to what, which is text,
 * not artwork.
 *
 * Top first because that is the order it resolves in, and "what happens next" is the only question
 * anybody asks of the stack.
 */
import { cn } from "@/lib/utils"
import type { GameView } from "@grimore/rules-engine"

/** What a target is, in words, for the "→" part of a stack row. */
function targetLabel(view: GameView, target: { kind: string; id?: string; seat?: number }): string {
  if (target.kind === "player") {
    const seat = target.seat ?? 0
    return seat === view.seat ? "you" : (view.seats[seat]?.name ?? `seat ${seat}`)
  }
  const card = target.id === undefined ? undefined : view.cards[target.id]
  return card?.card?.name ?? "something"
}

export function StackPanel({ view }: { view: GameView }) {
  const stack = view.automation?.stack ?? []

  return (
    <section data-testid="stack-panel" className="flex flex-col gap-1 rounded-md border border-white/10 p-1.5">
      <h2 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">
        The stack {stack.length > 0 ? `(${stack.length})` : ""}
      </h2>
      {stack.length === 0 ? (
        <p data-testid="stack-empty" className="px-0.5 py-1 text-xs text-[var(--g-text-muted)]">
          Nothing waiting to resolve.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {[...stack].reverse().map((object, index) => (
            <li
              key={object.id}
              data-testid={`stack-${object.id}`}
              className={cn(
                "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded px-1.5 py-1 text-xs",
                // The top of the stack is the one about to resolve, so it is the one lit.
                index === 0 ? "bg-[var(--g-gold-400)]/15 ring-1 ring-[var(--g-gold-400)]/40" : "bg-white/5",
              )}
            >
              {index === 0 ? (
                <span className="rounded bg-[var(--g-gold-400)] px-1 text-[9px] font-bold uppercase text-black">
                  next
                </span>
              ) : null}
              <span className="font-medium text-[var(--g-text-high)]">{object.description}</span>
              {object.targets.length > 0 ? (
                <span className="text-[var(--g-text-muted)]">
                  &rarr; {object.targets.map((t) => targetLabel(view, t)).join(", ")}
                </span>
              ) : null}
              <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--g-text-muted)]">
                {object.controller === view.seat ? "yours" : (view.seats[object.controller]?.name ?? "theirs")}
                {object.kind === "spell" ? "" : ` · ${object.kind}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
