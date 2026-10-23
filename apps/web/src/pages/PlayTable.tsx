/**
 * The Play Realm table: two people, one game of Magic — in either of two modes.
 *
 * **Arena mode**, when the server sends `view.automation`, is a rules engine running the game. The
 * steps advance themselves, priority is tracked, the stack resolves, combat is declared and damage
 * is dealt, and an illegal play is refused. Every move the player is offered comes from
 * `view.automation.you`, which the engine computed — this file works out no rules of its own, so
 * what the table offers and what the engine accepts cannot drift apart.
 *
 * **Tabletop mode** is the same board with no rules at all: every card in every zone can be moved
 * anywhere, exactly as it can with cardboard. That is not a fallback for a bug, it is the design.
 * No card pool is fully scripted, and a game that stops dead because a card does something the
 * engine cannot express is worse than a game where that one card is moved by hand. The manual moves
 * stay reachable inside Arena mode for the same reason, under "Move by hand".
 *
 * Either way the table does the bookkeeping that is tedious and easy to get wrong: shuffling,
 * drawing, untapping, counters, tokens, commander damage, and a log of everything that happened so
 * a disagreement can be settled by scrolling up.
 *
 * Interaction is tap-first, with no hover-only affordances and no drag, because one of the two
 * players may be on a phone: pick a card, choose from the sheet that opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownToLine, ArrowUpToLine, Dices, Hand, Layers, Link2, LogOut, MessageSquare, Minus, Plus,
  HelpCircle, RotateCcw, Search, Send, Shuffle, Skull, Sparkles, SquareStack, Swords, Undo2,
} from "lucide-react"
import {
  COMMON_TOKENS, STARTER_DECKS,
  type GameView, type LegalPlay, type SeatView, type VisibleCard, type ZoneId,
} from "@grimore/rules-engine"
import { CardFace, type CardHighlight } from "@/components/table/CardFace"
import { ArenaBar } from "@/components/table/ArenaBar"
import { PhaseBar } from "@/components/table/PhaseBar"
import { PlaySheet } from "@/components/table/PlaySheet"
import { StackPanel } from "@/components/table/StackPanel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  IDLE, arenaReducer, candidatesAt, cardBadges, playsForCard,
  type ArenaEvent, type ArenaMode,
} from "@/lib/arena"
import { useTable, type TableAction, type UseTable } from "@/lib/table"

const NAME_KEY = "grimore.table.name"
const FORMATS = [
  { id: "modern", label: "1v1 — 20 life", hint: "Two players, 60-card decks, no command zone." },
  { id: "commander", label: "Commander — 40 life", hint: "Command zone and 21 commander damage. Up to four seats." },
] as const

/**
 * The handful of actions that are idioms rather than buttons, because the table enforces no rules.
 * Shown in the game rather than only in the docs: nobody has the setup guide open while playing,
 * and "how do I counter this?" is exactly the question that stops a game dead.
 */
const HOW_TO: [string, string][] = [
  ["Cast something", "Tap it in hand → Play to battlefield, or Cast (to the stack) to let them respond first."],
  ["It resolves", "Tap it on the stack → Resolves onto the battlefield, or to the graveyard for an instant or sorcery."],
  ["They counter it", "You move your own spell to the graveyard — nobody can reach across and move a card on your side."],
  ["Mana", "Tap your lands. The table does not count mana; you pay it the way you do with cardboard."],
  ["Attack", "Tap your attackers, say who they are attacking in chat, then settle it with the life buttons."],
  ["A creature dies", "Tap it → Destroy (to graveyard)."],
  ["Auras and equipment", "Tap it → Attach to…, then tap what it goes on. It detaches itself if that creature leaves."],
  ["Search your deck", "Search deck opens it to you and nobody else. Shuffle closes it again."],
  ["Take something back", "There is no undo — move the card back by hand. The log shows what actually happened."],
]

