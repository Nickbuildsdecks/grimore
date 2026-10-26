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
import { targetName } from "@/lib/arena"
import type { GameView } from "@grimore/rules-engine"

export interface StackPanelProps {
  view: GameView
  /**
   * Stack object ids that are a legal target right now, for a counterspell being aimed.
   *
   * Without this the stack would be the one part of the board a spell cannot be pointed at: in
   * Arena mode it is drawn as a list rather than as cards, so there is no card face to tap.
   */
  targetable?: ReadonlySet<string>
  /**
   * What the player tapped, and which kind of `Target` it is.
   *
   * The kind comes from here rather than from the caller because this is where it is known: a
   * spell on the stack is a card and an ability is not, and the row already says which it is.
   */
  onPick?: (id: string, kind: "card" | "ability") => void
}

export function StackPanel({ view, targetable, onPick }: StackPanelProps) {
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
          {[...stack].reverse().map((object, index) => {
            const canTarget = targetable?.has(object.id) === true
            return (
            <li
              key={object.id}
              data-testid={`stack-${object.id}`}
              {...(canTarget
                ? {
                  role: "button",
                  tabIndex: 0,
                  onClick: () => onPick?.(object.id, object.kind === "spell" ? "card" : "ability"),
                }
                : {})}
              className={cn(
                "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded px-1.5 py-1 text-xs",
                // The top of the stack is the one about to resolve, so it is the one lit.
                index === 0 ? "bg-[var(--g-gold-400)]/15 ring-1 ring-[var(--g-gold-400)]/40" : "bg-white/5",
                canTarget && "cursor-pointer ring-2 ring-[var(--g-status-info)]",
              )}
            >
              {canTarget ? (
                <span
                  data-testid={`target-stack-${object.id}`}
                  className="rounded bg-[var(--g-status-info)] px-1 text-[9px] font-bold uppercase text-black"
                >
                  target
                </span>
              ) : null}
              {index === 0 ? (
                <span className="rounded bg-[var(--g-gold-400)] px-1 text-[9px] font-bold uppercase text-black">
                  next
                </span>
              ) : null}
              <span className="font-medium text-[var(--g-text-high)]">{object.description}</span>
              {object.targets.length > 0 ? (
                <span className="text-[var(--g-text-muted)]">
                  {/*
                    Each target with its share, for a spell that divided a quantity among them
                    (CR 601.2d). Public on purpose: the division is announced as the spell is cast
                    and cannot be changed, so the player deciding whether to answer it is entitled
                    to see whether all three damage is coming at one creature.
                  */}
                  &rarr; {object.targets.map((t, i) => {
                    const share = object.division?.[i]
                    return `${targetName(view, t)}${share === undefined ? "" : ` (${share})`}`
                  }).join(", ")}
                </span>
              ) : null}
              <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--g-text-muted)]">
                {object.controller === view.seat ? "yours" : (view.seats[object.controller]?.name ?? "theirs")}
                {object.kind === "spell" ? "" : ` · ${object.kind}`}
              </span>
            </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
