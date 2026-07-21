import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { Eye, Heart, RotateCcw, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface SwipeStackProps<T> {
  items: T[]
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  ariaLabel: string
  onAccept: (item: T) => void
  onReject: (item: T) => void
  onInspect: (item: T) => void
  acceptLabel: string
  rejectLabel: string
  inspectLabel: string
  empty?: ReactNode
}

type ExitDirection = "left" | "right" | null

export function SwipeStack<T>({ items, getKey, renderItem, ariaLabel, onAccept, onReject, onInspect, acceptLabel, rejectLabel, inspectLabel, empty }: SwipeStackProps<T>) {
  const [index, setIndex] = useState(0)
  const [dragX, setDragX] = useState(0)
  const [exit, setExit] = useState<ExitDirection>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const exitTimer = useRef<number | null>(null)
  const signature = useMemo(() => `${items.length}:${items[0] ? getKey(items[0]) : "empty"}`, [getKey, items])

  useEffect(() => {
    setIndex(0)
    setDragX(0)
    setExit(null)
  }, [signature])

  useEffect(() => () => {
    if (exitTimer.current) window.clearTimeout(exitTimer.current)
  }, [])

  const current = items[index]

  function commit(direction: Exclude<ExitDirection, null>) {
    if (!current || exit) return
    setExit(direction)
    if (direction === "right") onAccept(current)
    else onReject(current)
    exitTimer.current = window.setTimeout(() => {
      setIndex((value) => value + 1)
      setDragX(0)
      setExit(null)
    }, 210)
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return
    dragStart.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const start = dragStart.current
    if (!start || exit) return
    const x = event.clientX - start.x
    const y = event.clientY - start.y
    if (Math.abs(y) > Math.abs(x) * 1.4) return
    setDragX(Math.max(-180, Math.min(180, x)))
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    if (!dragStart.current) return
    dragStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (Math.abs(dragX) >= 74) commit(dragX > 0 ? "right" : "left")
    else setDragX(0)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") { event.preventDefault(); commit("left") }
    if (event.key === "ArrowRight") { event.preventDefault(); commit("right") }
    if (event.key === "Enter" && current) { event.preventDefault(); onInspect(current) }
  }

  if (!current) {
    return (
      <div className="swipe-stack-complete">
        {empty ?? <><img src="/logo.svg?v=mythic" alt="" /><h2>You reached the end of this draw.</h2><p>Shuffle the stack and take another look.</p></>}
        {items.length > 0 && <Button variant="secondary" onClick={() => setIndex(0)}><RotateCcw /> Shuffle again</Button>}
      </div>
    )
  }

  const visible = items.slice(index, index + 3)
  const style = { "--swipe-x": `${dragX}px`, "--swipe-turn": `${dragX / 18}deg` } as CSSProperties

  return (
    <section className="swipe-discovery" aria-label={ariaLabel}>
      <div className="swipe-stack-status" aria-live="polite"><span>{index + 1}</span><i />{items.length}</div>
      <div className="swipe-stack" tabIndex={0} onKeyDown={handleKeyDown}>
        {visible.slice().reverse().map((item, reverseIndex) => {
          const depth = visible.length - reverseIndex - 1
          const active = depth === 0
          return (
            <article
              key={getKey(item)}
              className="swipe-stack-item"
              data-depth={depth}
              data-exit={active && exit ? exit : undefined}
              style={active ? style : undefined}
              aria-hidden={!active}
              onPointerDown={active ? handlePointerDown : undefined}
              onPointerMove={active ? handlePointerMove : undefined}
              onPointerUp={active ? handlePointerUp : undefined}
              onPointerCancel={active ? () => { dragStart.current = null; setDragX(0) } : undefined}
            >
              {renderItem(item)}
              {active && <><span className="swipe-verdict swipe-verdict-pass" style={{ opacity: Math.max(0, -dragX / 95) }}>Pass</span><span className="swipe-verdict swipe-verdict-like" style={{ opacity: Math.max(0, dragX / 95) }}>Like</span></>}
            </article>
          )
        })}
      </div>
      <div className="swipe-stack-actions">
        <Button type="button" variant="secondary" size="icon-lg" className="swipe-action swipe-action-reject" aria-label={rejectLabel} onClick={() => commit("left")}><X /></Button>
        <Button type="button" variant="ghost" size="icon" className="swipe-action swipe-action-inspect" aria-label={inspectLabel} onClick={() => onInspect(current)}><Eye /></Button>
        <Button type="button" size="icon-lg" className="swipe-action swipe-action-accept" aria-label={acceptLabel} onClick={() => commit("right")}><Heart /></Button>
      </div>
      <p className="swipe-stack-hint"><span>Swipe left to pass</span><span>Tap the eye for details</span><span>Swipe right to like</span></p>
    </section>
  )
}
