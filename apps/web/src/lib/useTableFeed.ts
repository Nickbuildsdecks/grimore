/**
 * The last few things that happened, held on screen for a few seconds each.
 *
 * All the rules about *what* is worth saying are in `feed.ts` and tested there. This is the timers
 * and the keys: append what the update added, drop each line when its moment has passed, and never
 * say the same update twice.
 */
import { useEffect, useRef, useState } from "react"
import type { GameView } from "@grimore/rules-engine"
import { newEntries } from "./feed"

/** How long a line stays up. Long enough to read a sentence, short enough not to pile up. */
const LINGER_MS = 4500

export interface FeedLine {
  /** Unique across the game: the engine's own version plus the line's place in that update. */
  readonly key: string
  readonly text: string
}

export function useTableFeed(view: GameView | null): readonly FeedLine[] {
  const [lines, setLines] = useState<readonly FeedLine[]>([])
  const previous = useRef<GameView | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (view === null) return
    const before = previous.current
    previous.current = view
    const added = newEntries(before, view)
    if (added.length === 0) return
    const fresh = added.map((entry, index) => ({
      key: `${entry.version}-${index}`,
      text: entry.message,
    }))
    /*
      Keyed by the engine's version rather than by a counter, and filtered on the way in.

      Two updates can both mention the same entry — a view can arrive twice while the socket
      settles — and a duplicate key is both a React warning and a line that looks like the same
      thing happening twice. The last three are kept because a crowded moment is better read from
      the bottom than from a wall of text.
    */
    setLines((current) => {
      const have = new Set(current.map((line) => line.key))
      const kept = [...current, ...fresh.filter((line) => !have.has(line.key))]
      return kept.slice(-MOST_ON_SCREEN)
    })
    timers.current.push(window.setTimeout(() => {
      const expired = new Set(fresh.map((line) => line.key))
      setLines((current) => current.filter((line) => !expired.has(line.key)))
    }, LINGER_MS))
  }, [view])

  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
  }, [])

  return lines
}

/** At most this many lines are on the board at once, whatever arrives. */
const MOST_ON_SCREEN = 4
