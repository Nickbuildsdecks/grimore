/**
 * The client half of the Play Realm table: one socket, one redacted view, one way to send a move.
 *
 * `apps/realtime` is the authority. This holds no game rules at all — it sends an action and renders
 * whatever view comes back, which is what makes the two clients agree. In particular it never knows
 * the contents of the opponent's hand or of either library, because the server does not send them
 * (see `packages/rules-engine/src/view.ts`); a card whose identity is withheld simply has no `card`.
 *
 * Two things here are about not losing a game in progress:
 *
 *  - **The seat is remembered.** A reload would otherwise drop the player, so the code, seat token
 *    and player id are kept in `localStorage` and replayed on connect. The server holds a seat for
 *    two minutes, so a refresh or a dropped phone connection rejoins the same game.
 *  - **A version conflict is retried once.** Both players act at the same time at a real table, and
 *    the loser of the race holds a version that is one behind by the time its action lands. Retrying
 *    against the version the server just broadcast turns that into a non-event rather than an error
 *    the player has to understand.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"
import { unpackView, type GameView, type PackedView } from "@grimore/rules-engine"
import type { Pod, PodErrorEvent, PodListEntry } from "@grimore/shared"

/** Same-origin by default, which is how it runs behind one reverse proxy. */
const REALTIME_URL: string = import.meta.env.VITE_REALTIME_URL ?? ""
const STORE_KEY = "grimore.table.seat"
/** Where the last decklist a player pasted is kept. See `readSavedList`. */
const LIST_KEY = "grimore.table.list"

export type Connection = "connecting" | "connected" | "disconnected"

export interface ChatLine {
  id: string
  seat: number | null
  name: string
  text: string
  at: number
  /**
   * Set by the server for a line from somebody who is watching rather than playing.
   *
   * From the server and not from `seat === null`, because who is a spectator is the server's fact:
   * a client that worked it out for itself would be a second answer to a question with one.
   */
  watching?: boolean
}

export interface TableState {
  connection: Connection
  pod: Pod | null
  view: GameView | null
  stateVersion: number
  /** This client's seat, or null before sitting down — and for a watcher, for good. */
  seat: number | null
  /**
   * Watching rather than playing.
   *
   * Distinct from `seat === null`, which is also true of somebody who has not sat down yet: this
   * says the client asked to watch, and it is what tells the table to render read-only instead of
   * showing a lobby.
   */
  watching: boolean
  code: string | null
  chat: ChatLine[]
  error: string | null
  /**
   * Tables whose host chose to list them, newest server answer first.
   *
   * Only ever populated from the server's own `pod:list`, which lists a table **while it is in the
   * lobby and only if its host asked for it** — so this is not "every game on the server", and a
   * table that has started or was created unlisted is not in here at all. Empty is the normal state
   * for a private pair of players, and the lobby has to read well that way round.
   */
  openTables: readonly PodListEntry[]
}

/** An action minus `by`: the server stamps that from the socket's own seat, so it cannot be forged. */
export type TableAction = Record<string, unknown> & { type: string }

interface StoredSeat {
  code: string
  seatToken: string
  name: string
}

/**
 * What to call a move in an error banner.
 *
 * The action types are the engine's vocabulary — `auto:cast`, `turn:untapAll` — and a player has
 * never seen one. The last segment, spaced out, is close enough to what they tapped: "pass",
 * "declare attackers", "play land".
 */
