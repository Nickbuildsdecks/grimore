/**
 * Who is attacking whom, drawn on the board rather than described beside it.
 *
 * The engine has known the defender of every attack since combat was written, and until now the
 * only thing on screen that said so was a badge on the creature reading "attacking Ana". With one
 * opponent that badge is enough; with three it is a sentence you have to read four times to work
 * out what is happening to you. So: a line from each attacker to the player it is aimed at, and a
 * line from each blocker to the attacker it is blocking.
 *
 * Everything here is measured from the DOM, because the board's layout is the board's business:
 * the cards are in flex rows that wrap, inside containers that scroll, on a page that resizes.
 * The alternative — the overlay knowing where the cards are — would be a second layout engine
 * disagreeing with the first the moment a hand grew by one card.
 *
 * It draws nothing at all when there is no combat, which is most of a game.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { GameView } from "@grimore/rules-engine"
import { attackSummary } from "@/lib/arena"

/** One arrow, in the overlay's own coordinates. */
interface Arrow {
  readonly key: string
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  /** A block is drawn differently from an attack: it is an answer, not a threat. */
  readonly kind: "attack" | "block"
}

const centreOf = (el: Element, host: DOMRect): { x: number; y: number } => {
  const box = el.getBoundingClientRect()
  return { x: box.left + box.width / 2 - host.left, y: box.top + box.height / 2 - host.top }
}

/**
 * Where an arrow should land on a seat row: the edge facing whatever is pointing at it.
 *
 * Not the middle, which would bury the arrowhead under the player's name, and not always the top
 * either — an opponent's row sits above your creatures and a pod's rows sit on both sides, so the
 * edge that faces the attacker is the only one that reads as being pointed at.
 */
const edgeOf = (el: Element, host: DOMRect, fromY: number): { x: number; y: number } => {
  const box = el.getBoundingClientRect()
  const top = box.top - host.top
  const bottom = box.bottom - host.top
  const centre = (top + bottom) / 2
  return { x: box.left + box.width / 2 - host.left, y: fromY > centre ? bottom : top }
}

/** Whether two measurements are the same picture, to the pixel. */
const same = (a: readonly Arrow[], b: readonly Arrow[]): boolean =>
  a.length === b.length
  && a.every((arrow, i) => {
    const other = b[i]!
    return arrow.key === other.key && arrow.kind === other.kind
      && arrow.x1 === other.x1 && arrow.y1 === other.y1
      && arrow.x2 === other.x2 && arrow.y2 === other.y2
  })

export function CombatArrows({ view }: { view: GameView }) {
  const host = useRef<HTMLDivElement | null>(null)
  const [arrows, setArrows] = useState<readonly Arrow[]>([])
  const attacks = attackSummary(view)
  /*
    Two guards against re-measuring forever, both of which this component needed.

    `attackSummary` builds a fresh array on every render, so anything that depended on it by
    identity — a `useCallback`, and then the effect that depends on the callback — was new on every
    render too. The effect measured, `setArrows` got a new array, that re-rendered, and round it
    went: React's "Maximum update depth exceeded" thousands of times per game, but *only while
    something was attacking*, because the no-combat path already returned the existing state
    unchanged. A four-player pod spent the rest of its combat step re-rendering instead of
    answering taps, which is how it was found: the pod browser suite stalled at declare-blockers
    with nothing on screen to press.

    So the combat is depended on by value — a string that changes when the attacks or the blocks do
    — and the measurement is kept in a ref so the callback can be stable. And `setArrows` returns
    the state it was given when the new measurement is identical, which is also what makes a scroll
    or a resize that moved nothing cost nothing.
  */
  const combatKey = attacks
    .map((a) => `${a.attacker}>${a.defender}/${a.planeswalker ?? ""}:${[...a.blockers].join("+")}`)
    .join(";")
  const latest = useRef(attacks)
  latest.current = attacks

  /**
   * Re-measures every arrow.
   *
   * Called on every view change and again whenever the page moves under it. Cheap enough to do
   * that way — a handful of `getBoundingClientRect` calls on a board that has at most a few
   * attackers — and the alternative is an arrow pointing at where a card used to be.
   */
  const measure = useCallback(() => {
    const node = host.current
    if (node === null) return
    const attacks = latest.current
    if (attacks.length === 0) {
      setArrows((current) => (current.length === 0 ? current : []))
      return
    }
    const box = node.getBoundingClientRect()
    const found: Arrow[] = []
    for (const attack of attacks) {
      const from = document.querySelector(`[data-testid="card-${attack.attacker}"]`)
      // An attack aimed at a planeswalker points at the card, not at its controller's row: that
      // is the whole difference the player needs to see.
      const to = attack.planeswalker === undefined
        ? document.querySelector(`[data-testid="seat-${attack.defender}"]`)
        : document.querySelector(`[data-testid="card-${attack.planeswalker}"]`)
      if (from !== null && to !== null) {
        const start = centreOf(from, box)
        const end = attack.planeswalker === undefined
          ? edgeOf(to, box, start.y)
          : centreOf(to, box)
        found.push({ key: `a-${attack.attacker}`, x1: start.x, y1: start.y, x2: end.x, y2: end.y, kind: "attack" })
      }
      for (const blocker of attack.blockers) {
        const blockerEl = document.querySelector(`[data-testid="card-${blocker}"]`)
        if (blockerEl === null || from === null) continue
        const start = centreOf(blockerEl, box)
        const end = centreOf(from, box)
        found.push({
          key: `b-${blocker}-${attack.attacker}`,
          x1: start.x, y1: start.y, x2: end.x, y2: end.y, kind: "block",
        })
      }
    }
    setArrows((current) => (same(current, found) ? current : found))
  }, [])

  useEffect(() => {
    measure()
    // The board moves for reasons that have nothing to do with the game state: a scroll, a
    // rotation, a window drag, a zone row growing. All of them move a card out from under its
    // arrow, so all of them re-measure.
    const onMove = () => measure()
    window.addEventListener("resize", onMove)
    window.addEventListener("scroll", onMove, true)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onMove)
    if (observer !== null && host.current !== null) observer.observe(document.body)
    return () => {
      window.removeEventListener("resize", onMove)
      window.removeEventListener("scroll", onMove, true)
      observer?.disconnect()
    }
  }, [measure, combatKey])

  return (
    <div
      ref={host}
      data-testid="combat-arrows"
      aria-hidden
      /*
        `pointer-events-none` is not decoration: this sits over the whole board, and without it
        every card underneath would stop being tappable the moment somebody attacked.
      */
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {arrows.length === 0 ? null : (
        <svg className="size-full" aria-hidden>
          <defs>
            <marker id="arrow-attack" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--g-gold-400)" />
            </marker>
            <marker id="arrow-block" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--g-status-info)" />
            </marker>
          </defs>
          {arrows.map((arrow) => (
            <line
              key={arrow.key}
              data-testid={`arrow-${arrow.key}`}
              x1={arrow.x1}
              y1={arrow.y1}
              x2={arrow.x2}
              y2={arrow.y2}
              stroke={arrow.kind === "attack" ? "var(--g-gold-400)" : "var(--g-status-info)"}
              strokeWidth={arrow.kind === "attack" ? 2 : 1.5}
              strokeOpacity={arrow.kind === "attack" ? 0.75 : 0.6}
              strokeDasharray={arrow.kind === "block" ? "4 3" : undefined}
              markerEnd={arrow.kind === "attack" ? "url(#arrow-attack)" : "url(#arrow-block)"}
            />
          ))}
        </svg>
      )}
    </div>
  )
}
