/**
 * The Play Realm table: two people, one game of Magic.
 *
 * A shared digital tabletop rather than a rules engine. Nothing here decides whether a play is
 * legal — the players do that, exactly as they do with cardboard — so every card in every zone can
 * be moved anywhere, and the table works with any deck instead of only with cards someone has
 * written code for. `packages/rules-engine/src/cards.ts` explains why that is the right trade.
 *
 * What the table *does* do is the bookkeeping that is tedious and easy to get wrong: shuffling,
 * drawing, untapping, counters, tokens, commander damage, the turn counter, and a log of everything
 * that happened so a disagreement can be settled by scrolling up.
 *
 * Interaction is tap-first, with no hover-only affordances and no drag, because one of the two
 * players may be on a phone: pick a card, choose from the sheet that opens.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDownToLine, ArrowUpToLine, Dices, Hand, Layers, Link2, LogOut, Minus, Plus,
  RotateCcw, Search, Shuffle, Skull, Sparkles, SquareStack, Swords, Undo2,
} from "lucide-react"
import { COMMON_TOKENS, STARTER_DECKS, type GameView, type SeatView, type VisibleCard, type ZoneId } from "@grimore/rules-engine"
import { CardFace } from "@/components/table/CardFace"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useTable, type TableAction, type UseTable } from "@/lib/table"

const NAME_KEY = "grimore.table.name"
const FORMATS = [
  { id: "modern", label: "1v1 — 20 life", hint: "Two players, 60-card decks, no command zone." },
  { id: "commander", label: "Commander — 40 life", hint: "Command zone and 21 commander damage. Up to four seats." },
] as const

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
            <Button data-testid="start-game" disabled={!everyoneHasADeck} onClick={() => void table.send({ type: "game:start" })}>
              {everyoneHasADeck ? "Start the game" : "Waiting for decks"}
            </Button>
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
  const items = menuFor(card, opponents)
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
        <div className="flex flex-col gap-1.5">
          {items.map((item) => (
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
          <Button data-testid="sheet-close" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
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
}: {
  seat: SeatView
  isMe: boolean
  isActive: boolean
  commanderFormat: boolean
  mySeat: number
  onAct: (action: TableAction) => void
}) {
  const life = (delta: number) => onAct({ type: "life:adjust", seat: seat.index, delta })
  return (
    <div
      data-testid={`seat-${seat.index}`}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs",
        isActive ? "border-[var(--g-gold-400)]/60 bg-[var(--g-gold-400)]/5" : "border-white/10",
        seat.eliminated && "opacity-50",
      )}
    >
      <span className="font-semibold text-[var(--g-text-high)]">
        {seat.name}
        {isMe ? " (you)" : ""}
      </span>
      {isActive ? <span className="rounded bg-[var(--g-gold-400)] px-1 text-[9px] font-bold uppercase text-black">turn</span> : null}
      {seat.eliminated ? <span className="text-[var(--g-mana-r)]">out ({seat.eliminatedReason})</span> : null}

      <span className="flex items-center gap-1">
        <Button data-testid={`life-down-${seat.index}`} size="icon" variant="ghost" className="size-6" onClick={() => life(-1)} aria-label="Lose 1 life">
          <Minus className="size-3" />
        </Button>
        <span data-testid={`life-${seat.index}`} className="min-w-[2.5ch] text-center text-base font-bold tabular-nums text-[var(--g-text-high)]">
          {seat.life}
        </span>
        <Button data-testid={`life-up-${seat.index}`} size="icon" variant="ghost" className="size-6" onClick={() => life(1)} aria-label="Gain 1 life">
          <Plus className="size-3" />
        </Button>
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
  empty,
}: {
  label: string
  cards: VisibleCard[]
  size: "hand" | "board" | "pile"
  testId: string
  onSelect?: (c: VisibleCard) => void
  selectedId?: string | null
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
          cards.length === 0 ? "min-h-[34px] items-center" : size === "hand" ? "min-h-[136px]" : "min-h-[72px]",
        )}
      >
        {cards.length === 0 ? (
          <span className="px-2 text-[11px] text-[var(--g-text-muted)]">{empty ?? "empty"}</span>
        ) : (
          cards.map((c) => (
            <CardFace key={c.id} card={c} size={size} onSelect={onSelect} selected={selectedId === c.id} />
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
  const [showLog, setShowLog] = useState(false)
  const [showTokens, setShowTokens] = useState(false)

  const act = useCallback((action: TableAction) => void table.send(action), [table])

  if (!view || seat === null) return null
  const me = view.seats.find((s) => s.index === seat)
  const opponents = view.seats.filter((s) => s.index !== seat)
  const commanderFormat = view.format === "pod" || view.format === "edh"
  const isMyTurn = view.activeSeat === seat

  const onSelect = (card: VisibleCard) => {
    // Mid-attach, the next battlefield card tapped becomes the host rather than opening a sheet.
    if (attachFrom !== null) {
      if (card.id !== attachFrom.id && card.zone === "battlefield") {
        act({ type: "card:attach", card: attachFrom.id, to: card.id })
      }
      setAttachFrom(null)
      return
    }
    setPicked(card)
  }

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
        <span data-testid="whose-turn" className={cn("rounded px-1.5 py-0.5", isMyTurn ? "bg-[var(--g-gold-400)] text-black" : "bg-white/10 text-[var(--g-text-muted)]")}>
          {isMyTurn ? "your turn" : `${view.seats[view.activeSeat]?.name ?? "opponent"}'s turn`}
        </span>
        <span className="font-mono text-[var(--g-text-muted)]">{table.pod?.code}</span>
        {table.connection !== "connected" ? (
          <span data-testid="connection" className="rounded bg-[var(--g-mana-r)]/20 px-1.5 py-0.5 text-[var(--g-mana-r)]">
            {table.connection}
          </span>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto h-7" data-testid="toggle-log" onClick={() => setShowLog((v) => !v)}>
          <Layers className="size-3.5" /> Log
        </Button>
      </div>

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
          <SeatStrip seat={o} isMe={false} isActive={view.activeSeat === o.index} commanderFormat={commanderFormat} mySeat={seat} onAct={act} />
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

      {/* The stack, shared */}
      <ZoneRow
        label="The stack"
        testId="zone-stack"
        size="board"
        cards={cardsIn(view, stackOf(view))}
        onSelect={onSelect}
        empty="nothing waiting to resolve"
      />

      {/* Me */}
      {me ? (
        <SeatStrip seat={me} isMe isActive={isMyTurn} commanderFormat={commanderFormat} mySeat={seat} onAct={act} />
      ) : null}
      <ZoneRow
        label="Your battlefield"
        testId={`zone-battlefield-${seat}`}
        size="board"
        cards={cardsIn(view, zoneAt(view, seat, "battlefield"))}
        onSelect={onSelect}
        selectedId={attachFrom?.id ?? null}
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
        empty="no cards in hand"
      />
      {/*
        The control bar is sticky at the bottom of the viewport, so without a spacer the bottom of
        the hand sits underneath it and the cards there cannot be tapped. Matches the bar's height.
      */}
      <div aria-hidden className="h-16 shrink-0" />

      {/* Controls */}
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
        <Button size="sm" variant="ghost" data-testid="concede" onClick={() => act({ type: "concede" })}>
          <Skull className="size-3.5" /> Concede
        </Button>
      </div>

      {/* Overlays */}
      {picked !== null ? (
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