export function moveName(action: { readonly type: string }): string {
  const tail = action.type.split(":").pop() ?? action.type
  const spaced = tail.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Whether a `pod:error` broadcast is this handler's to show.
 *
 * The server reports every failure twice: once as a `pod:error` event and once on the ack for the
 * call it belongs to. D78 settled who owns the answer — "one owner per answer, and for an action
 * that owner is `send`" — because `send` is the only thing that knows which version the play was
 * composed against, and so the only thing that can tell a stale tap from a real disagreement.
 *
 * The broadcast handler used to defer to that owner by checking whether a call was in flight, and
 * that is a race rather than a rule: the counter reads zero in the gap between a retry's attempts,
 * and again after the eight-second ack timeout fires — which a turn-sixty pod can hit, because the
 * server runs three seats' whole turns inside the human's write. Then the event lands with nobody
 * in flight and the banner goes up for a refusal `send` had deliberately swallowed. That is how a
 * solo pod came to read **"FORBIDDEN: you do not have priority"** with no move named in front of
 * it: no move was named because `send` never wrote it.
 *
 * So the codes an action's ack carries are refused here by code, not by timing. Every event this
 * client sends carries an ack, so nothing is lost by it.
 */
export function showsBroadcastError(err: { readonly code: string }): boolean {
  // Retried in `send`, and a conflict is both players acting at once, which is not an error.
  if (err.code === "version_conflict" || err.code === "rate_limited") return false
  // An action's refusal. `send` decides whether the table had moved past it.
  if (err.code === "illegal_action" || err.code === "game_finished") return false
  return true
}

function readStored(): StoredSeat | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSeat>
    if (typeof parsed.code === "string" && typeof parsed.seatToken === "string" && typeof parsed.name === "string") {
      return { code: parsed.code, seatToken: parsed.seatToken, name: parsed.name }
    }
  } catch {
    /* A reload with unreadable storage just starts at the lobby. */
  }
  return null
}

function writeStored(value: StoredSeat | null): void {
  try {
    if (value === null) localStorage.removeItem(STORE_KEY)
    else localStorage.setItem(STORE_KEY, JSON.stringify(value))
  } catch {
    /* Private browsing: the seat is simply not remembered across a reload. */
  }
}

/** A decklist this browser pasted before, as the player typed it. */
export interface SavedList {
  name?: string
  text: string
}

/**
 * The last list this browser pasted, so playing it again is one tap rather than a trip to Moxfield.
 *
 * In `localStorage` and nowhere else, which is the whole design: a decklist is the player's, the
 * server stores it only for as long as the table lasts, and nothing here needs an account. It
 * survives a reload and a new table, it does not follow the player to another device, and a browser
 * that refuses storage simply never offers it — the same three properties the remembered seat has.
 */
export function readSavedList(): SavedList | null {
  try {
    const raw = localStorage.getItem(LIST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedList>
    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) return null
    return typeof parsed.name === "string" && parsed.name.length > 0
      ? { name: parsed.name, text: parsed.text }
      : { text: parsed.text }
  } catch {
    /* Unreadable or refused storage: there is simply no list to offer. */
    return null
  }
}

export function writeSavedList(value: SavedList | null): void {
  try {
    if (value === null) localStorage.removeItem(LIST_KEY)
    else localStorage.setItem(LIST_KEY, JSON.stringify(value))
  } catch {
    /* Private browsing: the list is not remembered, and nothing else changes. */
  }
}

/** What the server read in a pasted decklist. See `UseTable.sendDeck`. */
export interface PastedDeck {
  total: number
  distinct: number
  sideboard: number
  /** The names the engine's pool does not have, capped by the server. */
  unknown: string[]
  unknownCount: number
  commander?: string
}

/**
 * What the server made of a pasted list, in one line the player can check against their deck.
 *
 * It names the unreadable cards rather than only counting them, because "three cards the engine
 * does not know" is not actionable and "Sol Ring, Mana Crypt, Dockside Extortionist" is: the
 * player can see at a glance whether the list was mistyped or simply outside the pool.
 */
export function pastedNote(deck: PastedDeck): string {
  const parts = [`${deck.total} ${deck.total === 1 ? "card" : "cards"}`]
  if (deck.commander !== undefined) parts.push(`${deck.commander} in the command zone`)
  if (deck.sideboard > 0) parts.push(`${deck.sideboard} in the sideboard, left out`)
  if (deck.unknownCount === 0) parts.push("every one of them scripted")
  else {
    const named = deck.unknown.join(", ")
    const more = deck.unknownCount > deck.unknown.length ? ", and more" : ""
    parts.push(`${deck.unknownCount} the engine does not know (${named}${more}) — tabletop only`)
  }
  return parts.join(" · ")
}

type AckResult =
  | {
      ok: true; code?: string; seat?: number; seatToken?: string; playerId?: string
      stateVersion?: number; deck?: PastedDeck
    }
  | { ok: false; error: PodErrorEvent }

