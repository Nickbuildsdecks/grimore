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
import type { GameView } from "@grimore/rules-engine"
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
  /** This client's seat, or null before sitting down. */
  seat: number | null
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
  createTable: (input: { name: string; format: string; visibility?: "public" | "private" }) => Promise<void>
  joinTable: (input: { code: string; name: string }) => Promise<void>
  leaveTable: () => Promise<void>
  setReady: (ready: boolean) => Promise<void>
  send: (action: TableAction) => Promise<void>
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
    code: null,
    chat: [],
    error: null,
  })
  const socketRef = useRef<Socket | null>(null)
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

    socket.on("pod:state", (payload: { pod: Pod; state: GameView | null; stateVersion: number }) => {
      versionRef.current = payload.stateVersion
      setState((s) => {
        // The server is authoritative about which seat this socket is, including after the table is
        // dealt and seat indices are compacted.
        const mine = payload.state?.seat ?? s.seat
        seatRef.current = mine
        return {
          ...s,
          pod: payload.pod,
          view: payload.state,
          stateVersion: payload.stateVersion,
          seat: mine,
          code: payload.pod.code,
        }
      })
    })
    socket.on("pod:error", (err: PodErrorEvent) => {
      // A conflict is retried in `send` and is not worth showing.
      if (err.code === "version_conflict") return
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
      })
      if (!res.ok) return setState((s) => ({ ...s, error: res.error.message }))
      if (res.code && res.seatToken) writeStored({ code: res.code, seatToken: res.seatToken, name: nameRef.current })
      seatRef.current = res.seat ?? 0
      setState((s) => ({ ...s, seat: res.seat ?? 0, code: res.code ?? null, error: null }))
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
    await emit("pod:leave", {})
    writeStored(null)
    seatRef.current = null
    setState((s) => ({ ...s, pod: null, view: null, seat: null, code: null, chat: [], error: null }))
  }, [emit])

  const setReady = useCallback<UseTable["setReady"]>(
    async (ready) => {
      const res = await emit("pod:ready", { ready })
      if (!res.ok) setState((s) => ({ ...s, error: res.error.message }))
    },
    [emit],
  )

  const send = useCallback<UseTable["send"]>(
    (action) => {
      const run = async (): Promise<void> => {
        const attempt = async (): Promise<AckResult> =>
          emit("pod:action", { action, expectedVersion: versionRef.current })
        let res = await attempt()
        // Both players act at once at a real table. The loser of that race is simply one version
        // behind, so re-send against the version the server has just broadcast. Serialisation
        // handles our own bursts; this handles the other player's.
        for (let retry = 0; retry < 3 && !res.ok && res.error.code === "version_conflict"; retry++) {
          await new Promise((r) => setTimeout(r, 40))
          res = await attempt()
        }
        // Take the version from the ack rather than waiting for the broadcast. The ack is the
        // authoritative result of this action and arrives first, so the next action in the queue
        // composes against the right version instead of one that is briefly stale.
        if (res.ok && typeof res.stateVersion === "number") versionRef.current = res.stateVersion
        if (!res.ok) setState((s) => ({ ...s, error: res.error.message }))
      }
      // Chain onto the queue, and never let one failure break the chain for everything after it.
      const queued = queueRef.current.then(run, run)
      queueRef.current = queued.catch(() => undefined)
      return queued
    },
    [emit],
  )

  const say = useCallback<UseTable["say"]>(
    async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      await emit("pod:chat", { text: trimmed })
    },
    [emit],
  )

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), [])

  return useMemo(
    () => ({ ...state, createTable, joinTable, leaveTable, setReady, send, say, clearError }),
    [state, createTable, joinTable, leaveTable, setReady, send, say, clearError],
  )
}

/** Opponents first, in seating order, so a two-player table always renders across from you. */
export function opponentSeats(view: GameView | null, seat: number | null): number[] {
  if (!view) return []
  return view.seats.map((s) => s.index).filter((i) => i !== seat)
}