const zoneAt = (view: GameView, seat: number, zone: ZoneId): string[] => [...(view.zones[`${seat}:${zone}`] ?? [])]
const stackOf = (view: GameView): string[] => [...(view.zones["stack"] ?? [])]
const cardsIn = (view: GameView, ids: string[]): VisibleCard[] =>
  ids.map((id) => view.cards[id]).filter((c): c is VisibleCard => c !== undefined)

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Lobby
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function Lobby({ table, name, setName }: { table: UseTable; name: string; setName: (v: string) => void }) {
  const [code, setCode] = useState("")
  const [format, setFormat] = useState<string>("modern")
  const [tableName, setTableName] = useState("Kitchen Table")

  return (
    <div data-testid="lobby" className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <a href="/react/discover" className="text-xs text-[var(--g-text-muted)] hover:underline">
          &larr; Back to Grimore
        </a>
        <h1 className="text-xl font-semibold text-[var(--g-text-high)]">Play Realm</h1>
        <p className="text-sm text-[var(--g-text-muted)]">
          Start a table and send the code to whoever you are playing. Everything is shared live; nobody can see your hand.
        </p>
      </header>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--g-text-muted)]">Your name</span>
        <Input data-testid="player-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
      </label>

      <section className="flex flex-col gap-3 rounded-lg border border-white/10 p-4">
        <h2 className="text-sm font-semibold text-[var(--g-text-high)]">Start a table</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--g-text-muted)]">Table name</span>
          <Input data-testid="table-name" value={tableName} onChange={(e) => setTableName(e.target.value)} maxLength={32} />
        </label>
        <div className="flex flex-col gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid={`format-${f.id}`}
              onClick={() => setFormat(f.id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left transition-colors",
                format === f.id ? "border-[var(--g-accent)] bg-[var(--g-accent)]/10" : "border-white/10 hover:border-white/25",
              )}
            >
              <span className="block text-sm font-medium text-[var(--g-text-high)]">{f.label}</span>
              <span className="block text-xs text-[var(--g-text-muted)]">{f.hint}</span>
            </button>
          ))}
        </div>
        <Button data-testid="create-table" onClick={() => void table.createTable({ name: tableName, format })}>
          Create table
        </Button>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-white/10 p-4">
        <h2 className="text-sm font-semibold text-[var(--g-text-high)]">Join a table</h2>
        <Input
          data-testid="join-code"
          placeholder="WORD-WORD-12"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoCapitalize="characters"
        />
        <Button
          data-testid="join-table"
          variant="secondary"
          disabled={code.trim().length < 5}
          onClick={() => void table.joinTable({ code, name })}
        >
          Join
        </Button>
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Seated, before the cards come out
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function PreGame({ table }: { table: UseTable }) {
  const { pod, view, seat } = table
  if (!pod) return null
  const mySeat = pod.seats.find((s) => s.seat === seat)
  const isHost = pod.hostPlayerId !== null && mySeat?.playerId === pod.hostPlayerId
  const myDeck = view?.seats.find((s) => s.index === seat)?.deckId ?? null
  const everyoneHasADeck = (view?.seats ?? []).every((s) => s.deckId !== null)

  return (
    <div data-testid="pregame" className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-[var(--g-text-high)]">{pod.name}</h1>
        <p className="text-sm text-[var(--g-text-muted)]">
          Share this code:{" "}
          <span data-testid="table-code" className="font-mono text-base font-semibold text-[var(--g-gold-400)]">
            {pod.code}
          </span>
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--g-text-muted)]">Seats</h2>
        {pod.seats.map((s) => (
          <div
            key={s.seat}
            data-testid={`lobby-seat-${s.seat}`}
            className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2"
          >
            <span className="text-sm text-[var(--g-text-high)]">
              {s.name}
              {s.seat === seat ? " (you)" : ""}
            </span>
            <span className="text-xs text-[var(--g-text-muted)]">
              {!s.connected ? "reconnecting" : s.ready ? "ready" : "not ready"}
            </span>
          </div>
        ))}
      </section>

      {view === null ? (
        <>
          <p className="text-sm text-[var(--g-text-muted)]">
            Both players ready up, then you each pick a deck.
          </p>
          <Button data-testid="ready" onClick={() => void table.setReady(!(mySeat?.ready ?? false))}>
            {mySeat?.ready ? "Not ready" : "I'm ready"}
          </Button>
        </>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--g-text-muted)]">Your deck</h2>
            {Object.values(STARTER_DECKS).map((deck) => (
              <button
                key={deck.id}
                type="button"
                data-testid={`deck-${deck.id}`}
                onClick={() => void table.send({ type: "deck:load", seat, deckId: deck.id })}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition-colors",
                  myDeck === deck.id ? "border-[var(--g-accent)] bg-[var(--g-accent)]/10" : "border-white/10 hover:border-white/25",
                )}
              >
                <span className="block text-sm font-medium text-[var(--g-text-high)]">{deck.name}</span>
                <span className="block text-xs text-[var(--g-text-muted)]">{deck.description}</span>
              </button>
            ))}
          </section>
          {isHost ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--g-text-muted)]">Start</h2>
              {/*
                Two genuinely different games, so two buttons rather than a setting buried
                somewhere. The engine is the default because it is what most people want; the
                tabletop is there because it plays any card, scripted or not.
              */}
              <Button
                data-testid="start-engine"
                disabled={!everyoneHasADeck}
                onClick={() => {
                  // One after the other: `auto:start` needs a dealt table to take over.
                  void table.send({ type: "game:start" })
                  void table.send({ type: "auto:start" })
                }}
              >
                {everyoneHasADeck ? "Play with the rules engine" : "Waiting for decks"}
              </Button>
              <Button
                variant="secondary"
                data-testid="start-game"
                disabled={!everyoneHasADeck}
                onClick={() => void table.send({ type: "game:start" })}
              >
                Play as a tabletop
              </Button>
              <p className="px-1 text-[10px] leading-snug text-[var(--g-text-muted)]">
                The engine enforces the rules, tracks priority and runs combat. The tabletop
                enforces nothing and lets you move any card anywhere, the way cardboard does.
              </p>
            </section>
          ) : (
            <p className="text-sm text-[var(--g-text-muted)]">Waiting for the host to start.</p>
          )}
        </>
      )}

      <Button data-testid="leave-table" variant="ghost" onClick={() => void table.leaveTable()}>
        <LogOut className="size-4" /> Leave
      </Button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The action sheet: what you can do with the card you tapped
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface CardMenuItem {
  label: string
  id: string
  action?: TableAction
  onPick?: () => void
}