export interface UseTable extends TableState {
  createTable: (input: {
    name: string
    format: string
    visibility?: "public" | "private"
    /** Seats for the server to play, so one person can start a table and play now. */
    bots?: number
    botDeck?: string
    /** A deck each, in seat order, when the bots should not all play the same one. */
    botDecks?: readonly string[]
  }) => Promise<void>
  joinTable: (input: { code: string; name: string }) => Promise<void>
  /** Joins a table's room without taking a seat; the server sends the spectator view. */
  watchTable: (code: string, name?: string) => Promise<void>
  leaveTable: () => Promise<void>
  setReady: (ready: boolean) => Promise<void>
  /**
   * Hands the table a decklist this player pasted in, and reports what the **server** read.
   *
   * The text goes up rather than a parsed list, because the server's parser is the one that
   * decides: what comes back is how many cards it found, how many different ones, and which of
   * them the engine's pool does not have. `null` when the table refused it, with the reason in
   * `error` like any other refusal.
   */
  sendDeck: (text: string, name?: string) => Promise<PastedDeck | null>
  /**
   * Sends an action. `basedOn` is the `stateVersion` of the view it was *composed from*, which is
   * what tells a stale action apart from an illegal one — see the refusal handling in `send`.
   */
  send: (action: TableAction, basedOn?: number) => Promise<void>
  /**
   * Asks the server to put the table back to before the last move. Host only, one step.
   *
   * Queued behind the actions like everything else, because an undo pressed while a tap is still
   * in flight has to mean "take back whichever of these landed last" rather than racing it.
   */
  undo: () => Promise<void>
  say: (text: string) => Promise<void>
  /**
   * Asks the server for the listed tables again.
   *
   * A pull rather than a subscription, because a lobby list is not worth a broadcast to every
   * connected socket every time somebody opens a table: the lobby asks on connect and when the
   * player presses refresh, which is the two moments the answer is looked at.
   */
  refreshTables: () => void
  clearError: () => void
}

