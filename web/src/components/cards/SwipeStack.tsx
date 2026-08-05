import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { Eye, Heart, RotateCcw, X } from "lucide-react"
import { Button } from "@/components/ui/button"

type SwipeDirection = "left" | "right"

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
  statusLabel?: string
  acceptStamp?: string
  rejectStamp?: string
  hasMore?: boolean
  isLoadingMore?: boolean
  onNearEnd?: () => void
  onUndo?: (item: T, direction: SwipeDirection) => void
  empty?: ReactNode
}

type ExitDirection = SwipeDirection | null

export function SwipeStack<T>({
  items,
  getKey,
  renderItem,
  ariaLabel,
  onAccept,
  onReject,
  onInspect,
  acceptLabel,
  rejectLabel,
  inspectLabel,
  statusLabel = "Discovery stack",
  acceptStamp = "Like",
  rejectStamp = "Pass",
  hasMore = false,
  isLoadingMore = false,
  onNearEnd,
  onUndo,
  empty,
}: SwipeStackProps<T>) {
  const [index, setIndex] = useState(0)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [exit, setExit] = useState<ExitDirection>(null)
  const [history, setHistory] = useState<Array<{ item: T; direction: SwipeDirection }>>([])
  const dragStart = useRef<{ x: number; y: number; at: number } | null>(null)
  const exitTimer = useRef<number | null>(null)
  const requestedMoreAtLength = useRef(0)
  const signature = useMemo(() => items[0] ? getKey(items[0]) : "empty", [getKey, items])

  useEffect(() => {
    setIndex(0)
    setDragX(0)
    setDragY(0)
    setDragging(false)
    setExit(null)
    setHistory([])
    requestedMoreAtLength.current = 0
  }, [signature])

  useEffect(() => () => {
    if (exitTimer.current) window.clearTimeout(exitTimer.current)
  }, [])

  const current = items[index]

  useEffect(() => {
    const remaining = items.length - index
    if (!current || !hasMore || isLoadingMore || !onNearEnd || remaining > 5) return
    if (requestedMoreAtLength.current === items.length) return
    requestedMoreAtLength.current = items.length
    onNearEnd()
  }, [current, hasMore, index, isLoadingMore, items.length, onNearEnd])

  function commit(direction: Exclude<ExitDirection, null>) {
    if (!current || exit) return
    if ("vibrate" in navigator) navigator.vibrate(10)
    setDragging(false)
    setExit(direction)
    setHistory((value) => [...value, { item: current, direction }])
    if (direction === "right") onAccept(current)
    else onReject(current)
    exitTimer.current = window.setTimeout(() => {
      setIndex((value) => value + 1)
      setDragX(0)
      setDragY(0)
      setExit(null)
    }, 210)
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return
    dragStart.current = { x: event.clientX, y: event.clientY, at: Date.now() }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const start = dragStart.current
    if (!start || exit) return
    const x = event.clientX - start.x
    const y = event.clientY - start.y
    if (Math.abs(y) > Math.abs(x) * 1.4) return
    setDragX(Math.max(-180, Math.min(180, x)))
    setDragY(Math.max(-38, Math.min(38, y * 0.28)))
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    const start = dragStart.current
    if (!start) return
    dragStart.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const velocity = Math.abs(event.clientX - start.x) / Math.max(1, Date.now() - start.at)
    if (Math.abs(dragX) >= 74 || (Math.abs(dragX) >= 28 && velocity >= 0.48)) {
      commit(dragX > 0 ? "right" : "left")
    } else {
      setDragX(0)
      setDragY(0)
    }
  }

  function undo() {
    if (exit || index === 0 || history.length === 0) return
    const lastDecision = history[history.length - 1]
    setIndex((value) => Math.max(0, value - 1))
    setHistory((value) => value.slice(0, -1))
    setDragX(0)
    setDragY(0)
    onUndo?.(lastDecision.item, lastDecision.direction)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") { event.preventDefault(); commit("left") }
    if (event.key === "ArrowRight") { event.preventDefault(); commit("right") }
    if (event.key === "Enter" && current) { event.preventDefault(); onInspect(current) }
  }

  if (!current) {
    if (hasMore || isLoadingMore) {
      return <div className="swipe-stack-loading"><img src="/logo.svg?v=mythic" alt="" /><p>{isLoadingMore ? "Dealing your next picks…" : "The next draw is ready to load."}</p>{!isLoadingMore && onNearEnd && <Button variant="secondary" onClick={onNearEnd}><RotateCcw /> Try the next draw</Button>}</div>
    }
    return (
      <div className="swipe-stack-complete">
        {empty ?? <><img src="/logo.svg?v=mythic" alt="" /><h2>You reached the end of this draw.</h2><p>Shuffle the stack and take another look.</p></>}
        {items.length > 0 && <Button variant="secondary" onClick={() => setIndex(0)}><RotateCcw /> Shuffle again</Button>}
      </div>
    )
  }

  const visible = items.slice(index, index + 3)
  const style = {
    "--swipe-x": `${dragX}px`,
    "--swipe-y": `${dragY}px`,
    "--swipe-turn": `${dragX / 18}deg`,
  } as CSSProperties

  return (
    <section className="swipe-discovery" aria-label={ariaLabel}>
      <div className="swipe-stack-status" aria-live="polite"><span>{statusLabel}</span><i />{items.length - index} ready{isLoadingMore ? " · dealing more" : ""}</div>
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
              data-dragging={active && dragging ? "true" : undefined}
              style={active ? style : undefined}
              aria-hidden={!active}
              onPointerDown={active ? handlePointerDown : undefined}
              onPointerMove={active ? handlePointerMove : undefined}
              onPointerUp={active ? handlePointerUp : undefined}
              onPointerCancel={active ? () => { dragStart.current = null; setDragging(false); setDragX(0); setDragY(0) } : undefined}
            >
              {renderItem(item)}
              {active && <><span className="swipe-verdict swipe-verdict-pass" style={{ opacity: Math.max(0, -dragX / 95) }}>{rejectStamp}</span><span className="swipe-verdict swipe-verdict-like" style={{ opacity: Math.max(0, dragX / 95) }}>{acceptStamp}</span></>}
            </article>
          )
        })}
      </div>
      <div className="swipe-stack-actions">
        {onUndo && <Button type="button" variant="ghost" size="icon" className="swipe-action swipe-action-undo" disabled={index === 0 || Boolean(exit)} aria-label="Undo last swipe" onClick={undo}><RotateCcw /></Button>}
        <Button type="button" variant="secondary" size="icon-lg" className="swipe-action swipe-action-reject" aria-label={rejectLabel} onClick={() => commit("left")}><X /></Button>
        <Button type="button" variant="ghost" size="icon" className="swipe-action swipe-action-inspect" aria-label={inspectLabel} onClick={() => onInspect(current)}><Eye /></Button>
        <Button type="button" size="icon-lg" className="swipe-action swipe-action-accept" aria-label={acceptLabel} onClick={() => commit("right")}><Heart /></Button>
      </div>
      <p className="swipe-stack-hint"><span>Swipe left to pass</span><span>Tap the eye for details</span><span>Swipe right to like</span></p>
    </section>
  )
}
