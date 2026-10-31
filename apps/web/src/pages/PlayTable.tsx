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
  ArrowDownToLine, ArrowUpToLine, Dices, Hand, Handshake, Layers, Link2, LogOut, MessageSquare,
  Minus, Plus,
  HelpCircle, RotateCcw, Search, Shuffle, Skull, Sparkles, SquareStack, Swords, Undo2,
  Volume2, VolumeX,
} from "lucide-react"
import {
  COMMON_TOKENS, STARTER_DECKS,
  type DeckSpec, type GameView, type LegalPlay, type SeatView, type VisibleCard, type ZoneId,
} from "@grimore/rules-engine"
import { customDeckIdFor, isCustomDeckId } from "@grimore/shared"
import { deckSummary } from "@/lib/decks"
import { CardFace, type CardHighlight } from "@/components/table/CardFace"
import { ArenaBar } from "@/components/table/ArenaBar"
import { ArenaEmbers } from "@/components/table/ArenaEmbers"
import { CombatArrows } from "@/components/table/CombatArrows"
import { TableFeed } from "@/components/table/TableFeed"
import { PhaseBar } from "@/components/table/PhaseBar"
import { PlaySheet } from "@/components/table/PlaySheet"
import { ChatPanel } from "@/components/table/ChatPanel"
import { StackPanel } from "@/components/table/StackPanel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  IDLE, arenaReducer, boardRead, brokeADeal, candidatesAt, cardBadges, choiceCandidatesAt,
  damageTakenFrom, dividedAmount,
  eliminatedLabel, pactBadge, playsForCard, reasonCannotPlay, sparedYouBy, splitBattlefield,
  type ArenaEvent, type ArenaMode, type BoardRead,
} from "@/lib/arena"
import {
  pastedNote, readSavedList, useTable, writeSavedList,
  type TableAction, type UseTable,
} from "@/lib/table"
import { useTableSound } from "@/lib/useTableSound"
import { useTableFeed } from "@/lib/useTableFeed"
import { isBarePass } from "@/lib/feed"

const NAME_KEY = "grimore.table.name"
const FORMATS = [
  { id: "modern", label: "1v1 — 20 life", hint: "Two players, 60-card decks, no command zone.", seats: 2 },
  { id: "commander", label: "Commander — 40 life", hint: "Command zone and 21 commander damage. Up to four seats.", seats: 4 },
] as const

/**
 * How many seats a format has, for a listing that wants to say "1 of 4".
 *
 * Read off `FORMATS` rather than imported, because the server's own `maxSeatsFor` lives in
 * `apps/realtime` and is not on the wire. A format this does not know is shown without a count
 * instead of with a wrong one.
 */
const seatsFor = (format: string): number | null =>
  FORMATS.find((f) => f.id === format)?.seats ?? null

/**
 * The handful of actions that are idioms rather than buttons, because the table enforces no rules.
 * Shown in the game rather than only in the docs: nobody has the setup guide open while playing,
 * and "how do I counter this?" is exactly the question that stops a game dead.
 */
/**
 * The help a player needs depends on which table they are at, and the two are not alike.
 *
 * The tabletop list below was the only one for a long time, and with the engine running every
 * line of it is actively wrong: it tells a player to tap their own lands, to say who they are
 * attacking in chat, and to settle combat with the life buttons — none of which is how an
 * automated table works, and two of which are not even possible there any more.
 */