function menuFor(card: VisibleCard, opponents: number[]): CardMenuItem[] {
  const move = (toZone: ZoneId, label: string, id: string, extra: Record<string, unknown> = {}): CardMenuItem => ({
    label,
    id,
    action: { type: "card:move", card: card.id, toZone, ...extra },
  })
  switch (card.zone) {
    case "hand":
      return [
        move("battlefield", "Play to battlefield", "play"),
        move("stack", "Cast (to the stack)", "cast"),
        { label: card.revealed ? "Stop revealing" : "Reveal to everyone", id: "reveal", action: { type: "card:reveal", card: card.id } },
        move("graveyard", "Discard", "discard"),
        move("exile", "Exile", "exile"),
        move("library", "Put on top of library", "to-top", { position: "top" }),
        move("library", "Put on bottom of library", "to-bottom", { position: "bottom" }),
      ]
    case "battlefield":
      return [
        { label: card.tapped ? "Untap" : "Tap", id: "tap", action: { type: "card:tap", card: card.id } },
        { label: "Add +1/+1", id: "counter-up", action: { type: "card:counter", card: card.id, key: "+1/+1", delta: 1 } },
        { label: "Remove +1/+1", id: "counter-down", action: { type: "card:counter", card: card.id, key: "+1/+1", delta: -1 } },
        { label: "Add loyalty", id: "loyalty-up", action: { type: "card:counter", card: card.id, key: "loyalty", delta: 1 } },
        { label: card.faceDown ? "Turn face up" : "Turn face down", id: "facedown", action: { type: "card:faceDown", card: card.id } },
        move("graveyard", "Destroy (to graveyard)", "destroy"),
        move("exile", "Exile", "exile"),
        move("hand", "Return to hand", "bounce"),
        move("library", "Put on top of library", "to-top", { position: "top" }),
        ...(card.isCommander ? [move("command", "Back to the command zone", "to-command")] : []),
        ...opponents.map((o) => ({
          label: `Give control to seat ${o + 1}`,
          id: `control-${o}`,
          action: { type: "card:control", card: card.id, toSeat: o } as TableAction,
        })),
      ]
    case "graveyard":
      return [
        move("hand", "Return to hand", "to-hand"),
        move("battlefield", "Return to the battlefield", "reanimate"),
        move("exile", "Exile", "exile"),
        move("library", "Put on top of library", "to-top", { position: "top" }),
      ]
    case "exile":
      return [move("hand", "Return to hand", "to-hand"), move("battlefield", "Put onto the battlefield", "to-battlefield"), move("graveyard", "To graveyard", "to-graveyard")]
    case "command":
      return [move("battlefield", "Cast to the battlefield", "cast-commander"), move("hand", "Put in hand", "to-hand")]
    case "stack":
      return [
        move("battlefield", "Resolves onto the battlefield", "resolve-permanent"),
        move("graveyard", "Resolves and goes to the graveyard", "resolve-spell"),
        move("hand", "Return to hand", "to-hand"),
        move("exile", "Exile", "exile"),
      ]
    default:
      return []
  }
}

/**
 * The manual move list for one card.
 *
 * Its own component because it serves two sheets: the whole of the tabletop's card sheet, and the
 * "move by hand" disclosure inside the engine's play sheet. There is one list of physical moves and
 * both modes show the same one.
 */
function CardMenu({
  card,
  opponents,
  onAct,
  onAttach,
  onClose,
}: {
  card: VisibleCard
  opponents: number[]
  onAct: (action: TableAction) => void
  onAttach: (card: VisibleCard) => void
  onClose: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {menuFor(card, opponents).map((item) => (
        <Button
          key={item.id}
          data-testid={`act-${item.id}`}
          variant="secondary"
          className="justify-start"
          onClick={() => {
            if (item.action) onAct(item.action)
            onClose()
          }}
        >
          {item.label}
        </Button>
      ))}
      {card.zone === "battlefield" ? (
        <Button data-testid="act-attach" variant="secondary" className="justify-start" onClick={() => { onAttach(card); onClose() }}>
          <Link2 className="size-4" /> {card.attachedTo === null ? "Attach to…" : "Detach"}
        </Button>
      ) : null}
    </div>
  )
}

