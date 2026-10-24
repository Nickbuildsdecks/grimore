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
import type { Pod, PodErrorEvent } from "@grimore/shared"

/** Same-origin by default, which is how it runs behind one reverse proxy. */
const REALTIME_URL: string = import.meta.env.VITE_REALTIME_URL ?? ""
const STORE_KEY = "grimore.table.seat"

export type Connection = "connecting" | "connected" | "disconnected"

export interface ChatLine {
  id: string
  seat: number | null
  name: string
  text: string
  at: number
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
}

/** An action minus `by`: the server stamps that from the socket's own seat, so it cannot be forged. */
export type TableAction = Record<string, unknown> & { type: string }

interface StoredSeat {
  code: string
  seatToken: string
  name: string
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

type AckResult =
  | { ok: true; code?: string; seat?: number; seatToken?: string; playerId?: string; stateVersion?: number }
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
  watchTable: (code: string) => Promise<void>
  leaveTable: () => Promise<void>
  setReady: (ready: boolean) => Promise<void>
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
  /**
   * How many calls of ours are waiting for an answer.
   *
   * Every handler on the server answers the ack *and* emits `pod:error`, so while one of our calls
   * is in flight that event is a second copy of an answer the caller is already judging. Judging it
   * twice is worse than useless: the handler below has none of the context `send` uses to decide a
   * refusal is not the player's fault, so it put the banner back up for every refusal `send` had
   * deliberately swallowed. One owner per answer, and for an action that owner is `send`.
   */
  const inFlightRef = useRef(0)
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
      // The ack for the call this belongs to decides. See `inFlightRef`.
      if (inFlightRef.current > 0) return
      // Retried or deliberately swallowed in `send`, so none of these is worth showing.
      if (err.code === "version_conflict" || err.code === "rate_limited") return
      if (err.code === "game_finished") return
      setState((s) => ({ ...s, error: err.message }))
    })
    socket.on("pod:chat", (line: ChatLine) => {
      setState((s) => ({ ...s, chat: [...s.chat.slice(-99), line] }))
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
    inFlightRef.current += 1
    return new Promise((resolve) => {
      const done = (res: AckResult): void => {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1)
        resolve(res)
      }
      const timer = setTimeout(
        () => done({ ok: false, error: { code: "internal", message: "the table did not answer" } }),
        8000,
      )
      socket.emit(event, payload, (res: AckResult) => {
        clearTimeout(timer)
        done(res)
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
    async (raw) => {
      const code = raw.trim().toUpperCase()
      const res = await emit("pod:watch", { code })
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
  }, [emit])

  const setReady = useCallback<UseTable["setReady"]>(
    async (ready) => {
      const res = await emit("pod:ready", { ready })
      if (!res.ok) setState((s) => ({ ...s, error: res.error.message }))
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
          The version the action was *composed against*, which is not always the one it was sent
          at.

          A play is built from the view React last rendered. By the time the player's finger lands
          the table may have moved on — in a pod with three server seats it moves constantly — and
          the action then goes out stamped with the *newest* version, because that is what the
          store would accept. So `sentAt` says "current" while the play itself is a version or two
          stale, and the guard below never fired: the player got "Firebrand Archer can only be
          cast in your main phase with an empty stack" for tapping a button the table was showing
          them. Caught by the solo pod suite, which taps as fast as the server plays.

          `basedOn` is the rendered view's version, so "the table has moved since this play was
          offered" is a question that can actually be asked.
        */
        if (res.error.code === "illegal_action" && versionRef.current > (basedOn ?? sentAt)) return
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
        setState((s) => ({ ...s, error: res.error.message }))
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
      ...state, createTable, joinTable, watchTable, leaveTable, setReady, send, undo, say, clearError,
    }),
    [state, createTable, joinTable, watchTable, leaveTable, setReady, send, undo, say, clearError],
  )
}

/** Opponents first, in seating order, so a two-player table always renders across from you. */
export function opponentSeats(view: GameView | null, seat: number | null): number[] {
  if (!view) return []
  return view.seats.map((s) => s.index).filter((i) => i !== seat)
}