const HOW_TO_ARENA: [string, string][] = [
  ["One button", "The bar at the bottom always shows the one thing the game is waiting for: Pass, Resolve, Next step, Declare attackers, Keep. The top bar says which step it is and who is holding things up."],
  ["Cast something", "Tap the card. Everything you can legally do with it is listed and nothing else is; a card you can play right now says playable. The mana is tapped for you — tap lands yourself first only if you want particular ones spent."],
  ["Choose a target", "The legal ones light up, wherever they are: a creature, a player's row, a card in a graveyard, or a spell waiting on the stack."],
  ["How big is it?", "A spell with {X} in its cost asks for X before it asks for a target, because that is when the rules choose it. The numbers offered are the ones your mana covers."],
  ["Paying more, or paying with a creature", "A kicker is its own play — \"with kicker {4}\" — offered only when you can pay all of it. A land in your hand may offer cycling: the mana and the card, for a new card. A spell whose cost is one of your creatures asks which before it asks for a target, and that creature is gone before anybody can respond to the spell."],
  ["Attack", "Declare attackers, pick who each creature is going at — a player, or one of their planeswalkers — then tap the creatures. Lines on the board show what is attacking what."],
  ["Block", "Declare blockers, tap your creature, then tap the attacker it blocks. Only the attackers it may legally block light up."],
  ["A planeswalker", "Tap it and take one of its loyalty abilities: one a turn each, your main phase only, and a minus you cannot pay for is not offered."],
  ["Choosing a word rather than a card", "Two cards ask a question that no card picks an answer to: Obelisk of Urd asks for a creature type, Voice of All asks for a colour. The bar shows the words as buttons and one tap is the whole answer — there is nothing to confirm. Both of them ask while the card is still resolving, which is what \"as this enters\" means: by the time it is on the battlefield the choice is already made, so there is no moment in which the Obelisk is out and nothing is pumped. The Obelisk then pumps that type for as long as it is on the battlefield, including creatures that arrive later, and stops the instant it leaves."],
  ["Questions mid-spell", "Some cards stop and ask — a search, a discard, a scry. The cards you may choose light up, and nothing else happens until you answer."],
  ["Being asked less", "The skipping toggle passes for you whenever passing is your only legal move, which is most of a game. Turn it off to be offered every priority."],
  ["Foretell", "On your own turn, some cards offer Foretell: pay {2} and the card goes face down into exile, where nobody can see what it is. From your next turn it is a play again out of exile, for the smaller cost printed on it. It splits a four-mana spell across two turns, which is how you hold up a counterspell without holding up the mana. Nobody can respond to the foretelling."],
  ["A Saga", "An enchantment that reads itself out over three turns. Chapter I happens the moment it arrives, and it gets a lore counter at the start of each of your own main phases — the card shows the count. Each chapter goes on the stack, so it can be answered even though the counter cannot. After the last chapter resolves the Saga goes to your graveyard."],
  ["A Vehicle", "An artifact that is not a creature until it is crewed, so it cannot attack or block and a sweeper cannot touch it. Tap it → Crew, and the table taps enough of your smallest creatures to reach the number, saying how many first. It is a creature until end of turn. Crewing is an ability, so it can be answered — and the creatures are already tapped by then."],
  ["A card you play face down", "A card with morph offers two plays: cast it for its printed cost, or \"face down\" for {3}. Face down it is a 2/2 with no name and no abilities, and nobody else can see what it is. Tap it later → Turn face up, pay its morph cost, and it is itself again — keeping its damage, its counters and whether it is tapped. Nobody gets a chance to respond to that, which is the point: it can be done in the middle of a combat. Some of them do something as they turn up, and that part goes on the stack like any other trigger. Two are not paid for with mana the usual way: one costs 3 life instead, and is not offered at all while paying it would kill you; one has megamorph, which adds a +1/+1 counter as it comes up."],
  ["Send their removal somewhere else", "Two cards change what a spell already on the stack is pointed at: Willbender (a morph — turn it up while their removal is on the stack) and Swerve (an instant, for an instant or a sorcery). Pick the spell, then pick where it goes. The new target has to be legal for THEIR spell, so a \"target creature\" spell cannot be sent at a player — and if the one you pick is illegal the spell keeps the target it had rather than being countered. The spell must have exactly one target, and a spell with nowhere else to go is not offered at all. Willbender also takes an ABILITY with a single target, which Swerve does not: tap the row on the stack rather than a card."],
  ["Answer what a permanent is doing", "Two cards counter an ability on the stack rather than the permanent that made it, which is the one thing killing the permanent cannot do: by the time an Icy Manipulator's tap or a Jace's loyalty ability is waiting to resolve, destroying the card does not stop it. Squelch counters an activated ability and draws you a card; Disallow counters a spell OR an ability, either kind. Abilities are the rows in the stack list, so you tap the row — there is no card to tap, because an ability is a thing a permanent is doing and not an object you own. Neither is castable with nothing there to point at."],
  ["Why is my creature bigger", "Three creatures are lords: they change the other creatures of their own type, and none of them pumps itself. Stromkirk Captain gives other Vampires +1/+1 and first strike, Knight Exemplar gives other Knights +1/+1 and indestructible, Imperious Perfect gives other Elves +1/+1. The board shows the current size and changes it the instant the lord arrives or leaves — a damaged Knight that the Exemplar was keeping alive dies the moment the Exemplar does."],
  ["A creature that grows itself", "Cloudfin Raptor is a 0/1 that gets a +1/+1 counter whenever a creature you control enters that is bigger than it — greater power OR greater toughness, so a 0/2 Fog Bank grows it and a 1/1 does not. The check happens twice: nothing goes on the stack at all when the creature that arrived is not bigger, and it is checked again when the trigger resolves, so bouncing or killing that creature in reply means no counter. By the time it is the biggest thing you control it stops triggering."],
  ["Attacking with one creature", "Guardians of Akrasa is a 2/3 that cannot attack and has exalted: whenever exactly one of your creatures attacks, THAT creature gets +1/+1 until end of turn. Attack with two and nobody gets anything — it is the number of attackers you declared that matters, not what is left in combat afterwards."],
  ["A star where the power is", "Two creatures are printed with a * instead of a number — their power is a count of something, read fresh every time anybody looks. Lhurgoyf counts the creature cards in every graveyard; Enigma Drake counts the instants and sorceries in your own. In hand the card still shows the *; on the battlefield the board shows what it currently is, and it changes with no trigger and nothing to announce — including downwards, if a graveyard gets exiled."],
  ["Something it does not know", "Tap the card → Move by hand. The tabletop's full move list is underneath, and the log says the card was not automated."],
  ["Leaving", "Concede takes two taps. The rest of the table plays on without you."],
]

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
  /*
    Unlisted by default, and the default is the decision rather than the toggle.

    A shared server that listed every table as it was made would show strangers each other's games,
    so a table is private unless its host says otherwise — and the label says which it is rather
    than leaving it to a doc nobody has open. The server enforces the same thing from the other
    side: `listPublic` only ever returns a table whose host asked for it *and* which is still in
    its lobby.
  */
  const [listed, setListed] = useState(false)
  /** Which deck's contents are open in the solo list, if any. */
  const [soloPeek, setSoloPeek] = useState<string | null>(null)

  return (
    <div data-testid="lobby" className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <a href="/react/discover" className="text-xs text-[var(--g-text-muted)] hover:underline">
          &larr; Back to Grimore
        </a>
        <h1 className="text-xl font-semibold text-[var(--g-text-high)]">Play Realm</h1>
        <p className="text-sm text-[var(--g-text-muted)]">
          Start a table and send the code to whoever you are playing, or open it for anyone to join. Everything is shared live; nobody can see your hand.
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
        <div className="flex gap-2">
          {[
            { on: false, label: "Just us", hint: "Shared by code only" },
            { on: true, label: "Open table", hint: "Listed for anyone to join" },
          ].map((choice) => (
            <button
              key={String(choice.on)}
              type="button"
              data-testid={`visibility-${choice.on ? "public" : "private"}`}
              aria-pressed={listed === choice.on}
              onClick={() => setListed(choice.on)}
              className={cn(
                "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                listed === choice.on
                  ? "border-[var(--g-accent)] bg-[var(--g-accent)]/10"
                  : "border-white/10 hover:border-white/25",
              )}
            >
              <span className="block text-sm font-medium text-[var(--g-text-high)]">{choice.label}</span>
              <span className="block text-xs text-[var(--g-text-muted)]">{choice.hint}</span>
            </button>
          ))}
        </div>
        <Button
          data-testid="create-table"
          onClick={() => void table.createTable({
            name: tableName, format, visibility: listed ? "public" : "private",
          })}
        >
          Create table
        </Button>
      </section>

      <OpenTables table={table} name={name} />

      <section className="flex flex-col gap-3 rounded-lg border border-white/10 p-4">
        <h2 className="text-sm font-semibold text-[var(--g-text-high)]">Play on your own</h2>
        <p className="text-xs text-[var(--g-text-muted)]">
          One seat for you and one the computer plays, with the rules engine running the game. No
          code to share and nobody to wait for.
        </p>
        <div className="flex flex-col gap-2">
          {Object.values(STARTER_DECKS).map((deck) => (
            <div key={deck.id} className="flex flex-col">
              <button
                type="button"
                data-testid={`solo-${deck.id}`}
                onClick={() => void table.createTable({
                  name: "Solo", format: "modern", bots: 1, botDeck: deck.id,
                })}
                className="rounded-md border border-white/10 px-3 py-2 text-left transition-colors hover:border-white/25"
              >
                <span className="block text-sm font-medium text-[var(--g-text-high)]">Play against {deck.name}</span>
                <span className="block text-xs text-[var(--g-text-muted)]">{deck.description}</span>
              </button>
              {/* The same list the pregame picker offers: this is where a new player chooses first. */}
              <button
                type="button"
                data-testid={`solo-peek-${deck.id}`}
                onClick={() => setSoloPeek(soloPeek === deck.id ? null : deck.id)}
                className="self-start px-3 py-1 text-[10px] text-[var(--g-text-muted)] underline-offset-2 hover:underline"
              >
                {soloPeek === deck.id ? "Hide the list" : "What's in it"}
              </button>
              {soloPeek === deck.id ? <DeckPeek deck={deck} /> : null}
            </div>
          ))}
          {/*
            A pod on your own, which is the format this product is named after and the one table
            a single player could not set up: the server has always been able to play three
            seats, and nothing in the lobby ever asked it to. Three different decks, because
            three of the same is one game played three times.
          */}
          <button
            type="button"
            data-testid="solo-pod"
            onClick={() => void table.createTable({
              name: "Solo pod",
              format: "commander",
              bots: 3,
              botDecks: Object.keys(STARTER_DECKS).slice(0, 3),
            })}
            className="rounded-md border border-[var(--g-gold-400)]/40 px-3 py-2 text-left transition-colors hover:border-[var(--g-gold-400)]"
          >
            <span className="block text-sm font-medium text-[var(--g-text-high)]">Play a Commander pod</span>
            <span className="block text-xs text-[var(--g-text-muted)]">
              Four seats at 40 life, three of them the computer's, each on a different deck.
            </span>
          </button>
        </div>
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
        <div className="flex gap-2">
          <Button
            data-testid="join-table"
            variant="secondary"
            className="flex-1"
            disabled={code.trim().length < 5}
            onClick={() => void table.joinTable({ code, name })}
          >
            Join
          </Button>
          {/*
            Watching takes no seat and works mid-game, so it is the same code box and a quieter
            button beside it rather than a second form. The name goes with it even though watching
            does not need one: a watcher can talk in the table's chat, and a spectator whose line
            reads "Player" is a spectator the table can mistake for an opponent.
          */}
          <Button
            data-testid="watch-table"
            variant="ghost"
            disabled={code.trim().length < 5}
            onClick={() => void table.watchTable(code, name)}
          >
            Watch
          </Button>
        </div>
      </section>
    </div>
  )
}

/**
 * The tables whose hosts chose to list them, with a way in that is not a code.
 *
 * Until this existed the only route to somebody else's table was a string they had to send you,
 * which is fine for two people who are already talking and is the whole of the lobby otherwise.
 * The server has had the list since the pod store was written; nothing had ever asked for it.
 *
 * Three things it has to get right beyond rendering rows. The **empty state** is the normal one —
 * two people playing privately see no tables, and the code box has to still be the obvious way in.
 * A row can be **stale**: a table that filled up or started between the render and the tap is
 * refused by the server, which is already handled as an ordinary error banner, so the button does
 * not pretend to check first. And a table's name and code come from **other people**, so they go
 * through React as text and never as markup.
 */