function CardSheet({
  card,
  opponents,
  onAct,
  onAttach,
  onClose,
}: {
  card: VisibleCard
  opponents: number[]
  onAct: (action: TableAction) => void
  onAttach: (card: VisibleCard) => void
  onClose: () => void
}) {
  return (
    <div
      data-testid="card-sheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-sm overflow-y-auto rounded-t-xl border border-white/15 bg-[var(--g-surface-2)] p-4 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <CardFace card={card} size="large" />
        </div>
        <CardMenu card={card} opponents={opponents} onAct={onAct} onAttach={onAttach} onClose={onClose} />
        <Button className="mt-1.5 w-full" data-testid="sheet-close" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Seat strip
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function SeatStrip({
  seat,
  isMe,
  isActive,
  commanderFormat,
  mySeat,
  onAct,
  targetable,
  onTarget,
  manualLife,
}: {
  seat: SeatView
  isMe: boolean
  isActive: boolean
  commanderFormat: boolean
  mySeat: number
  onAct: (action: TableAction) => void
  /** Lit as a legal target while a spell is being aimed. */
  targetable?: boolean
  onTarget?: () => void
  /** The life buttons, which the engine's own life changes make unnecessary and misleading. */
  manualLife?: boolean
}) {
  const life = (delta: number) => onAct({ type: "life:adjust", seat: seat.index, delta })
  return (
    <div
      data-testid={`seat-${seat.index}`}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs",
        isActive ? "border-[var(--g-gold-400)]/60 bg-[var(--g-gold-400)]/5" : "border-white/10",
        targetable === true && "border-[var(--g-status-info)] ring-2 ring-[var(--g-status-info)]",
        seat.eliminated && "opacity-50",
      )}
    >
      {targetable === true ? (
        <Button
          size="sm"
          data-testid={`target-seat-${seat.index}`}
          className="h-6 px-2 text-[10px]"
          onClick={onTarget}
        >
          Target {isMe ? "yourself" : seat.name}
        </Button>
      ) : null}
      <span className="font-semibold text-[var(--g-text-high)]">
        {seat.name}
        {isMe ? " (you)" : ""}
      </span>
      {isActive ? <span className="rounded bg-[var(--g-gold-400)] px-1 text-[9px] font-bold uppercase text-black">turn</span> : null}
      {seat.eliminated ? <span className="text-[var(--g-mana-r)]">out ({seat.eliminatedReason})</span> : null}

      <span className="flex items-center gap-1">
        {/*
          With the engine running, life is its business: it deals the damage and gains the life, and
          a stray tap on a button here would silently disagree with what the rules just did. The
          buttons are a tabletop affordance, so they only exist on a tabletop.
        */}
        {manualLife !== false ? (
          <Button data-testid={`life-down-${seat.index}`} size="icon" variant="ghost" className="size-6" onClick={() => life(-1)} aria-label="Lose 1 life">
            <Minus className="size-3" />
          </Button>
        ) : null}
        <span data-testid={`life-${seat.index}`} className="min-w-[2.5ch] text-center text-base font-bold tabular-nums text-[var(--g-text-high)]">
          {seat.life}
        </span>
        {manualLife !== false ? (
          <Button data-testid={`life-up-${seat.index}`} size="icon" variant="ghost" className="size-6" onClick={() => life(1)} aria-label="Gain 1 life">
            <Plus className="size-3" />
          </Button>
        ) : null}
      </span>

      <span className="text-[var(--g-text-muted)]">
        hand <span data-testid={`hand-count-${seat.index}`}>{seat.handCount}</span>
      </span>
      <span className="text-[var(--g-text-muted)]">
        deck <span data-testid={`library-count-${seat.index}`}>{seat.libraryCount}</span>
      </span>
      <span className="text-[var(--g-text-muted)]">gy {seat.graveyardCount}</span>
      {seat.poison > 0 ? <span className="text-[var(--g-mana-g)]">poison {seat.poison}</span> : null}

      {commanderFormat && !isMe ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[10px]"
          data-testid={`cmd-dmg-${seat.index}`}
          onClick={() => onAct({ type: "commanderDamage:adjust", seat: seat.index, fromSeat: mySeat, delta: 1 })}
        >
          <Swords className="size-3" /> cmd {seat.commanderDamage[String(mySeat)] ?? 0}
        </Button>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The board
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function ZoneRow({
  label,
  cards,
  size,
  testId,
  onSelect,
  selectedId,
  selectedIds,
  highlightOf,
  badgesOf,
  empty,
}: {
  label: string
  cards: VisibleCard[]
  size: "hand" | "board" | "pile"
  testId: string
  onSelect?: (c: VisibleCard) => void
  selectedId?: string | null
  /** For the multi-select steps: attackers being picked, blockers being paired. */
  selectedIds?: ReadonlySet<string>
  /** Why each card is lit, if it is: a legal target, an attacker, a blocker. */
  highlightOf?: (c: VisibleCard) => CardHighlight | null
  badgesOf?: (c: VisibleCard) => readonly string[]
  empty?: string
}) {
  return (
    // `min-w-0` matters: as a flex or grid item this box defaults to `min-width: auto`, so it sizes
    // to its content — seven cards is 430px — and refuses to shrink, which pushes the whole table
    // sideways on a phone and stops the inner `overflow-x-auto` ever taking effect.
    <div className="flex min-w-0 flex-col gap-1">
      <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--g-text-muted)]">
        {label} {cards.length > 0 ? `(${cards.length})` : ""}
      </span>
      <div
        data-testid={testId}
        className={cn(
          "flex items-end gap-1 overflow-x-auto rounded-md border border-white/5 bg-black/20 p-1.5",
          // An empty zone collapses to a thin strip. Reserving full card height for every empty
          // zone pushed the hand off the bottom of a laptop screen before a card had been played.
          // A zone with cards in it is sized by them: each card now occupies a slot of its own
          // size, so a fixed minimum here would only ever clip the bottom of a row.
          cards.length === 0 ? "min-h-[34px] items-center" : "",
        )}
      >
        {cards.length === 0 ? (
          <span className="px-2 text-[11px] text-[var(--g-text-muted)]">{empty ?? "empty"}</span>
        ) : (
          cards.map((c) => (
            <CardFace
              key={c.id}
              card={c}
              size={size}
              onSelect={onSelect}
              selected={selectedId === c.id || selectedIds?.has(c.id) === true}
              highlight={highlightOf?.(c) ?? null}
              badges={badgesOf?.(c)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function Board({ table }: { table: UseTable }) {
  const { view, seat } = table
  const [picked, setPicked] = useState<VisibleCard | null>(null)
  const [attachFrom, setAttachFrom] = useState<VisibleCard | null>(null)
  /**
   * What the player is halfway through — choosing targets, picking attackers, pairing blockers.
   *
   * Mirrored into a ref as well as state because `onSelect` has to read the *current* mode to
   * decide what a tap means, and a value captured by a closure is one render behind: tapping two
   * targets in quick succession would otherwise send the first choice twice.
   */
  const [arenaMode, setArenaMode] = useState<ArenaMode>(IDLE)
  const arenaRef = useRef<ArenaMode>(IDLE)
  const [showLog, setShowLog] = useState(false)
  const [showTokens, setShowTokens] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [draft, setDraft] = useState("")
  // Unread count, so a message that arrives while the panel is closed is not missed.
  const [seenChat, setSeenChat] = useState(0)
  useEffect(() => {
    if (showChat) setSeenChat(table.chat.length)
  }, [showChat, table.chat.length])
  const unread = table.chat.length - seenChat

  const act = useCallback((action: TableAction) => void table.send(action), [table])

  /**
   * Runs one interaction event and sends whatever action it completed.
   *
   * The send is deliberately outside the state updater: React may call an updater twice in
   * development, and a doubled `auto:cast` is a spell cast twice.
   */
  const dispatchArena = useCallback(
    (event: ArenaEvent) => {
      const result = arenaReducer(arenaRef.current, event)
      arenaRef.current = result.mode
      setArenaMode(result.mode)
      if (result.action !== null) void table.send(result.action)
    },
    [table],
  )

  /**
   * Drops a half-finished interaction the game has moved past.
   *
   * The spell got countered, the creature died, the step ended while the player was still
   * choosing. Holding on to the selection would leave the board lit up for a decision nobody is
   * being asked for any more.
   */
  const awaitingKind = view?.automation?.awaiting?.kind ?? null
  const stateVersion = view?.stateVersion ?? 0
  useEffect(() => {
    const mode = arenaRef.current
    if (mode.kind === "idle") return
    const stale =
      (mode.kind === "attackers" && awaitingKind !== "attackers") ||
      (mode.kind === "blockers" && awaitingKind !== "blockers") ||
      (mode.kind === "targeting" && view !== null && playsForCard(view, mode.play.card).length === 0)
    if (!stale) return
    arenaRef.current = IDLE
    setArenaMode(IDLE)
    // `view` is read only to re-check the current mode; the version is what says it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingKind, stateVersion])

  if (!view || seat === null) return null
  const me = view.seats.find((s) => s.index === seat)
  const opponents = view.seats.filter((s) => s.index !== seat)
  const commanderFormat = view.format === "pod" || view.format === "edh"
  const isMyTurn = view.activeSeat === seat
  const auto = view.automation
  const you = auto?.you ?? null
  const automated = auto !== null
  const myAttackers = new Set(you?.attackers ?? [])
  const attackingIds = new Set((auto?.combat.attacks ?? []).map((a) => a.attacker))
  const blockingIds = new Set((auto?.combat.attacks ?? []).flatMap((a) => a.blockers))
  /**
   * Which attackers each of this seat's creatures may block, straight from the engine.
   *
   * Without this the table would happily let a ground creature be assigned to a flier, the engine
   * would refuse the whole declaration, and the step would never end — the player would be asked
   * to block again, make the same illegal choice, and the game would stop. Evasion is a rule, so
   * the answer comes from the rules; the UI only has to stop offering what is not on the list.
   */
  const blockableBy = new Map<string, Set<string>>(
    (you?.blockers ?? []).map((option) => [option.blocker, new Set(option.canBlock)]),
  )
  const holdingBlocker = arenaMode.kind === "blockers" ? arenaMode.holding : null
  const assignableAttackers = holdingBlocker === null
    ? new Set<string>()
    : (blockableBy.get(holdingBlocker) ?? new Set<string>())

  /** Cards that are a legal choice for the pick the player is on, while targeting. */
  const targetableCards = new Set<string>(
    arenaMode.kind === "targeting"
      ? candidatesAt(arenaMode.play, arenaMode.chosen.length, arenaMode.chosen)
          .filter((t) => t.kind === "card")
          .map((t) => (t as { id: string }).id)
      : [],
  )
  const targetableSeats = new Set<number>(
    arenaMode.kind === "targeting"
      ? candidatesAt(arenaMode.play, arenaMode.chosen.length, arenaMode.chosen)
          .filter((t) => t.kind === "player")
          .map((t) => (t as { seat: number }).seat)
      : [],
  )
  const chosenIds = new Set<string>(
    arenaMode.kind === "targeting"
      ? arenaMode.chosen.filter((t) => t.kind === "card").map((t) => (t as { id: string }).id)
      : arenaMode.kind === "attackers"
        ? arenaMode.chosen
        : arenaMode.kind === "blockers"
          ? [...arenaMode.chosen.map((b) => b.blocker), ...(arenaMode.holding === null ? [] : [arenaMode.holding])]
          : [],
  )

  /**
   * What a tap means, which depends entirely on what the player is in the middle of.
   *
   * Nothing here decides legality: a card is tappable as a target because the engine listed it as
   * a candidate, and tappable as an attacker because the engine listed it in `attackers`.
   */
  const onSelect = (card: VisibleCard) => {
    // Mid-attach, the next battlefield card tapped becomes the host rather than opening a sheet.
    if (attachFrom !== null) {
      if (card.id !== attachFrom.id && card.zone === "battlefield") {
        act({ type: "card:attach", card: attachFrom.id, to: card.id })
      }
      setAttachFrom(null)
      return
    }

    const mode = arenaRef.current
    if (mode.kind === "targeting") {
      if (targetableCards.has(card.id) || chosenIds.has(card.id)) {
        dispatchArena({ kind: "pickTarget", target: { kind: "card", id: card.id } })
      }
      // A tap on something that is not a legal target does nothing at all, rather than silently
      // dropping out of targeting and leaving the player wondering where their spell went.
      return
    }
    if (mode.kind === "attackers") {
      if (myAttackers.has(card.id) || mode.chosen.includes(card.id)) {
        dispatchArena({ kind: "toggleAttacker", card: card.id })
      }
      return
    }
    if (mode.kind === "blockers") {
      if (card.zoneSeat === seat) {
        // Only a creature the engine listed as a possible blocker can be picked up.
        if (blockableBy.has(card.id) || mode.chosen.some((b) => b.blocker === card.id)) {
          dispatchArena({ kind: "holdBlocker", card: card.id })
        }
        return
      }
      // And it can only be put on an attacker it is allowed to block.
      if (assignableAttackers.has(card.id)) dispatchArena({ kind: "assignBlock", attacker: card.id })
      return
    }

    // A card in hand with a discard owed goes straight out, which is the only thing it can do.
    if (you !== null && you.mustDiscard > 0 && card.zone === "hand" && card.zoneSeat === seat) {
      act({ type: "auto:discard", card: card.id })
      return
    }
    setPicked(card)
  }

  /** How a card on the battlefield is lit, and what the small print under it says. */
  const highlightOf = (card: VisibleCard): CardHighlight | null => {
    if (targetableCards.has(card.id)) return "target"
    // While a blocker is held, the attackers it may be put on are the ones lit.
    if (assignableAttackers.has(card.id)) return "target"
    if (attackingIds.has(card.id)) return "attacking"
    if (blockingIds.has(card.id)) return "blocking"
    return null
  }
  const badgesOf = (card: VisibleCard): readonly string[] => (automated ? cardBadges(view, card) : [])

  const onAttach = (card: VisibleCard) => {
    if (card.attachedTo !== null) {
      act({ type: "card:attach", card: card.id, to: null })
      return
    }
    setAttachFrom(card)
  }

  return (
    <div data-testid="table" className="flex min-h-dvh flex-col gap-1.5 px-2 pb-2 pt-2 sm:px-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-[var(--g-text-high)]">
          Turn <span data-testid="turn">{view.turn}</span>
        </span>
        {automated ? null : (
          <span data-testid="whose-turn" className={cn("rounded px-1.5 py-0.5", isMyTurn ? "bg-[var(--g-gold-400)] text-black" : "bg-white/10 text-[var(--g-text-muted)]")}>
            {isMyTurn ? "your turn" : `${view.seats[view.activeSeat]?.name ?? "opponent"}'s turn`}
          </span>
        )}
        <span className="font-mono text-[var(--g-text-muted)]">{table.pod?.code}</span>
        {table.connection !== "connected" ? (
          <span data-testid="connection" className="rounded bg-[var(--g-mana-r)]/20 px-1.5 py-0.5 text-[var(--g-mana-r)]">
            {table.connection}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7"
          data-testid="toggle-chat"
          onClick={() => setShowChat((v) => !v)}
        >
          <MessageSquare className="size-3.5" /> Chat
          {unread > 0 ? (
            <span data-testid="chat-unread" className="ml-1 rounded-full bg-[var(--g-gold-400)] px-1.5 text-[10px] font-bold text-black">
              {unread}
            </span>
          ) : null}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" data-testid="toggle-log" onClick={() => setShowLog((v) => !v)}>
          <Layers className="size-3.5" /> Log
        </Button>
        <Button size="sm" variant="ghost" className="h-7" data-testid="toggle-help" onClick={() => setShowHelp(true)} aria-label="How to play">
          <HelpCircle className="size-3.5" />
        </Button>
      </div>

      {automated ? <PhaseBar view={view} /> : null}

      {view.finished ? (
        <div data-testid="game-over" className="rounded-md border border-[var(--g-gold-400)]/50 bg-[var(--g-gold-400)]/10 px-3 py-2 text-sm font-semibold text-[var(--g-text-high)]">
          {view.winnerSeat === null ? "The game is over." : `${view.seats[view.winnerSeat]?.name} wins.`}{" "}
          <Button size="sm" variant="secondary" className="ml-2 h-7" data-testid="new-game" onClick={() => act({ type: "game:reset" })}>
            <RotateCcw className="size-3.5" /> New game
          </Button>
        </div>
      ) : null}

      {attachFrom !== null ? (
        <div data-testid="attach-hint" className="rounded-md border border-[var(--g-status-info)]/50 bg-[var(--g-status-info)]/10 px-3 py-2 text-xs">
          Pick the permanent to attach <strong>{attachFrom.card?.name ?? "it"}</strong> to.
          <Button size="sm" variant="ghost" className="ml-2 h-6" onClick={() => setAttachFrom(null)}>
            Cancel
          </Button>
        </div>
      ) : null}

      {/* Opponents */}
      {opponents.map((o) => (
        <div key={o.index} className="flex flex-col gap-1.5">
          <SeatStrip
            seat={o}
            isMe={false}
            isActive={view.activeSeat === o.index}
            commanderFormat={commanderFormat}
            mySeat={seat}
            onAct={act}
            manualLife={!automated}
            targetable={targetableSeats.has(o.index)}
            onTarget={() => dispatchArena({ kind: "pickTarget", target: { kind: "player", seat: o.index } })}
          />
          <div className="flex gap-1.5">
            <ZoneRow
              label={`${o.name}'s hand`}
              testId={`zone-hand-${o.index}`}
              size="pile"
              cards={cardsIn(view, zoneAt(view, o.index, "hand"))}
              empty="no cards"
            />
          </div>
          <ZoneRow
            label={`${o.name}'s battlefield`}
            testId={`zone-battlefield-${o.index}`}
            size="board"
            cards={cardsIn(view, zoneAt(view, o.index, "battlefield"))}
            onSelect={onSelect}
            selectedId={attachFrom?.id ?? null}
            selectedIds={chosenIds}
            highlightOf={highlightOf}
            badgesOf={badgesOf}
          />
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <ZoneRow label="graveyard" testId={`zone-graveyard-${o.index}`} size="pile" cards={cardsIn(view, zoneAt(view, o.index, "graveyard"))} onSelect={onSelect} />
            <ZoneRow label="exile" testId={`zone-exile-${o.index}`} size="pile" cards={cardsIn(view, zoneAt(view, o.index, "exile"))} onSelect={onSelect} />
            {commanderFormat ? (
              <ZoneRow label="command" testId={`zone-command-${o.index}`} size="pile" cards={cardsIn(view, zoneAt(view, o.index, "command"))} onSelect={onSelect} />
            ) : null}
          </div>
        </div>
      ))}

      {/*
        The stack, shared. With the engine running it is a list rather than a row of cards: an
        ability on the stack has no card to draw, and what matters is what resolves next and at
        what, which is text.
      */}
      {automated ? (
        <StackPanel view={view} />
      ) : (
        <ZoneRow
          label="The stack"
          testId="zone-stack"
          size="board"
          cards={cardsIn(view, stackOf(view))}
          onSelect={onSelect}
          empty="nothing waiting to resolve"
        />
      )}

      {/* Me */}
      {me ? (
        <SeatStrip
          seat={me}
          isMe
          isActive={isMyTurn}
          commanderFormat={commanderFormat}
          mySeat={seat}
          onAct={act}
          manualLife={!automated}
          targetable={targetableSeats.has(seat)}
          onTarget={() => dispatchArena({ kind: "pickTarget", target: { kind: "player", seat } })}
        />
      ) : null}
      <ZoneRow
        label="Your battlefield"
        testId={`zone-battlefield-${seat}`}
        size="board"
        cards={cardsIn(view, zoneAt(view, seat, "battlefield"))}
        onSelect={onSelect}
        selectedId={attachFrom?.id ?? null}
        selectedIds={chosenIds}
        highlightOf={highlightOf}
        badgesOf={badgesOf}
      />
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <ZoneRow label="Your graveyard" testId={`zone-graveyard-${seat}`} size="pile" cards={cardsIn(view, zoneAt(view, seat, "graveyard"))} onSelect={onSelect} />
        <ZoneRow label="Your exile" testId={`zone-exile-${seat}`} size="pile" cards={cardsIn(view, zoneAt(view, seat, "exile"))} onSelect={onSelect} />
        {commanderFormat ? (
          <ZoneRow label="Command zone" testId={`zone-command-${seat}`} size="pile" cards={cardsIn(view, zoneAt(view, seat, "command"))} onSelect={onSelect} />
        ) : null}
      </div>
      {/* Searching shows your own library, and only while you are looking. */}
      {me?.searching ? (
        <ZoneRow
          label="Your library (searching)"
          testId={`zone-library-${seat}`}
          size="pile"
          cards={cardsIn(view, zoneAt(view, seat, "library"))}
          onSelect={onSelect}
        />
      ) : null}
      <ZoneRow
        label="Your hand"
        testId={`zone-hand-${seat}`}
        size="hand"
        cards={cardsIn(view, zoneAt(view, seat, "hand"))}
        onSelect={onSelect}
        selectedIds={chosenIds}
        highlightOf={highlightOf}
        badgesOf={(card) =>
          // In hand, the useful thing to say is whether it can be played at all right now.
          automated && playsForCard(view, card.id).length > 0 ? ["playable"] : []
        }
        empty="no cards in hand"
      />
      {/*
        The control bar is sticky at the bottom of the viewport, so without a spacer the bottom of
        the hand sits underneath it and the cards there cannot be tapped. Matches the bar's height.
      */}
      <div aria-hidden className="h-24 shrink-0" />

      {/*
        Controls. With the engine running, everything in the manual bar either duplicates something
        the engine does (draw, untap, pass turn) or breaks it (moving a card by hand mid-step), so
        it is replaced by one bar holding whatever the engine is actually waiting for.
      */}
      {automated ? (
        <ArenaBar view={view} mode={arenaMode} dispatch={dispatchArena} onAct={act} />
      ) : (
      <div data-testid="controls" className="sticky bottom-0 -mx-2 flex gap-1.5 overflow-x-auto border-t border-white/10 bg-[var(--g-surface-base)]/95 px-2 py-2 backdrop-blur sm:-mx-4 sm:px-4">
        <Button size="sm" data-testid="draw" onClick={() => act({ type: "zone:draw", seat, count: 1 })}>
          <Hand className="size-3.5" /> Draw
        </Button>
        <Button size="sm" variant="secondary" data-testid="untap-all" onClick={() => act({ type: "turn:untapAll", seat })}>
          <Undo2 className="size-3.5" /> Untap all
        </Button>
        <Button size="sm" variant="secondary" data-testid="pass-turn" onClick={() => act({ type: "turn:pass" })}>
          <ArrowUpToLine className="size-3.5" /> Pass turn
        </Button>
        <Button size="sm" variant="secondary" data-testid="shuffle" onClick={() => act({ type: "zone:shuffle", seat, zone: "library" })}>
          <Shuffle className="size-3.5" /> Shuffle
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="search"
          onClick={() => act({ type: "zone:search", seat, searching: !(me?.searching ?? false) })}
        >
          <Search className="size-3.5" /> {me?.searching ? "Close deck" : "Search deck"}
        </Button>
        <Button size="sm" variant="secondary" data-testid="mulligan" onClick={() => act({ type: "mulligan", seat })}>
          <ArrowDownToLine className="size-3.5" /> Mulligan
        </Button>
        <Button size="sm" variant="secondary" data-testid="tokens" onClick={() => setShowTokens(true)}>
          <SquareStack className="size-3.5" /> Token
        </Button>
        <Button size="sm" variant="secondary" data-testid="roll" onClick={() => act({ type: "dice:roll", sides: 6, count: 1 })}>
          <Dices className="size-3.5" /> d6
        </Button>
        <Button size="sm" variant="secondary" data-testid="hand-to-engine" onClick={() => act({ type: "auto:start" })}>
          <Sparkles className="size-3.5" /> Rules engine
        </Button>
        <Button size="sm" variant="ghost" data-testid="concede" onClick={() => act({ type: "concede" })}>
          <Skull className="size-3.5" /> Concede
        </Button>
      </div>
      )}

      {/* Overlays */}
      {picked !== null && automated ? (
        <PlaySheet
          card={picked}
          plays={playsForCard(view, picked.id)}
          mustDiscard={picked.zone === "hand" && picked.zoneSeat === seat ? (you?.mustDiscard ?? 0) : 0}
          onPlay={(play: LegalPlay) => {
            setPicked(null)
            dispatchArena({ kind: "choosePlay", play })
          }}
          onDiscard={() => {
            act({ type: "auto:discard", card: picked.id })
            setPicked(null)
          }}
          manual={
            <CardMenu
              card={picked}
              opponents={opponents.map((o) => o.index)}
              onAct={act}
              onAttach={onAttach}
              onClose={() => setPicked(null)}
            />
          }
          onClose={() => setPicked(null)}
        />
      ) : null}

      {picked !== null && !automated ? (
        <CardSheet
          card={picked}
          opponents={opponents.map((o) => o.index)}
          onAct={act}
          onAttach={onAttach}
          onClose={() => setPicked(null)}
        />
      ) : null}

      {showTokens ? (
        <div data-testid="token-sheet" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={() => setShowTokens(false)}>
          <div className="w-full max-w-sm rounded-t-xl border border-white/15 bg-[var(--g-surface-2)] p-4 sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold text-[var(--g-text-high)]">Create a token</h2>
            <div className="flex flex-col gap-1.5">
              {COMMON_TOKENS.map((t) => (
                <Button
                  key={t.name}
                  variant="secondary"
                  className="justify-start"
                  data-testid={`token-${t.name.toLowerCase()}`}
                  onClick={() => {
                    act({ type: "token:create", seat, card: t, count: 1 })
                    setShowTokens(false)
                  }}
                >
                  <Sparkles className="size-4" /> {t.name}
                  {t.power !== undefined ? ` ${t.power}/${t.toughness}` : ""}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => setShowTokens(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      ) : null}

      {showHelp ? (
        <div data-testid="help-panel" className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" onClick={() => setShowHelp(false)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-white/15 bg-[var(--g-surface-2)] p-4 sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-[var(--g-text-high)]">How this table works</h2>
            <p className="mt-1 text-xs text-[var(--g-text-muted)]">
              It keeps the board, the zones and the life totals honest, and leaves the rules to the two
              of you — so it works with any card. Tap a card to see what you can do with it.
            </p>
            <dl className="mt-3 flex flex-col gap-2.5">
              {HOW_TO.map(([title, body]) => (
                <div key={title}>
                  <dt className="text-xs font-semibold text-[var(--g-gold-400)]">{title}</dt>
                  <dd className="text-xs text-[var(--g-text-muted)]">{body}</dd>
                </div>
              ))}
            </dl>
            <Button className="mt-4 w-full" variant="secondary" data-testid="help-close" onClick={() => setShowHelp(false)}>
              Got it
            </Button>
          </div>
        </div>
      ) : null}

      {showChat ? (
        <div data-testid="chat-panel" className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setShowChat(false)}>
          <div className="flex w-full max-w-sm flex-col border-l border-white/15 bg-[var(--g-surface-2)]" onClick={(e) => e.stopPropagation()}>
            <h2 className="border-b border-white/10 p-4 text-sm font-semibold text-[var(--g-text-high)]">
              Table talk
            </h2>
            <div data-testid="chat-messages" className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
              {table.chat.length === 0 ? (
                <p className="text-xs text-[var(--g-text-muted)]">
                  Nothing said yet. This is for the things the table cannot decide for you — whether
                  you are responding, what a trigger did, taking something back.
                </p>
              ) : (
                table.chat.map((line) => (
                  <p key={line.id} className="text-xs text-[var(--g-text-high)]">
                    <span className="font-semibold text-[var(--g-gold-400)]">{line.name}</span>{" "}
                    {line.text}
                  </p>
                ))
              )}
            </div>
            <form
              className="flex gap-1.5 border-t border-white/10 p-3"
              onSubmit={(e) => {
                e.preventDefault()
                void table.say(draft)
                setDraft("")
              }}
            >
              <Input
                data-testid="chat-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Say something"
                maxLength={400}
              />
              <Button type="submit" size="icon" data-testid="chat-send" aria-label="Send">
                <Send className="size-4" />
              </Button>
            </form>
          </div>
        </div>
      ) : null}

      {showLog ? (
        <div data-testid="log-panel" className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setShowLog(false)}>
          <div className="flex w-full max-w-sm flex-col gap-2 overflow-y-auto border-l border-white/15 bg-[var(--g-surface-2)] p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-[var(--g-text-high)]">What happened</h2>
            {[...view.log].reverse().map((entry, i) => (
              <p key={`${entry.version}-${i}`} className="border-b border-white/5 pb-1 text-xs text-[var(--g-text-muted)]">
                <span className="font-mono text-[10px] text-white/40">T{entry.turn}</span> {entry.message}
              </p>
            ))}
            <Button variant="ghost" onClick={() => setShowLog(false)}>Close</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

export default function PlayTable() {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "Player"
    } catch {
      return "Player"
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(NAME_KEY, name)
    } catch {
      /* Private browsing: the name just is not remembered. */
    }
  }, [name])

  const table = useTable(name)
  const seated = table.pod !== null && table.seat !== null
  const playing = seated && table.view !== null && table.view.started

  const banner = useMemo(
    () =>
      table.error === null ? null : (
        <div data-testid="table-error" className="mx-auto mt-2 w-full max-w-md rounded-md border border-[var(--g-mana-r)]/50 bg-[var(--g-mana-r)]/10 px-3 py-2 text-xs text-[var(--g-text-high)]">
          {table.error}
          <Button size="sm" variant="ghost" className="ml-2 h-6" onClick={table.clearError}>
            Dismiss
          </Button>
        </div>
      ),
    [table.error, table.clearError],
  )

  return (
    <>
      {banner}
      {!seated ? (
        <Lobby table={table} name={name} setName={setName} />
      ) : playing ? (
        <Board table={table} />
      ) : (
        <PreGame table={table} />
      )}
    </>
  )
}
