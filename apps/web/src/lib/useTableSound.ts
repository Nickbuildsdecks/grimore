/**
 * The table's cues, wired to the views as they arrive.
 *
 * Separate from `sound.ts` so that file stays free of React: every rule about *when* a cue fires
 * lives in `cuesFor`, which is a pure function with its own tests, and everything here is plumbing
 * — hold the previous view, hold one audio engine, remember whether the player wants to hear it.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { GameView } from "@grimore/rules-engine"
import { createSoundEngine, cuesFor, setSoundOn, soundIsOn, type SoundEngine } from "./sound"

/** How far apart two cues from one action are played, so they read as two things and not a chord. */
const APART_MS = 70

export interface TableSound {
  readonly on: boolean
  readonly toggle: () => void
}

export function useTableSound(view: GameView | null): TableSound {
  const [on, setOn] = useState(soundIsOn)
  const engine = useRef<SoundEngine | null>(null)
  const previous = useRef<GameView | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (view === null) return
    const before = previous.current
    /*
      Recorded whether or not anything is played, and *before* the mute check.

      Otherwise a player who turns the sound on mid-game hears the whole update since they turned
      it off — a dozen draws, a combat and a step change — as one burst. The previous view is a
      fact about the table, not about the volume.
    */
    previous.current = view
    if (!on) return
    const cues = cuesFor(before, view)
    if (cues.length === 0) return
    // Built on the first cue rather than on mount: an AudioContext created before the page has
    // been touched starts suspended, and every browser says so in the console.
    engine.current ??= createSoundEngine()
    cues.forEach((cue, index) => {
      if (index === 0) {
        engine.current?.play(cue)
        return
      }
      timers.current.push(window.setTimeout(() => engine.current?.play(cue), APART_MS * index))
    })
  }, [view, on])

  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer)
    timers.current = []
    engine.current?.close()
    engine.current = null
  }, [])

  const toggle = useCallback(() => {
    setOn((was) => {
      setSoundOn(!was)
      return !was
    })
  }, [])

  return { on, toggle }
}