function OpenTables({ table, name }: { table: UseTable; name: string }) {
  const tables = table.openTables
  return (
    <section data-testid="open-tables" className="flex flex-col gap-3 rounded-lg border border-white/10 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--g-text-high)]">Open tables</h2>
        <button
          type="button"
          data-testid="refresh-tables"
          onClick={() => table.refreshTables()}
          className="text-xs text-[var(--g-text-muted)] underline-offset-2 hover:underline"
        >
          Refresh
        </button>
      </div>
      {tables.length === 0 ? (
        <p data-testid="open-tables-empty" className="text-xs text-[var(--g-text-muted)]">
          Nobody has an open table right now. Start one above as an <strong>Open table</strong> to
          be listed here, or join with a code below.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tables.map((entry) => {
            const seats = seatsFor(entry.format)
            return (
              <li
                key={entry.code}
                data-testid={`open-table-${entry.code}`}
                className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-[var(--g-text-high)]">{entry.name}</span>
                  <span className="text-xs text-[var(--g-text-muted)]">
                    {entry.code}
                    {" · "}
                    {FORMATS.find((f) => f.id === entry.format)?.label ?? entry.format}
                    {seats === null ? "" : ` · ${entry.seatCount} of ${seats} seated`}
                  </span>
                </span>
                <Button
                  data-testid={`join-open-${entry.code}`}
                  variant="secondary"
                  onClick={() => void table.joinTable({ code: entry.code, name })}
                >
                  Join
                </Button>
                <Button
                  data-testid={`watch-open-${entry.code}`}
                  variant="ghost"
                  onClick={() => void table.watchTable(entry.code, name)}
                >
                  Watch
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Seated, before the cards come out
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One deck's contents, as a player reads a decklist.
 *
 * Lands, creatures, spells; each sorted by cost; a curve across the top and the colours beside the
 * count. Deliberately text rather than card images — there are no images in this product (the card
 * table has never been populated, see `claude/play-realm-setup.md`), and a list is what a player
 * compares two decks with anyway.
 */
function DeckPeek({ deck }: { deck: DeckSpec }) {
  const summary = deckSummary(deck)
  const peak = Math.max(1, ...summary.curve)
  return (
    <div
      data-testid={`peek-panel-${deck.id}`}
      className="mb-1 flex flex-col gap-2 rounded-md border border-white/10 bg-black/20 px-3 py-2"
    >
      <div className="flex items-baseline justify-between text-[10px] text-[var(--g-text-muted)]">
        <span>
          {summary.total} cards
          {summary.colors.length > 0 ? ` · ${summary.colors.join("")}` : ""}
          {summary.commander === undefined ? "" : ` · ${summary.commander}`}
        </span>
        {/*
          The curve, as bars a reader can see the shape of rather than a row of numbers. One to
          seven, lands left out, because a curve is about what you cast.
        */}
        <span className="flex items-end gap-0.5" data-testid={`peek-curve-${deck.id}`} aria-hidden>
          {summary.curve.slice(1).map((n, i) => (
            <span
              key={i}
              title={`${n} at ${i + 1}`}
              className="w-1.5 rounded-sm bg-[var(--g-gold-400)]/60"
              style={{ height: `${Math.max(2, Math.round((n / peak) * 18))}px` }}
            />
          ))}
        </span>
      </div>
      {summary.groups.map((group) => (
        <div key={group.label} className="flex flex-col">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--g-text-muted)]">
            {group.label} ({group.total})
          </span>
          <ul className="columns-2 gap-3 text-[11px] leading-snug text-[var(--g-text-high)]">
            {group.entries.map((entry) => (
              <li key={entry.name} className="break-inside-avoid">
                {entry.count}
                {" "}
                {entry.name}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function PreGame({ table }: { table: UseTable }) {
  const { pod, view, seat } = table
  /**
   * On a table whose only other seats are the computer's, readying up is a click with no meaning:
   * there is nobody to wait for and nothing to coordinate. So it is done for the player, and the
   * lobby they see is the one that matters — pick a deck and start.
   */
  const soloReady = pod !== null && seat !== null
    && pod.seats.length > 1
    && pod.seats.every((s) => s.bot || s.seat === seat)
    && pod.seats.find((s) => s.seat === seat)?.ready === false
  const { setReady } = table
  /**
   * Fired once and only once.
   *
   * React runs an effect twice in development, and the second `pod:ready` lands after the table
   * has already been dealt — which the server correctly refuses, putting an error banner in front
   * of a player who did nothing. The ref is the guard; the effect's own condition is not, because
   * the state it reads has not come back from the server yet when the second run happens.
   */
  const readiedRef = useRef(false)
  useEffect(() => {
    if (!soloReady || readiedRef.current) return
    readiedRef.current = true
    void setReady(true)
  }, [soloReady, setReady])

  /** The paste box, open or shut, and what the server made of the last list sent through it. */
  const [pasting, setPasting] = useState(false)
  const [listText, setListText] = useState("")
  const [listNote, setListNote] = useState<string | null>(null)
  /** Which deck's contents are open, if any. One at a time: this is a lobby, not a browser. */
  const [peeking, setPeeking] = useState<string | null>(null)
  /**
   * The last list this browser pasted, read once.
   *
   * Read in a ref-less `useState` initialiser rather than an effect so the button is there on the
   * first paint: a player who pasted a deck yesterday should see it offered, not see it appear.
   */
  const [savedList] = useState(() => readSavedList())

  if (!pod) return null
  const mySeat = pod.seats.find((s) => s.seat === seat)
  const isHost = pod.hostPlayerId !== null && mySeat?.playerId === pod.hostPlayerId
  const myDeck = view?.seats.find((s) => s.index === seat)?.deckId ?? null
  const everyoneHasADeck = (view?.seats ?? []).every((s) => s.deckId !== null)
  const soloOnly = pod.seats.length > 1 && pod.seats.every((s) => s.bot || s.seat === seat)
  /**
   * Cards in a *loaded* pasted list that the engine has no script for.
   *
   * Counted only for the seats actually playing their list, because a player who pasted a deck and
   * then picked a starter one has nothing unreadable at the table — and counted from the lobby
   * seats rather than the view because that is where the summary lives. It decides one thing: the
   * engine button. The real refusal is the server's, in `auto:start`; this is the table saying so
   * before the host presses it, which is the difference between a disabled button and an error.
   */
  const unreadable = (view?.seats ?? [])
    .filter((s) => isCustomDeckId(s.deckId))
    .reduce((n, s) => n + (pod.seats.find((p) => p.seat === s.index)?.list?.unknown ?? 0), 0)
  const myList = mySeat?.list
  /** This seat's pasted list, by the id the server will resolve for it. */
  const myListId = customDeckIdFor(seat ?? 0)

  return (
    <div data-testid="pregame" className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-[var(--g-text-high)]">{pod.name}</h1>
        <p className="text-sm text-[var(--g-text-muted)]">
          {soloOnly ? "Playing against the computer. " : "Share this code: "}
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
            <span className="flex flex-col text-sm text-[var(--g-text-high)]">
              <span>
                {s.name}
                {s.seat === seat ? " (you)" : ""}
              </span>
              {/*
                Whose list it is and how much of it the engine can read, to everybody — because the
                host is the one pressing Start, and "the engine cannot read every card" with no
                indication of whose deck is the problem is a dead end rather than an explanation.
                Never its contents: a summary is table information, a decklist is not.
              */}
              {s.list ? (
                <span data-testid={`lobby-list-${s.seat}`} className="text-[10px] text-[var(--g-text-muted)]">
                  {s.list.name ?? "a list of their own"} · {s.list.total}{" "}
                  {s.list.total === 1 ? "card" : "cards"}
                  {s.list.unknown > 0 ? ` · ${s.list.unknown} the engine cannot read` : ""}
                </span>
              ) : null}
            </span>
            <span className="text-xs text-[var(--g-text-muted)]">
              {s.bot ? "the computer" : !s.connected ? "reconnecting" : s.ready ? "ready" : "not ready"}
            </span>
          </div>
        ))}
      </section>

      {view === null ? (
        soloOnly ? (
          <p className="text-sm text-[var(--g-text-muted)]">Dealing…</p>
        ) : (
        <>
          <p className="text-sm text-[var(--g-text-muted)]">
            Both players ready up, then you each pick a deck.
          </p>
          <Button data-testid="ready" onClick={() => void table.setReady(!(mySeat?.ready ?? false))}>
            {mySeat?.ready ? "Not ready" : "I'm ready"}
          </Button>
        </>
        )
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--g-text-muted)]">Your deck</h2>
            {Object.values(STARTER_DECKS).map((deck) => (
              <div key={deck.id} className="flex flex-col">
                <button
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
                {/*
                  What is actually in it, on demand.

                  Eleven decks offered as a name and one line of prose is a choice made blind:
                  "blue-black control" does not say whether there is a sweeper in it or what it
                  wins with. The cards have been in the browser all along — the table deals from
                  them — so this costs a request of nothing. Shut by default, because the first
                  thing on this screen should still be "pick one and start".
                */}
                <button
                  type="button"
                  data-testid={`peek-${deck.id}`}
                  onClick={() => setPeeking(peeking === deck.id ? null : deck.id)}
                  className="self-start px-3 py-1 text-[10px] text-[var(--g-text-muted)] underline-offset-2 hover:underline"
                >
                  {peeking === deck.id ? "Hide the list" : "What's in it"}
                </button>
                {peeking === deck.id ? <DeckPeek deck={deck} /> : null}
              </div>
            ))}
            {myList ? (
              <button
                type="button"
                data-testid="deck-custom"
                onClick={() => void table.send({ type: "deck:load", seat, deckId: myListId })}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition-colors",
                  isCustomDeckId(myDeck)
                    ? "border-[var(--g-accent)] bg-[var(--g-accent)]/10"
                    : "border-white/10 hover:border-white/25",
                )}
              >
                <span className="block text-sm font-medium text-[var(--g-text-high)]">
                  {myList.name ?? "Your list"}
                </span>
                <span className="block text-xs text-[var(--g-text-muted)]">
                  {myList.total} {myList.total === 1 ? "card" : "cards"}
                  {myList.unknown > 0
                    ? ` · ${myList.unknown} the engine does not know`
                    : " · every one of them scripted"}
                </span>
              </button>
            ) : null}
            {pasting ? (
              <div className="flex flex-col gap-2">
                <textarea
                  data-testid="deck-text"
                  value={listText}
                  onChange={(e) => setListText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={"4 Lightning Bolt\n2 Shock\n24 Mountain\n\nCommander\n1 Tatyova, Benthic Druid"}
                  className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-[var(--g-text-high)] placeholder:text-[var(--g-text-muted)]"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    data-testid="use-list"
                    disabled={listText.trim().length === 0}
                    onClick={() => {
                      void (async () => {
                        const summary = await table.sendDeck(listText)
                        // Null is a refusal, and it has already put its reason in the error banner;
                        // the box stays open with the text in it so the player can fix the line.
                        if (summary === null) return
                        // Kept for next time, in this browser only: a list the server accepted is
                        // worth not typing again tomorrow. See `writeSavedList`.
                        writeSavedList({ text: listText })
                        setListNote(pastedNote(summary))
                        setPasting(false)
                        await table.send({ type: "deck:load", seat, deckId: myListId })
                      })()
                    }}
                  >
                    Use this list
                  </Button>
                  {savedList !== null && savedList.text !== listText ? (
                    <Button
                      variant="secondary"
                      data-testid="fill-saved-list"
                      onClick={() => setListText(savedList.text)}
                    >
                      Last list I pasted
                    </Button>
                  ) : null}
                  <Button variant="ghost" data-testid="cancel-list" onClick={() => setPasting(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="secondary" data-testid="paste-list" onClick={() => setPasting(true)}>
                Paste a list of your own
              </Button>
            )}
            {listNote === null ? null : (
              <p data-testid="list-note" className="px-1 text-[10px] leading-snug text-[var(--g-text-muted)]">
                {listNote}
              </p>
            )}
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
                disabled={!everyoneHasADeck || unreadable > 0}
                onClick={() => {
                  // One after the other: `auto:start` needs a dealt table to take over.
                  void table.send({ type: "game:start" })
                  void table.send({ type: "auto:start" })
                }}
              >
                {!everyoneHasADeck
                  ? "Waiting for decks"
                  : unreadable > 0
                    ? "The engine cannot read every card"
                    : "Play with the rules engine"}
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
                Either way the table rolls for who goes first.
              </p>
              {unreadable > 0 ? (
                <p data-testid="unreadable-note" className="px-1 text-[10px] leading-snug text-[var(--g-text-muted)]">
                  {unreadable} {unreadable === 1 ? "card" : "cards"} in a pasted list{" "}
                  {unreadable === 1 ? "is" : "are"} not in the engine's pool, so it has no idea what{" "}
                  {unreadable === 1 ? "it does" : "they do"}. The tabletop plays them: you read them
                  off the card, as you would at a kitchen table.
                </p>
              ) : null}
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
  isMonarch,
  commanderFormat,
  mySeat,
  onAct,
  targetable,
  onTarget,
  targetVerb,
  manualLife,
  seats,
  board,
  myLife,
  myBlockers,
  pact,
  brokeDeal,
  hitMe,
  sparedMe,
}: {
  seat: SeatView
  isMe: boolean
  isActive: boolean
  /** Whether this seat holds the crown (CR 720). */
  isMonarch: boolean
  commanderFormat: boolean
  mySeat: number
  onAct: (action: TableAction) => void
  /** Lit as a legal target while a spell is being aimed. */
  targetable?: boolean
  onTarget?: () => void
  /**
   * What the tap means, when it is not aiming anything.
   *
   * A proliferate chooses players alongside permanents (CR 701.27a) rather than targeting them, so
   * the button says "Choose" — "Target the computer" would be describing a different game.
   */
  targetVerb?: string
  /** The life buttons, which the engine's own life changes make unnecessary and misleading. */
  manualLife?: boolean
  /** Every seat, so commander damage can name who dealt it rather than printing a seat number. */
  seats: readonly SeatView[]
  /**
   * What this seat's board can do, on an automated table: total power, and how much of it is
   * untapped. Absent on a tabletop, where the engine is not computing anybody's power and a
   * number here would be a guess dressed up as a fact.
   */
  board?: BoardRead
  /**
   * Your own life total, so an opponent's strip can say when their untapped power alone is enough
   * to end you. Only passed on an automated table, and only for somebody else's strip.
   */
  myLife?: number
  /** Whether *you* have an untapped creature, which is the whole of "could you block it". */
  myBlockers?: number
  /** The live deal between you and this seat, in a word or two. See `GameState.pacts`. */
  pact?: string | null
  /** Whether this seat has gone back on a deal in this game. */
  brokeDeal?: boolean
  /**
   * How much damage this seat has dealt *you* over the whole game, on an automated table.
   *
   * The political question a four-player table asks every turn and the software could not answer.
   * Passed only for somebody else's strip, and only when the engine is counting.
   */
  hitMe?: number
  /**
   * How much attacking power this seat could have aimed at *you* and sent elsewhere, all game.
   *
   * The other half of the same question, and the half that needed the engine: a seat that attacked
   * somebody else looks identical to a seat that could not attack you, and the legality check that
   * tells them apart happens when the attack is declared. See `Seat.spared`.
   */
  sparedMe?: number
}) {
  const life = (delta: number) => onAct({ type: "life:adjust", seat: seat.index, delta })
  /**
   * The largest commander damage this seat has taken, and who dealt it.
   *
   * Keyed by the seat the damage came from, which is how the engine and the tabletop both record
   * it — a player, not a card, because the rule is about damage from "a commander" by player.
   */
  const worstCommanderDamage = (row: SeatView): { amount: number; from: string } | null => {
    let worst: { amount: number; from: string } | null = null
    for (const [from, amount] of Object.entries(row.commanderDamage)) {
      if (amount <= 0) continue
      if (worst !== null && amount <= worst.amount) continue
      const dealer = seats.find((s) => String(s.index) === from)
      worst = { amount, from: dealer?.name ?? `seat ${from}` }
    }
    return worst
  }
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
          {targetVerb ?? "Target"} {isMe ? "yourself" : seat.name}
        </Button>
      ) : null}
      <span className="font-semibold text-[var(--g-text-high)]">
        {seat.name}
        {isMe ? " (you)" : ""}
      </span>
      {isActive ? <span className="rounded bg-[var(--g-gold-400)] px-1 text-[9px] font-bold uppercase text-black">turn</span> : null}
      {/*
        The crown (CR 720). An extra card every turn for whoever holds it, and it goes to whoever
        deals its holder combat damage — so in a pod it is the single most useful thing to be able
        to read off another seat, and the reason to attack the player you were not going to attack.
      */}
      {isMonarch ? (
        <span
          data-testid={`monarch-${seat.index}`}
          className="rounded bg-[var(--g-gold-400)]/25 px-1 text-[9px] font-bold uppercase tracking-wide text-[var(--g-gold-400)] ring-1 ring-[var(--g-gold-400)]/50"
        >
          monarch
        </span>
      ) : null}
      {seat.eliminated ? (
        <span className="text-[var(--g-mana-r)]">{eliminatedLabel(seat.eliminatedReason)}</span>
      ) : null}

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
      {/*
        The two numbers a pod turns on: how much power this seat has, and how much of it is still
        untapped. Everything else on this strip says how the game has gone; these say what is about
        to happen — and in a four-player game they are the difference between reading the board and
        counting it.

        Both are power rather than a headcount, because both questions they answer are about power:
        three untapped 1/1s and one untapped 7/7 are the same number of creatures and nothing like
        the same turn.
      */}
      {board !== undefined && board.creatures > 0 ? (
        <span data-testid={`board-${seat.index}`} className="text-[var(--g-text-muted)]">
          board <span className="font-semibold text-[var(--g-text-high)]">{board.power}</span>
          {board.ready < board.creatures ? ` · ${board.readyPower} up` : ""}
        </span>
      ) : null}
      {/*
        And the one conclusion worth drawing for you: their untapped power is at least your life
        and you have nothing untapped to block with, so unless you answer it this turn their attack
        ends you. Strict on purpose — a seat you could block is not marked, because whether the
        block saves you depends on how they assign, and a table that cried lethal and was wrong
        would be worse than a table that said nothing.
      */}
      {board !== undefined && !isMe && myLife !== undefined && myBlockers === 0
        && board.readyPower >= myLife && board.readyPower > 0 ? (
          <span
            data-testid={`lethal-${seat.index}`}
            title="Their untapped creatures alone are lethal, and you have nothing untapped to block with"
            className="rounded bg-[var(--g-mana-r)] px-1 text-[9px] font-bold uppercase text-white"
          >
            lethal
          </span>
        ) : null}
      {/*
        The deal you have with this player, and whether they have kept one.

        On the seat strip rather than anywhere else because a pact is about a *player*: the question
        it answers is "am I safe from them this turn", which is the same question the life total and
        the untapped power on this row answer. The broken badge stays for the rest of the game, and
        is the only thing in this engine that is purely a social consequence — it changes no rule,
        and it is the whole reason the deals are worth recording.
      */}
      {typeof pact === "string" ? (
        <span
          data-testid={`pact-${seat.index}`}
          title="A deal you have with this player. Nothing enforces it."
          className="rounded bg-[var(--g-mana-w)]/20 px-1 text-[9px] font-bold uppercase text-[var(--g-mana-w)]"
        >
          {pact}
        </span>
      ) : null}
      {brokeDeal === true ? (
        <span
          data-testid={`broke-deal-${seat.index}`}
          title="This player attacked somebody they had agreed not to attack"
          className="rounded bg-[var(--g-mana-r)]/20 px-1 text-[9px] font-bold uppercase text-[var(--g-mana-r)]"
        >
          broke a deal
        </span>
      ) : null}
      {/*
        What this player has done to you, all game, in one number.

        A pod's politics is mostly memory: who hit you on turn five, who has left you alone, who
        said they would and did. Life totals show the sum of everybody's work and the log shows one
        event at a time, so the question *who has been coming at me* had no answer anywhere on the
        table — which the pod's own notes listed as the missing half of its politics.

        **Damage, not attacks.** A swing that was blocked cost you nothing and reads as nothing
        here; a Fireball to the face reads as three. It counts every kind of damage that landed,
        which is the shape of the question a player means. And it is **information and never
        enforcement**, the same line the deals draw: the table remembers, and does nothing about it.

        Shown only when it is not zero, because a row of "hit you 0" on every strip from turn one
        is noise rather than a read — and a seat with no badge at all is itself the answer to the
        other half of the question.
      */}
      {typeof hitMe === "number" && hitMe > 0 ? (
        <span
          data-testid={`hit-me-${seat.index}`}
          title="Damage this player has dealt you this game. The table remembers; nothing enforces it."
          className="flex items-center gap-1 text-[10px] text-[var(--g-mana-r)]"
        >
          <Swords className="size-3" /> hit you {hitMe}
        </span>
      ) : null}
      {/*
        And what this player has **not** done to you, which is the other half of the read.

        A seat with no "hit you" badge is either a friend or a player with no board, and a pod
        spends half its conversation on which. This is the number that tells them apart: attacking
        power that was legally able to come at you and went somewhere else. Shown in the green the
        table uses for what is going your way, beside the red of what is not.

        Zero is drawn as nothing, like the badge above — on turn one everybody has spared everybody
        and the row would say so on every strip.
      */}
      {typeof sparedMe === "number" && sparedMe > 0 ? (
        <span
          data-testid={`spared-me-${seat.index}`}
          title="Attacking power this player could have aimed at you this game and sent elsewhere."
          className="flex items-center gap-1 text-[10px] text-[var(--g-mana-g)]"
        >
          <Handshake className="size-3" /> spared you {sparedMe}
        </span>
      ) : null}
      {seat.poison > 0 ? <span className="text-[var(--g-mana-g)]">poison {seat.poison}</span> : null}
      {/*
        Energy, which is the one resource a player has to plan several turns ahead with.

        Mana is gone at the end of the step and life is the number in bold at the front of this
        row; energy is neither — it is saved up and spent later, so a player who cannot see it
        cannot decide whether to spend it. Shown only once a seat has any, like the poison beside
        it, because a row of zeroes is a row nobody reads.

        Every seat's count, not only your own: energy is public (CR 122.1), and knowing that the
        player across the table is sitting on six of it is how you decide whether to attack into
        their Bristling Hydra.
      */}
      {(seat.counters['energy'] ?? 0) > 0 ? (
        <span
          data-testid={`energy-${seat.index}`}
          title="Energy counters. Saved between turns, spent on abilities that ask for them."
          className="text-[var(--g-status-info)]"
        >
          energy {seat.counters['energy']}
        </span>
      ) : null}

      {/*
        Damage prevention sitting on this player, which nothing else on the table shows.

        A shield cast on a player is three points that will quietly not happen, held somewhere no
        card and no counter records. The seat row is where a player reads their life, so it is where
        the number that defends it belongs.
      */}
      {(seat.shielded ?? 0) > 0 ? (
        <span
          data-testid={`shielded-${seat.index}`}
          title="Damage prevention held on this player this turn"
          className="text-[var(--g-mana-w)]"
        >
          prevents {seat.shielded}
        </span>
      ) : null}

      {/*
        The commander damage *you* have taken, on your own row, which is the number that decides
        games: 21 from any one commander and you are out (CR 903.10), whatever your life total
        says. Only the worst of the three is shown, and whose it is — a column per opponent would
        read as "cmd 7/0/14" and tell you nothing you could act on.
      */}
      {commanderFormat && isMe ? (
        worstCommanderDamage(seat) === null ? null : (
          <span data-testid={`cmd-taken-${seat.index}`} className="flex items-center gap-1 text-[10px] text-[var(--g-mana-r)]">
            <Swords className="size-3" /> cmd taken {worstCommanderDamage(seat)!.amount} ({worstCommanderDamage(seat)!.from})
          </span>
        )
      ) : null}

      {/*
        Commander damage, counted the same way life is: by hand on a tabletop, by the engine on an
        automated table. The engine records the damage its own combat dealt, so a button here would
        add a second count on top of it — the same trap the life buttons were, one rule along.
      */}
      {commanderFormat && !isMe ? (
        manualLife !== false ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[10px]"
            data-testid={`cmd-dmg-${seat.index}`}
            onClick={() => onAct({ type: "commanderDamage:adjust", seat: seat.index, fromSeat: mySeat, delta: 1 })}
          >
            <Swords className="size-3" /> cmd {seat.commanderDamage[String(mySeat)] ?? 0}
          </Button>
        ) : (
          <span data-testid={`cmd-dmg-${seat.index}`} className="flex items-center gap-1 text-[10px] text-[var(--g-text-muted)]">
            <Swords className="size-3" /> cmd {seat.commanderDamage[String(mySeat)] ?? 0}
          </span>
        )
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
  /*
    An empty zone is one line, label and all.

    It used to be two — a label above a 34px strip — which is fifty-odd pixels to say "no
    creatures". A fresh four-seat pod has sixteen such zones on it before anybody has played a
    card, and the solo suite's own phone screenshot is most of a thousand pixels of them. The
    label moves inside the strip and the zone keeps its `data-testid`, so a graveyard a player
    expects to find is still exactly where it was, just not shouting about being empty.
  */
  if (cards.length === 0) {
    return (
      <div
        data-testid={testId}
        className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md border border-white/5 bg-black/20 px-2 py-1"
      >
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-[var(--g-text-muted)]">
          {label}
        </span>
        <span className="truncate text-[11px] text-[var(--g-text-muted)]">{empty ?? "empty"}</span>
      </div>
    )
  }
  return (
    // `min-w-0` matters: as a flex or grid item this box defaults to `min-width: auto`, so it sizes
    // to its content — seven cards is 430px — and refuses to shrink, which pushes the whole table
    // sideways on a phone and stops the inner `overflow-x-auto` ever taking effect.
    <div className="flex min-w-0 flex-col gap-1">
      <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--g-text-muted)]">
        {label} ({cards.length})
      </span>
      <div
        data-testid={testId}
        // A zone with cards in it is sized by them: each card occupies a slot of its own size, so
        // a fixed minimum here would only ever clip the bottom of a row.
        className="flex items-end gap-1 overflow-x-auto rounded-md border border-white/5 bg-black/20 p-1.5"
      >
        {cards.map((c) => (
          <CardFace
            key={c.id}
            card={c}
            size={size}
            onSelect={onSelect}
            selected={selectedId === c.id || selectedIds?.has(c.id) === true}
            highlight={highlightOf?.(c) ?? null}
            badges={badgesOf?.(c)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * A battlefield, split into what fights and what makes mana.
 *
 * Only in Arena mode, where the engine tells the client which permanents are creatures. On the
 * manual tabletop nothing knows what a card is, so it stays one row — which is also the right
 * answer there, because a tabletop's whole point is that a card can be anywhere.
 *
 * The `zone-battlefield-{seat}` test id stays on a wrapper around both rows, so everything that
 * counted the permanents on a side still does.
 */
function Battlefield({
  label,
  seat,
  cards,
  split,
  onSelect,
  selectedId,
  selectedIds,
  highlightOf,
  badgesOf,
}: {
  label: string
  seat: number
  cards: VisibleCard[]
  split: boolean
  onSelect?: (c: VisibleCard) => void
  selectedId?: string | null
  selectedIds?: ReadonlySet<string>
  highlightOf?: (c: VisibleCard) => CardHighlight | null
  badgesOf?: (c: VisibleCard) => readonly string[]
}) {
  const shared = { onSelect, selectedId, selectedIds, highlightOf, badgesOf }
  if (!split) {
    return (
      <ZoneRow label={`${label} battlefield`} testId={`zone-battlefield-${seat}`} size="board" cards={cards} {...shared} />
    )
  }
  const { creatures, lands } = splitBattlefield(cards)
  return (
    <div data-testid={`zone-battlefield-${seat}`} className="flex min-w-0 flex-col gap-1">
      <ZoneRow label={`${label} creatures`} testId={`zone-creatures-${seat}`} size="board" cards={creatures} empty="no creatures" {...shared} />
      <ZoneRow label={`${label} lands and other`} testId={`zone-lands-${seat}`} size="pile" cards={lands} empty="no lands" {...shared} />
    </div>
  )
}

function Board({ table }: { table: UseTable }) {
  const { view, seat } = table
  const [picked, setPicked] = useState<VisibleCard | null>(null)
  /*
    A card sheet does not outlive the game it is about.

    Tapping a card opens a sheet of what you can do with it, and the game can end while it is open
    — a pass that lets the last damage through, an opponent conceding, the computer's whole turn
    landing in the same write. What is left is a modal full of plays nobody can make, over the top
    of "Nick wins" and the button for another game.

    Found in a browser suite that had been failing one run in a dozen for weeks with nothing to go
    on but "pressed: false". The press was landing on the sheet: *"<div data-testid='play-sheet'>
    intercepts pointer events"*, which is what the suite started recording after the last time it
    happened. An instrument that keeps the whole call log rather than its first line is worth the
    two lines it costs.

    Nor a card that is no longer there. The first version watched only `finished`, and a card
    tapped *after* the game ended left `picked` set — the render guard below hid it, and then the
    rematch dealt a new game, `finished` went false, and a sheet for a Wind Drake from the last
    game appeared over the new one's mulligan prompt. A screenshot caught that too. Asking whether
    the card is still in the view covers both: a rematch renumbers every instance, and so does a
    creature leaving for a zone this seat cannot see.
  */
  const pickedGone = picked !== null && view !== null
    && (view.finished || view.cards[picked.id] === undefined)
  useEffect(() => {
    if (pickedGone) setPicked(null)
  }, [pickedGone])
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
  /*
    What the table sounds like. Driven by the views themselves rather than by the taps that caused
    them, which is the only way it can also speak for the other player's turn — and for the bots',
    which is where most of what you need to hear happens.
  */
  const sound = useTableSound(view)
  /*
    And what the table says. The engine has written a line for every action since the log was
    rewritten to say what happened rather than what was played; this puts the newest of them where
    a player is already looking instead of behind the Log button.
  */
  const feed = useTableFeed(view)
  // Unread count, so a message that arrives while the panel is closed is not missed.
  const [seenChat, setSeenChat] = useState(0)
  useEffect(() => {
    if (showChat) setSeenChat(table.chat.length)
  }, [showChat, table.chat.length])
  const unread = table.chat.length - seenChat
  /**
   * Whether this client is the host, which is who may take a move back.
   *
   * Computed here rather than passed down because the lobby's copy of the same question is in a
   * different component, and a prop threaded through `Board` for one button would be the third
   * place this is worked out.
   */
  const amHost = table.pod?.hostPlayerId != null
    && table.pod.seats.find((s) => s.seat === seat)?.playerId === table.pod.hostPlayerId

  /*
    Every action carries the version of the view it was composed from.

    `table.stateVersion` is what React last rendered, which is the version the player was looking
    at when they chose this. Without it a play that was legal when it was offered and is not legal
    now reads to the client as an illegal action rather than a stale one — see `send`.
  */
  const act = useCallback(
    (action: TableAction) => void table.send(action, table.stateVersion),
    [table],
  )

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
      // With the version it was composed against, exactly as `act` does. The interaction machine
      // reads the rendered view — which play, which targets, whose turn — so an action that comes
      // out of it is as stale as that view is, and the one path that did not say so was the one
      // every button on the control bar goes through: a Pass pressed as blockers became owed read
      // to the client as an illegal action rather than a late one.
      if (result.action !== null) void table.send(result.action, table.stateVersion)
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
      (mode.kind === "ordering" && awaitingKind !== "order") ||
      (mode.kind === "bottoming" && awaitingKind !== "mulligan") ||
      (mode.kind === "choosing" && awaitingKind !== "choose") ||
      (mode.kind === "deciding" && awaitingKind !== "decide") ||
      (mode.kind === "targeting" && view !== null && playsForCard(view, mode.play.card).length === 0) ||
      // Choosing X is as perishable as choosing a target: a counterspell, a land tapped by
      // something else, or the step simply ending can take the play away mid-decision.
      (mode.kind === "payingX" && view !== null && playsForCard(view, mode.play.card).length === 0)
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

  /**
   * The legal choices for the pick the player is on.
   *
   * Aiming a spell and aiming a triggered ability are the same gesture with the same rules, so
   * they light the board the same way — the only difference is which action gets sent.
   */
  const nowChoosing =
    arenaMode.kind === "targeting"
      ? candidatesAt(arenaMode.play, arenaMode.chosen.length, arenaMode.chosen)
      : arenaMode.kind === "choosing"
        ? choiceCandidatesAt(arenaMode.specs, arenaMode.candidates, arenaMode.chosen)
        : []
  const targetableCards = new Set<string>([
    ...nowChoosing.filter((t) => t.kind === "card").map((t) => (t as { id: string }).id),
    /*
      And an ability waiting on the stack, which has no card to light.

      It goes in the same set as the cards because the stack panel is the one place either kind is
      drawn, and ids do not collide: an ability's is `ab<n>` and a card's is never that. The panel
      reads each row's own kind to decide which Target to send back, so nothing here has to.
    */
    ...nowChoosing.filter((t) => t.kind === "ability").map((t) => (t as { id: string }).id),
    // A creature that could be fed to an ability is lit the same way a target is: it is the next
    // thing to tap, and the player should not have to guess which of their creatures qualifies.
    ...(arenaMode.kind === "feeding"
      ? arenaMode.cost === "returned" ? arenaMode.play.returnOptions ?? [] : arenaMode.play.sacrificeOptions
      : []),
    // A card a mid-resolution question is offering is lit exactly like a target, wherever it is —
    // including a library, which is the one zone the table normally does not draw at all.
    ...(arenaMode.kind === "deciding" ? arenaMode.ask.candidates : []),
    // And the blockers waiting to be put in damage order, which are on somebody else's side of
    // the board: without the ring the player is being asked to tap cards that look untappable.
    ...(arenaMode.kind === "ordering" ? arenaMode.owed.flatMap((ask) => ask.blockers) : []),
  ])
  /*
    Proliferate's players, which are the only answers at this table that are not cards
    (CR 701.27a).

    The engine offers them as `seat:N` ids in the same candidate list as the permanents, so the
    lit-cards machinery above already handles half the question. This is the other half: a seat
    strip has no card to light, so it borrows the targetable ring and the tap means "toggle this
    player in the answer" rather than "aim at this player".
  */
  const proliferating = arenaMode.kind === "deciding" && arenaMode.ask.counters === true
  const seatChoice = (index: number): string => `seat:${index}`
  const proliferatingSeats = new Set<number>(
    proliferating
      ? arenaMode.ask.candidates
        .filter((id) => id.startsWith("seat:"))
        .map((id) => Number(id.slice("seat:".length)))
      : [],
  )
  const tapSeat = (index: number): void => {
    if (proliferating) dispatchArena({ kind: "toggleDecision", card: seatChoice(index) })
    else dispatchArena({ kind: "pickTarget", target: { kind: "player", seat: index } })
  }
  const targetableSeats = new Set<number>([
    ...proliferatingSeats,
    ...nowChoosing.filter((t) => t.kind === "player").map((t) => (t as { seat: number }).seat),
    /*
      And a player a dividing spell already points at (CR 601.2d).

      `candidatesAt` drops a target once it is taken, which is right for every other spell and
      wrong for this one: another tap on the same player puts another point of the quantity on
      them. A card does not need this — `onSelect` already lets an already-chosen card through —
      but a seat strip is lit by this set alone.
    */
    ...(arenaMode.kind === "targeting" && dividedAmount(arenaMode.play) !== undefined
      ? arenaMode.chosen.filter((t) => t.kind === "player").map((t) => (t as { seat: number }).seat)
      : []),
  ])
  const chosenIds = new Set<string>(
    arenaMode.kind === "targeting" || arenaMode.kind === "choosing"
      ? arenaMode.chosen.filter((t) => t.kind === "card").map((t) => (t as { id: string }).id)
      : arenaMode.kind === "attackers"
        ? arenaMode.chosen.map((a) => a.attacker)
        : arenaMode.kind === "blockers"
          ? [...arenaMode.chosen.map((b) => b.blocker), ...(arenaMode.holding === null ? [] : [arenaMode.holding])]
          : arenaMode.kind === "ordering"
            ? Object.values(arenaMode.chosen).flat()
            : arenaMode.kind === "bottoming" || arenaMode.kind === "deciding"
              ? arenaMode.chosen
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
    if (mode.kind === "feeding") {
      const allowed = mode.cost === "returned"
        ? mode.play.returnOptions ?? []
        : mode.play.sacrificeOptions
      if (allowed.includes(card.id)) dispatchArena({ kind: "feed", card: card.id })
      return
    }
    if (mode.kind === "choosing") {
      if (targetableCards.has(card.id) || chosenIds.has(card.id)) {
        dispatchArena({ kind: "pickTarget", target: { kind: "card", id: card.id } })
      }
      return
    }
    if (mode.kind === "bottoming") {
      // Tapping a card in hand picks it to go back; tapping it again changes your mind.
      if (card.zone === "hand" && card.zoneSeat === seat) dispatchArena({ kind: "toggleBottom", card: card.id })
      return
    }
    if (mode.kind === "deciding") {
      // Only what the engine offered, and tapping it again takes it back.
      if (mode.ask.candidates.includes(card.id)) dispatchArena({ kind: "toggleDecision", card: card.id })
      return
    }
    if (mode.kind === "targeting") {
      if (targetableCards.has(card.id) || chosenIds.has(card.id)) {
        dispatchArena({ kind: "pickTarget", target: { kind: "card", id: card.id } })
      }
      // A tap on something that is not a legal target does nothing at all, rather than silently
      // dropping out of targeting and leaving the player wondering where their spell went.
      return
    }
    if (mode.kind === "attackers") {
      if (myAttackers.has(card.id) || mode.chosen.some((a) => a.attacker === card.id)) {
        dispatchArena({ kind: "toggleAttacker", card: card.id })
      }
      return
    }
    if (mode.kind === "ordering") {
      // Only the creatures the engine listed, and each into its own attacker's order.
      if (mode.owed.some((ask) => ask.blockers.includes(card.id))) {
        dispatchArena({ kind: "pickOrder", card: card.id })
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
  /**
   * What every zone a spell can point at needs.
   *
   * Not only the battlefield: "return target creature card from your graveyard" aims at a card in
   * a graveyard, and a target the player cannot see lit is a prompt with no visible answer.
   */
  const aiming = { selectedIds: chosenIds, highlightOf, badgesOf }

  const onAttach = (card: VisibleCard) => {
    if (card.attachedTo !== null) {
      act({ type: "card:attach", card: card.id, to: null })
      return
    }
    setAttachFrom(card)
  }

  return (
    // `relative` so the combat overlay can be positioned against the whole board rather than
    // against the viewport: the board scrolls, and an arrow fixed to the viewport would slide off
    // the cards it is pointing at.
    <div
      data-testid="table"
      className="relative isolate flex min-h-dvh flex-col gap-1.5 px-2 pb-2 pt-2 sm:px-4"
    >
      {/*
        The board's own atmosphere, behind everything.

        `isolate` on the row above is what makes the `-z-10` on it safe: without a stacking context
        here, a negative index would put the embers behind the page's own background and nothing
        would be visible at all. With one, they sit under the table's content and over its
        backdrop, which is exactly the one layer they want.
      */}
      <ArenaEmbers />
      {/*
        Who is attacking whom, drawn over the board. Only with the engine running: on a tabletop
        nothing knows what an attack is, and the players point at each other themselves.
      */}
      {automated ? <CombatArrows view={view} /> : null}
      <TableFeed lines={feed} />
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
        {/*
          Take back the last thing that happened — the misclick, which is the one failure at a real
          table that nothing here could recover from.

          Shown only to the host, and only while the server is holding a step to give back: the pod
          says `undoable`, because the client cannot work it out for itself (the step covers the
          server's own replies too, and the host is often not whoever moved).

          It takes back the whole of the last move, including anything the engine or a bot did in
          answer to it, because that is what happened — and the table says in chat that somebody
          took something back, so nobody can quietly rewrite a game.
        */}
        {amHost && table.pod?.undoable === true ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            data-testid="undo"
            title="Take back the last move at this table"
            onClick={() => void table.undo()}
          >
            <Undo2 className="size-3.5" /> Undo
          </Button>
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
        {/*
          The state is on the element rather than only in the icon, because a test cannot read an
          icon and a screen reader should not have to.
        */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          data-testid="toggle-sound"
          data-sound={sound.on ? "on" : "off"}
          aria-pressed={sound.on}
          aria-label={sound.on ? "Sound on" : "Sound off"}
          onClick={sound.toggle}
        >
          {sound.on ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" data-testid="toggle-help" onClick={() => setShowHelp(true)} aria-label="How to play">
          <HelpCircle className="size-3.5" />
        </Button>
      </div>

      {automated ? <PhaseBar view={view} /> : null}

      {view.finished ? (
        <div data-testid="game-over" className="rounded-md border border-[var(--g-gold-400)]/50 bg-[var(--g-gold-400)]/10 px-3 py-2 text-sm font-semibold text-[var(--g-text-high)]">
          {view.winnerSeat === null ? "The game is over." : `${view.seats[view.winnerSeat]?.name} wins.`}{" "}
          {/*
            Two different things, and the difference matters once a game has actually ended.

            "Play again" deals another game at this table with the same decks and the engine still
            running, which is what "again" means and is one tap. "New game" empties the table back
            to an unstarted tabletop, which is what you want when somebody is changing decks or the
            next thing you do is leave.
          */}
          <Button size="sm" className="ml-2 h-7" data-testid="rematch" onClick={() => act({ type: "game:rematch" })}>
            <RotateCcw className="size-3.5" /> Play again
          </Button>
          <Button size="sm" variant="ghost" className="ml-2 h-7" data-testid="new-game" onClick={() => act({ type: "game:reset" })}>
            New game
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

      {/*
        Opponents, side by side once there are several of them.

        A pod stacked vertically is two and a half thousand pixels of board: four hands, four
        battlefields and twelve mostly-empty piles between you and your own cards, and the player
        you are about to be attacked by is off the top of the screen. Three opponents in three
        columns is both shorter and truer — it is where they are sitting. One opponent keeps the
        full width, because a duel has no reason to use half the screen, and a phone keeps the
        stack, because three columns of card on 390 pixels is nothing anybody can read.
      */}
      <div
        className={cn(
          "grid gap-1.5",
          opponents.length === 2 ? "lg:grid-cols-2" : "",
          opponents.length >= 3 ? "lg:grid-cols-3" : "",
        )}
      >
      {opponents.map((o) => (
        <div key={o.index} className="flex min-w-0 flex-col gap-1.5">
          <SeatStrip
            seat={o}
            isMe={false}
            isActive={view.activeSeat === o.index}
            isMonarch={view.monarch === o.index}
            commanderFormat={commanderFormat}
            mySeat={seat}
            onAct={act}
            manualLife={!automated}
            seats={view.seats}
            board={automated ? boardRead(view, o.index) : undefined}
            myLife={automated ? view.seats.find((s) => s.index === seat)?.life : undefined}
            myBlockers={automated ? boardRead(view, seat).ready : undefined}
            targetable={targetableSeats.has(o.index)}
            onTarget={() => tapSeat(o.index)}
            targetVerb={proliferating ? "Choose" : undefined}
            pact={pactBadge(view, o.index)}
            brokeDeal={brokeADeal(view, o.index)}
            hitMe={automated ? damageTakenFrom(view, o.index) : undefined}
            sparedMe={automated ? sparedYouBy(view, o.index) : undefined}
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
          <Battlefield
            label={`${o.name}'s`}
            seat={o.index}
            cards={cardsIn(view, zoneAt(view, o.index, "battlefield"))}
            split={automated}
            onSelect={onSelect}
            selectedId={attachFrom?.id ?? null}
            selectedIds={chosenIds}
            highlightOf={highlightOf}
            badgesOf={badgesOf}
          />
          <div className="grid grid-cols-3 gap-1.5">
            <ZoneRow label="graveyard" testId={`zone-graveyard-${o.index}`} size="pile" cards={cardsIn(view, zoneAt(view, o.index, "graveyard"))} onSelect={onSelect} {...aiming} />
            <ZoneRow label="exile" testId={`zone-exile-${o.index}`} size="pile" cards={cardsIn(view, zoneAt(view, o.index, "exile"))} onSelect={onSelect} {...aiming} />
            {commanderFormat ? (
              <ZoneRow label="command" testId={`zone-command-${o.index}`} size="pile" cards={cardsIn(view, zoneAt(view, o.index, "command"))} onSelect={onSelect} {...aiming} />
            ) : null}
          </div>
        </div>
      ))}
      </div>

      {/*
        The stack, shared. With the engine running it is a list rather than a row of cards: an
        ability on the stack has no card to draw, and what matters is what resolves next and at
        what, which is text.
      */}
      {automated ? (
        <StackPanel
          view={view}
          targetable={targetableCards}
          onPick={(id, kind) => dispatchArena({ kind: "pickTarget", target: { kind, id } })}
        />
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
          isMonarch={view.monarch === seat}
          commanderFormat={commanderFormat}
          mySeat={seat}
          onAct={act}
          manualLife={!automated}
          seats={view.seats}
          board={automated ? boardRead(view, seat) : undefined}
          targetable={targetableSeats.has(seat)}
          onTarget={() => tapSeat(seat)}
          targetVerb={proliferating ? "Choose" : undefined}
        />
      ) : null}
      <Battlefield
        label="Your"
        seat={seat}
        cards={cardsIn(view, zoneAt(view, seat, "battlefield"))}
        split={automated}
        onSelect={onSelect}
        selectedId={attachFrom?.id ?? null}
        selectedIds={chosenIds}
        highlightOf={highlightOf}
        badgesOf={badgesOf}
      />
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {/*
          The graveyard says "playable" too, which it never had reason to before flashback: a card
          in there was always a card you could look at and never a card you could cast, so the one
          row on the table that can now hold a play was the only one with nothing to say about it.
          Same word as the hand and the command zone, for the same reason.
        */}
        <ZoneRow
          label="Your graveyard"
          testId={`zone-graveyard-${seat}`}
          size="pile"
          cards={cardsIn(view, zoneAt(view, seat, "graveyard"))}
          onSelect={onSelect}
          {...aiming}
          badgesOf={(card) => (automated && playsForCard(view, card.id).length > 0 ? ["playable"] : [])}
        />
        {/*
          The badge on this row is newer than the row, and it is cascade that asked for it: a card
          exiled off the top of your library that you may cast for nothing is the only play on the
          table that appears in a pile nobody normally looks at. Foretell and adventure cards live
          here too and wanted it just as much.
        */}
        <ZoneRow
          label="Your exile"
          testId={`zone-exile-${seat}`}
          size="pile"
          cards={cardsIn(view, zoneAt(view, seat, "exile"))}
          onSelect={onSelect}
          {...aiming}
          badgesOf={(card) => (automated && playsForCard(view, card.id).length > 0 ? ["playable"] : [])}
        />
        {/*
          The badge matters more on the command zone than anywhere: a commander is castable on most
          turns of a Commander game, and with no badge the one card you always want to cast was the
          only card on the table that never said it could be. The hand row says the same thing.
        */}
        {commanderFormat ? (
          <ZoneRow
            label="Command zone"
            testId={`zone-command-${seat}`}
            size="pile"
            cards={cardsIn(view, zoneAt(view, seat, "command"))}
            onSelect={onSelect}
            {...aiming}
            badgesOf={(card) => (automated && playsForCard(view, card.id).length > 0 ? ["playable"] : [])}
          />
        ) : null}
      </div>
      {/*
        Scry. The top few cards of your own library, drawn nowhere else on the table and sent to
        nobody else at all — they have no zone of their own in the view, so the row is built from
        the question's own candidate list, which is also what the engine checks the answer
        against. Tapping one marks it for the bottom; the rest stay on top.
      */}
      {arenaMode.kind === "deciding" && arenaMode.ask.from === "library-top" ? (
        <ZoneRow
          label={`Top of your library — ${arenaMode.ask.prompt}`}
          testId={`zone-scry-${seat}`}
          size="pile"
          cards={cardsIn(view, [...arenaMode.ask.candidates])}
          onSelect={onSelect}
          {...aiming}
        />
      ) : null}
      {/* Searching shows your own library, and only while you are looking. */}
      {me?.searching ? (
        <ZoneRow
          label={arenaMode.kind === "deciding" && arenaMode.ask.from === "library"
            ? `Your library — ${arenaMode.ask.prompt}`
            : "Your library (searching)"}
          testId={`zone-library-${seat}`}
          size="pile"
          cards={cardsIn(view, zoneAt(view, seat, "library"))}
          onSelect={onSelect}
          {...aiming}
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
      {/*
        Never over a finished game. The effect above clears a sheet the last damage landed under;
        this stops a new one opening on a table where nothing in it can be played, which is the
        half that a dependency on `view.finished` cannot catch — the flag has already changed by
        the time the card is tapped.
      */}
      {picked !== null && automated && !view.finished ? (
        <PlaySheet
          card={picked}
          plays={playsForCard(view, picked.id)}
          reason={reasonCannotPlay(view, picked.id)}
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
              {automated
                ? "The rules engine runs the turn, the stack and combat, and refuses a play that is not legal. It knows the cards somebody has scripted; anything else still works as cardboard."
                : "It keeps the board, the zones and the life totals honest, and leaves the rules to the two of you — so it works with any card. Tap a card to see what you can do with it."}
            </p>
            <dl className="mt-3 flex flex-col gap-2.5">
              {(automated ? HOW_TO_ARENA : HOW_TO).map(([title, body]) => (
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
        <ChatPanel
          lines={table.chat}
          onSend={(text) => void table.say(text)}
          onClose={() => setShowChat(false)}
        />
      ) : null}

      {showLog ? (
        <div data-testid="log-panel" className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setShowLog(false)}>
          <div className="flex w-full max-w-sm flex-col gap-2 overflow-y-auto border-l border-white/15 bg-[var(--g-surface-2)] p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-[var(--g-text-high)]">What happened</h2>
            {/*
              A pass that did nothing is not something that happened. Most of an automated game's
              log is priority going round the table, and a hundred lines of "Friend passes" is how
              a player loses the four lines that mattered. A pass that ended a step, dealt combat
              damage or killed something keeps its line, because by then it is not a pass any more
              — it is the action that caused all of that, and the engine says so on the same line.
            */}
            {[...view.log]
              .filter((entry) => !isBarePass(entry))
              .reverse()
              .map((entry, i) => (
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

/**
 * The table as somebody watching it sees it.
 *
 * A separate component rather than `Board` with the interaction turned off, and deliberately so:
 * `Board` is a thousand lines of "what may I do with this card", and a watcher may do nothing with
 * any of them. Threading a `readOnly` flag through all of it would put a branch on every tap
 * handler in the file, and the one that was forgotten would be a watcher who could play somebody
 * else's turn.
 *
 * What is shown is exactly what the server sent, which for a watcher is the spectator view: public
 * zones, both hands as face-down counts, no legal moves. There is nothing to redact here, because
 * there is nothing to redact *from* — the hidden cards never left the server.
 */
function Watching({ table }: { table: UseTable }) {
  const { view } = table
  const [showLog, setShowLog] = useState(false)
  const [showChat, setShowChat] = useState(false)
  // The unread count, kept the way the player's table keeps it: the drawer being open is what
  // marks them read, so a watcher with it open never sees a badge for a line already on screen.
  const [seenChat, setSeenChat] = useState(0)
  useEffect(() => {
    if (showChat) setSeenChat(table.chat.length)
  }, [showChat, table.chat.length])
  if (!view) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 p-4">
        <h1 className="text-lg font-semibold text-[var(--g-text-high)]">Watching</h1>
        <p className="text-sm text-[var(--g-text-muted)]">
          Waiting for the table to deal. Nothing is being hidden from you that the players can see.
        </p>
        <Button variant="secondary" onClick={() => void table.leaveTable()}>Stop watching</Button>
      </div>
    )
  }
  const cards = (seat: number, zone: ZoneId): VisibleCard[] => cardsIn(view, zoneAt(view, seat, zone))
  return (
    <div className="flex flex-col gap-2 p-2 sm:p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-semibold text-[var(--g-text-high)]">Watching</h1>
        <span data-testid="watching-code" className="font-mono text-xs text-[var(--g-text-muted)]">
          {table.code}
        </span>
        <span className="text-xs text-[var(--g-text-muted)]">
          turn <span data-testid="turn">{view.turn}</span>
          {view.automation === null ? "" : ` · ${view.automation.stepLabel}`}
        </span>
        {/*
          A watcher can talk, and until now had nowhere to type.

          The server has accepted a spectator's chat since the day watching was built — `pod:chat`
          asks only that the socket is in a pod — and this screen simply never offered it, which is
          why the setup doc said a watcher could not write. It can, the line is labelled as a
          watcher's by the server, and the people playing can tell. See `ChatLine.watching`.
        */}
        <Button size="sm" variant="ghost" className="ml-auto h-7" data-testid="toggle-chat" onClick={() => setShowChat((v) => !v)}>
          Chat
          {table.chat.length - seenChat > 0 ? (
            <span data-testid="chat-unread" className="ml-1 rounded-full bg-[var(--g-gold-400)] px-1.5 text-[10px] font-bold text-black">
              {table.chat.length - seenChat}
            </span>
          ) : null}
        </Button>
        <Button size="sm" variant="ghost" className="h-7" data-testid="toggle-log" onClick={() => setShowLog(true)}>
          What happened
        </Button>
        <Button size="sm" variant="secondary" className="h-7" data-testid="stop-watching" onClick={() => void table.leaveTable()}>
          Stop watching
        </Button>
      </header>

      {showChat ? (
        <ChatPanel
          lines={table.chat}
          onSend={(text) => void table.say(text)}
          onClose={() => setShowChat(false)}
        />
      ) : null}

      {view.finished ? (
        <div data-testid="game-over" className="rounded-md border border-[var(--g-gold-400)]/50 bg-[var(--g-gold-400)]/10 px-3 py-2 text-sm font-semibold text-[var(--g-text-high)]">
          {view.winnerSeat === null ? "The game is over." : `${view.seats[view.winnerSeat]?.name} wins.`}
        </div>
      ) : null}

      <div className={cn("grid gap-1.5", view.seats.length > 2 ? "lg:grid-cols-2" : "")}>
        {view.seats.map((s) => (
          <div key={s.index} className="flex min-w-0 flex-col gap-1.5">
            <SeatStrip
              seat={s}
              isMe={false}
              isActive={view.activeSeat === s.index}
              isMonarch={view.monarch === s.index}
              commanderFormat={view.format === "pod" || view.format === "edh"}
              mySeat={s.index}
              onAct={() => undefined}
              manualLife={false}
              seats={view.seats}
              board={view.automation === null ? undefined : boardRead(view, s.index)}
            />
            <div className="flex gap-1.5">
              <ZoneRow label={`${s.name}'s hand`} testId={`zone-hand-${s.index}`} size="pile" cards={cards(s.index, "hand")} />
              <ZoneRow label="Graveyard" testId={`zone-graveyard-${s.index}`} size="pile" cards={cards(s.index, "graveyard")} />
              <ZoneRow label="Exile" testId={`zone-exile-${s.index}`} size="pile" cards={cards(s.index, "exile")} />
            </div>
            <Battlefield
              label={`${s.name}'s`}
              seat={s.index}
              cards={cards(s.index, "battlefield")}
              split={view.automation !== null}
              badgesOf={(c) => cardBadges(view, c)}
            />
          </div>
        ))}
      </div>

      <ZoneRow label="Stack" testId="zone-stack" size="board" cards={cardsIn(view, stackOf(view))} />

      {showLog ? (
        <div data-testid="log-panel" className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setShowLog(false)}>
          <div className="flex w-full max-w-sm flex-col gap-2 overflow-y-auto border-l border-white/15 bg-[var(--g-surface-2)] p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-[var(--g-text-high)]">What happened</h2>
            {[...view.log]
              .filter((entry) => !isBarePass(entry))
              .reverse()
              .map((entry, i) => (
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
      {table.watching ? (
        <Watching table={table} />
      ) : !seated ? (
        <Lobby table={table} name={name} setName={setName} />
      ) : playing ? (
        <Board table={table} />
      ) : (
        <PreGame table={table} />
      )}
    </>
  )
}