export function useTable(playerName: string): UseTable {
  const [state, setState] = useState<TableState>({
    connection: "connecting",
    pod: null,
    view: null,
    stateVersion: 0,
    seat: null,
    watching: false,
    code: null,
    chat: [],
    error: null,
    openTables: [],
  })
  const socketRef = useRef<Socket | null>(null)
  /**
   * The newest state, for the callbacks that must not read a captured copy.
   *
   * `leaveTable` is the one that matters: whether this client is watching decides whether there is
   * a seat to give up, and a stale `false` would send a `pod:leave` that the server refuses.
   */
  const stateRef = useRef<TableState | null>(null)
  /** Read inside `send`, which must use the newest version rather than one captured by a closure. */
  const versionRef = useRef(0)
  const seatRef = useRef<number | null>(null)
  /**
   * The display name, kept in a ref rather than as an effect dependency.
   *
   * The connection effect used to depend on it, which meant every keystroke in the name field tore
   * the socket down and opened a new one — so typing a name and immediately creating a table raced
   * a handshake that was already being abandoned, and the create silently never answered. The name
   * is only ever read when creating or joining, so it does not belong in the dependency list.
   */
  const nameRef = useRef(playerName)
  /**
   * Actions go out one at a time.
   *
   * The server uses optimistic concurrency: an action carries the version it was composed against
   * and is refused if the pod has moved on. Firing several at once therefore loses all but the
   * first — which is exactly what tapping the life button five times quickly does, and losing four
   * of those taps is not acceptable at a table. Serialising means each action is composed against
   * the version the one before it produced, so a burst applies in full and in order.
   */
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    nameRef.current = playerName
    // Keep the handshake payload current for any later reconnect, without reconnecting now.
    if (socketRef.current) socketRef.current.auth = { name: playerName }
  }, [playerName])

  useEffect(() => {
    const socket = io(REALTIME_URL, {
      // Websocket only, to match the server: `apps/realtime` sets `transports: ['websocket']` with
      // `allowUpgrades: false`, so offering polling as a fallback just produces a 400 "Transport
      // unknown" on the first handshake attempt.
      transports: ["websocket"],
      auth: { name: nameRef.current },
    })
    socketRef.current = socket

    socket.on("connect", () => {
      setState((s) => ({ ...s, connection: "connected" }))
      // The listed tables, asked for once the socket is up. Before this the lobby had nothing to
      // show on arrival and a player's only way in was a code somebody had sent them.
      socket.emit("pod:list", {})
      // Reclaim a seat left behind by a reload or a dropped connection.
      const stored = readStored()
      if (!stored) return
      socket.emit(
        "pod:join",
        { code: stored.code, name: stored.name, seatToken: stored.seatToken },
        (res: AckResult) => {
          if (res.ok) {
            seatRef.current = res.seat ?? null
            setState((s) => ({ ...s, seat: res.seat ?? null, code: stored.code }))
          } else {
            // The table is gone or the grace window closed; forget it rather than retrying forever.
            writeStored(null)
          }
        },
      )
    })
    socket.on("disconnect", () => setState((s) => ({ ...s, connection: "disconnected" })))
    socket.io.on("reconnect_attempt", () => setState((s) => ({ ...s, connection: "connecting" })))

    socket.on("pod:state", (payload: { pod: Pod; state: PackedView | null; stateVersion: number }) => {
      versionRef.current = payload.stateVersion
      // The server sends the view in its wire form — each card definition said once, and the
      // fields that are false on almost every card left out — which halves a payload with a
      // library open. Unpacked here, once, so every component downstream sees the same `GameView`
      // it always did and nothing else in the app knows the wire form exists.
      const view = payload.state === null ? null : unpackView(payload.state)
      setState((s) => {
        // The server is authoritative about which seat this socket is, including after the table is
        // dealt and seat indices are compacted.
        const mine = view?.seat ?? s.seat
        seatRef.current = mine
        return {
          ...s,
          pod: payload.pod,
          view,
          stateVersion: payload.stateVersion,
          seat: mine,
          code: payload.pod.code,
        }
      })
    })
    socket.on("pod:error", (err: PodErrorEvent) => {
      // By code rather than by whether a call is in flight, which was a race. See
      // `showsBroadcastError`.
      if (!showsBroadcastError(err)) return
      setState((s) => ({ ...s, error: err.message }))
    })
    socket.on("pod:chat", (line: ChatLine) => {
      setState((s) => ({ ...s, chat: [...s.chat.slice(-99), line] }))
    })
    socket.on("pod:list", (payload: { pods: readonly PodListEntry[] }) => {
      // Replaced wholesale rather than merged: the server's answer is the whole list, and a table
      // that has started or gone away is absent from it rather than marked.
      setState((s) => ({ ...s, openTables: payload.pods }))
    })

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
    // One socket for the lifetime of the page. See `nameRef` above for why the name is not a dep.
  }, [])

  const emit = useCallback((event: string, payload: unknown): Promise<AckResult> => {
    const socket = socketRef.current
    if (!socket) return Promise.resolve({ ok: false, error: { code: "internal", message: "not connected" } })
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: { code: "internal", message: "the table did not answer" } }),
        8000,
      )
      socket.emit(event, payload, (res: AckResult) => {
        clearTimeout(timer)
        resolve(res)
      })
    })
  }, [])

  const createTable = useCallback<UseTable["createTable"]>(
    async (input) => {
      const res = await emit("pod:create", {
        name: input.name,
        format: input.format,
        visibility: input.visibility ?? "private",
        playerName: nameRef.current,
        bots: input.bots ?? 0,
        ...(input.botDeck === undefined ? {} : { botDeck: input.botDeck }),
        ...(input.botDecks === undefined ? {} : { botDecks: [...input.botDecks] }),
      })
      if (!res.ok) return setState((s) => ({ ...s, error: res.error.message }))
      if (res.code && res.seatToken) writeStored({ code: res.code, seatToken: res.seatToken, name: nameRef.current })
      seatRef.current = res.seat ?? 0
      setState((s) => ({ ...s, seat: res.seat ?? 0, code: res.code ?? null, error: null }))
    },
    [emit],
  )

  const watchTable = useCallback<UseTable["watchTable"]>(
    async (raw, name) => {
      const code = raw.trim().toUpperCase()
      // The name is for the chat and nothing else: a watcher with none talks as "Watcher", which
      // is at least not what a player is called.
      const trimmed = (name ?? "").trim()
      const res = await emit("pod:watch", { code, ...(trimmed === "" ? {} : { name: trimmed }) })
      if (!res.ok) return setState((s) => ({ ...s, error: res.error.message }))
      // No seat token stored: a watcher holds nothing, so there is nothing to reclaim on a reload
      // and nothing to leave behind on somebody else's machine.
      setState((s) => ({ ...s, seat: null, watching: true, code, error: null }))
    },
    [emit],
  )

  const joinTable = useCallback<UseTable["joinTable"]>(
    async (input) => {
      const code = input.code.trim().toUpperCase()
      const res = await emit("pod:join", { code, name: input.name })
      if (!res.ok) return setState((s) => ({ ...s, error: res.error.message }))
      if (res.seatToken) writeStored({ code, seatToken: res.seatToken, name: input.name })
      seatRef.current = res.seat ?? null
      setState((s) => ({ ...s, seat: res.seat ?? null, code, error: null }))
    },
    [emit],
  )

  const leaveTable = useCallback<UseTable["leaveTable"]>(async () => {
    // A watcher has no seat to give up, and `pod:leave` wants one — so it is not sent. Dropping
    // the local state is the whole of stopping watching; the socket leaves the room on the next
    // join or on disconnect, and until then it is one more listener on a broadcast nobody pays
    // for. Said plainly here because the asymmetry looks like a missing call.
    if (!stateRef.current?.watching) {
      await emit("pod:leave", {})
      writeStored(null)
    }
    seatRef.current = null
    setState((s) => ({
      ...s, pod: null, view: null, seat: null, watching: false, code: null, chat: [], error: null,
    }))
    // Back in the lobby, so the list is worth asking for again: whatever was open when this player
    // sat down is minutes stale by the time they stand up.
    socketRef.current?.emit("pod:list", {})
  }, [emit])

  const setReady = useCallback<UseTable["setReady"]>(
    async (ready) => {
      const res = await emit("pod:ready", { ready })
      if (!res.ok) setState((s) => ({ ...s, error: res.error.message }))
    },
    [emit],
  )

  const sendDeck = useCallback<UseTable["sendDeck"]>(
    async (text, name) => {
      const res = await emit("pod:deck", {
        text,
        ...(name === undefined || name.trim().length === 0 ? {} : { name: name.trim() }),
      })
      if (!res.ok) {
        setState((s) => ({ ...s, error: res.error.message }))
        return null
      }
      // The summary rather than nothing, because the caller's next question is "what did it make
      // of that?" — and the counts in the broadcast state are for the table, not for the sender.
      return res.deck ?? null
    },
    [emit],
  )

  const send = useCallback<UseTable["send"]>(
    (action, basedOn) => {
      const run = async (): Promise<void> => {
        // The version this action was composed against, so a refusal can be told apart from a
        // disagreement. See the `illegal_action` case below.
        let sentAt = versionRef.current
        const attempt = async (): Promise<AckResult> => {
          sentAt = versionRef.current
          return emit("pod:action", { action, expectedVersion: sentAt })
        }
        let res = await attempt()
        // Two reasons an action bounces, and both are worth simply retrying rather than showing
        // the player an error for something they did nothing wrong to cause:
        //
        //  - `version_conflict`: both players acted at once, as they do at a real table, and this
        //    one is a version behind. Serialisation handles our own bursts; this handles theirs.
        //  - `rate_limited`: the server allows 20 events a second with a burst of 40, and a
        //    Commander player tapping 40 life down to zero sends exactly that many. Backing off
        //    and re-sending is the difference between the taps landing and the player watching
        //    half of them vanish behind an error.
        for (let retry = 0; retry < 6; retry++) {
          if (res.ok) break
          const code = res.error.code
          if (code !== "version_conflict" && code !== "rate_limited") break
          await new Promise((r) => setTimeout(r, code === "rate_limited" ? 120 : 40))
          res = await attempt()
        }
        // Take the version from the ack rather than waiting for the broadcast. The ack is the
        // authoritative result of this action and arrives first, so the next action in the queue
        // composes against the right version instead of one that is briefly stale.
        if (res.ok && typeof res.stateVersion === "number") versionRef.current = res.stateVersion
        if (res.ok) return
        /**
         * An action the game had already moved past is not an error the player caused.
         *
         * Both players act at once at a real table. Tapping Pass a fraction of a second before an
         * opponent's spell starts resolving sends a pass the engine then refuses — correctly, since
         * nobody holds priority during a resolution — but the player did nothing wrong and an error
         * banner saying so is just wrong. The test for it is precise: the pod has moved past the
         * version this action was composed against, so what was offered was a view a moment stale.
         *
         * A refusal at the *current* version is a real disagreement between the table and the
         * engine, and still shows — that is the one worth seeing, and `playout.test.ts` asserts
         * deterministically that it should never happen.
         */
        /*
          Three versions, and it took all three.

          `composedAt` is the version the play was built from — the view React last rendered. Not
          `sentAt`: by the time a finger lands the table may have moved on, and the action goes out
          stamped with the *newest* version because that is what the store accepts, so `sentAt`
          says "current" for a play that is two versions stale. That was the first failure: the
          player got "Firebrand Archer can only be cast in your main phase with an empty stack" for
          tapping a button the table was showing them.

          `versionRef` is the newest version this client has *acked*, and on its own it is not
          enough either. A broadcast can carry the rendered view past the last ack — in a pod with
          three server seats it does constantly — and then it sits *behind* `composedAt` and this
          guard reads false for a play the table had plainly moved past. That was the second
          failure: "attackers must be declared before anyone passes", over a Pass the table was
          offering.

          `refusedAt` is the server's own version when it said no, and it is the one that settles
          it. Both of the others are kept because either can be ahead.
        */
        const refusedAt = res.error.stateVersion
        const composedAt = basedOn ?? sentAt
        const movedOn = versionRef.current > composedAt
          || (refusedAt !== undefined && refusedAt > composedAt)
        if (res.error.code === "illegal_action" && movedOn) return
        /**
         * Nor is an action that arrived after the game ended.
         *
         * The version test above misses this one, because a queued action re-composes against the
         * version the ack just handed back: the pass that kills the last opponent and the pass
         * behind it in the queue both go out at the newest version, so the second is refused at a
         * version that has not moved since it was sent. A real player hits it by tapping Pass a
         * beat before the final damage lands, and reading "the game is finished" in red over
         * "Nick wins" is no kind of answer. Caught by the solo pod browser suite, which does
         * exactly that at machine speed, every run.
         */
        if (res.error.code === "game_finished") return
        // Named, so a player knows which of their taps the table is complaining about — and so
        // the next failure of this kind can be read off a screenshot instead of guessed at.
        setState((s) => ({ ...s, error: `${moveName(action)}: ${res.error.message}` }))
      }
      // Chain onto the queue, and never let one failure break the chain for everything after it.
      const queued = queueRef.current.then(run, run)
      queueRef.current = queued.catch(() => undefined)
      return queued
    },
    [emit],
  )

  const undo = useCallback<UseTable["undo"]>(() => {
    const run = async (): Promise<void> => {
      const res = await emit("pod:undo", {})
      if (res.ok) {
        if (typeof res.stateVersion === "number") versionRef.current = res.stateVersion
        return
      }
      // Nothing to take back is not worth a banner: the button is gone the moment the pod says
      // so, and a press that crossed with somebody else's move has simply lost the race.
      if (res.error.code === "nothing_to_undo") return
      setState((s) => ({ ...s, error: res.error.message }))
    }
    const queued = queueRef.current.then(run, run)
    queueRef.current = queued.catch(() => undefined)
    return queued
  }, [emit])

  const refreshTables = useCallback<UseTable["refreshTables"]>(() => {
    socketRef.current?.emit("pod:list", {})
  }, [])

  const say = useCallback<UseTable["say"]>(
    async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      await emit("pod:chat", { text: trimmed })
    },
    [emit],
  )

  stateRef.current = state

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), [])

  return useMemo(
    () => ({
      ...state, createTable, joinTable, watchTable, leaveTable, setReady, sendDeck, send, undo, say,
      refreshTables, clearError,
    }),
    [state, createTable, joinTable, watchTable, leaveTable, setReady, sendDeck, send, undo, say,
      refreshTables, clearError],
  )
}

/** Opponents first, in seating order, so a two-player table always renders across from you. */
export function opponentSeats(view: GameView | null, seat: number | null): number[] {
  if (!view) return []
  return view.seats.map((s) => s.index).filter((i) => i !== seat)
}
