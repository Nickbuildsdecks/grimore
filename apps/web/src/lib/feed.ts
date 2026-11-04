/**
 * What the table says out loud about what just happened.
 *
 * The engine has written a line for every action since the log was rewritten to say what *happened*
 * rather than what was played, and until now the only way to read it was to open a panel. A player
 * whose opponent just destroyed their creature should not have to go looking for that.
 *
 * So: the lines this update added, filtered to the ones worth a player's attention, shown briefly
 * on the board and then gone. Same shape as `sound.ts` — a pure function here, the timers in the
 * hook beside it — and the same three updates are silent, for the same reasons.
 */
import type { GameView, LogEntry } from "@grimore/rules-engine"

/**
 * Whether a log entry is worth putting in front of a player.
 *
 * Two things are dropped, both structurally rather than by matching on wording.
 *
 * A **mana ability** carries `produced` in its data, and three of them happen before every spell.
 * "Nick taps Mountain for R" is true, useless, and would push the thing that actually happened off
 * the screen.
 *
 * A **step change** carries `step`, and the phase bar has said the same thing in bigger letters
 * since before this existed. This one was found by looking at a screenshot of the feature working:
 * the first line it ever showed in a real game was "Nick passes — postcombat main".
 *
 * A bare **pass** is the other one. Most passes are nothing — the engine passes for a seat with
 * nothing to do several times a turn — but a pass that resolved something carries the consequence
 * in the same message after a dash or a semicolon, and that is the half worth reading. The log
 * panel has always applied that rule inline; it lives here now, and both read it from one place.
 */
export function worthShowing(entry: LogEntry): boolean {
  if (entry.data !== undefined && "produced" in entry.data) return false
  if (isBarePass(entry)) return false
  // A step or a turn beginning is *where we are*, not what happened, and the phase bar across the
  // top of the table already says it in bigger letters. Unless something resolved on the way,
  // which the engine appends after a semicolon.
  if (entry.data !== undefined && "step" in entry.data && !entry.message.includes(";")) return false
  return true
}

/**
 * A pass that did nothing.
 *
 * Exported because the log panel drops these too, and this is the only rule the two share: the log
 * is the *record* and keeps the mana taps, because "why is that Mountain tapped" is a question a
 * record should answer. The feed is the headline and does not.
 */
export const isBarePass = (entry: LogEntry): boolean =>
  entry.type === "auto:pass" && !/[—;]/.test(entry.message)

/** How many lines of one update are worth keeping. The newest are the ones that matter. */
const MOST = 3

/**
 * The lines `after` added that `before` had not seen, oldest first.
 *
 * Silent in the three cases `cuesFor` is silent in, and for the same reasons: the first view is the
 * table appearing rather than news, a stateVersion that does not advance is an undo or a rematch
 * rather than a sequence of events, and a different table is a different table.
 */
export function newEntries(before: GameView | null, after: GameView, most = MOST): readonly LogEntry[] {
  if (before === null) return []
  if (after.id !== before.id) return []
  if (after.stateVersion <= before.stateVersion) return []
  return after.log
    .filter((entry) => entry.version > before.stateVersion)
    .filter(worthShowing)
    .slice(-most)
}
