/**
 * What tapping a card offers on an automated table.
 *
 * The legal plays come first and are the only thing most turns need: cast it, play it, activate
 * that ability. They are the engine's own list, so a play shown here is one the engine will accept,
 * and an ability missing from it is one the player genuinely cannot use right now.
 *
 * Underneath, collapsed, are the manual tabletop moves. They are not a fallback for a bug — they
 * are the design: no card pool is fully scripted, and a game that stops because a card does
 * something the engine cannot express is worse than a game where you move that card by hand. The
 * log records both kinds of move the same way, so the table stays auditable either way.
 */
import { useState } from "react"
import { Sparkles, Wrench } from "lucide-react"
import type { LegalPlay, VisibleCard } from "@grimore/rules-engine"
import { Button } from "@/components/ui/button"
import { CardFace } from "@/components/table/CardFace"
import { targetsWanted } from "@/lib/arena"

export interface PlaySheetProps {
  card: VisibleCard
  plays: readonly LegalPlay[]
  /** Set when this seat owes a discard, which makes "Discard" the obvious move for a card in hand. */
  mustDiscard: number
  onPlay: (play: LegalPlay) => void
  onDiscard: () => void
  /** The manual move menu, rendered under a disclosure. */
  manual: React.ReactNode
  onClose: () => void
}

export function PlaySheet({ card, plays, mustDiscard, onPlay, onDiscard, manual, onClose }: PlaySheetProps) {
  const [showManual, setShowManual] = useState(false)
  const name = card.card?.name ?? "this card"

  return (
    <div
      data-testid="play-sheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88dvh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-xl border border-white/10 bg-[var(--g-surface-raised)] p-4 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3">
          <CardFace card={card} size="large" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold text-[var(--g-text-high)]">{name}</h2>
            <p className="text-xs text-[var(--g-text-muted)]">{card.card?.typeLine}</p>
            {card.power !== undefined ? (
              <p className="text-xs text-[var(--g-text-muted)]">
                Currently {card.power}/{card.toughness}
                {(card.damage ?? 0) > 0 ? `, ${card.damage} damage marked` : ""}
              </p>
            ) : null}
            {card.keywords !== undefined && card.keywords.length > 0 ? (
              <p className="text-xs text-[var(--g-text-muted)]">{card.keywords.join(", ")}</p>
            ) : null}
          </div>
        </div>

        {mustDiscard > 0 && card.zone === "hand" ? (
          <Button data-testid="play-discard" onClick={onDiscard}>
            Discard {name}
          </Button>
        ) : null}

        {plays.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--g-text-muted)]">
              <Sparkles className="size-3" /> You can
            </h3>
            {plays.map((play, index) => (
              <Button
                key={`${play.kind}-${play.abilityIndex ?? index}`}
                data-testid={`play-${play.kind}-${play.abilityIndex ?? 0}`}
                className="justify-start"
                onClick={() => onPlay(play)}
              >
                <span className="truncate">{play.description}</span>
                {play.manaCost ? <span className="ml-auto font-mono text-xs opacity-80">{play.manaCost}</span> : null}
                {targetsWanted(play) > 0 ? (
                  <span className="ml-1 text-[10px] uppercase opacity-70">needs a target</span>
                ) : null}
              </Button>
            ))}
          </div>
        ) : (
          <p data-testid="no-plays" className="text-xs text-[var(--g-text-muted)]">
            Nothing you can do with {name} right now.
          </p>
        )}

        <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="toggle-manual"
            className="justify-start text-xs"
            onClick={() => setShowManual((v) => !v)}
          >
            <Wrench className="size-3.5" /> {showManual ? "Hide" : "Move by hand"}
          </Button>
          {showManual ? (
            <>
              <p className="px-1 text-[10px] leading-snug text-[var(--g-text-muted)]">
                For anything the engine does not script. The move is logged like any other, so the
                table can still be audited afterwards.
              </p>
              {manual}
            </>
          ) : null}
        </div>

        <Button variant="ghost" data-testid="play-sheet-close" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}
