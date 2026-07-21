import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface SinglesCarouselProps<T> {
  items: T[]
  getKey: (item: T) => string
  ariaLabel: string
  children: (item: T, index: number) => ReactNode
}

export function SinglesCarousel<T>({ items, getKey, ariaLabel, children }: SinglesCarouselProps<T>) {
  const [index, setIndex] = useState(0)
  const gestureStart = useRef<{ x: number; y: number } | null>(null)
  const signature = useMemo(() => `${items.length}:${items[0] ? getKey(items[0]) : "empty"}`, [getKey, items])

  useEffect(() => {
    setIndex(0)
  }, [signature])

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, items.length - 1)))
  }, [items.length])

  const previous = () => setIndex((current) => Math.max(0, current - 1))
  const next = () => setIndex((current) => Math.min(items.length - 1, current + 1))

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    gestureStart.current = { x: event.clientX, y: event.clientY }
  }

  const handlePointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = gestureStart.current
    gestureStart.current = null
    if (!start) return
    const xDistance = event.clientX - start.x
    const yDistance = event.clientY - start.y
    if (Math.abs(xDistance) < 52 || Math.abs(xDistance) <= Math.abs(yDistance) * 1.15) return
    if (xDistance < 0) next()
    else previous()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      previous()
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      next()
    }
  }

  const item = items[index]
  if (!item) return null

  return (
    <section
      className="singles-carousel mx-auto mt-4 w-full max-w-5xl touch-pan-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      aria-label={ariaLabel}
      aria-roledescription="carousel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { gestureStart.current = null }}
    >
      <div className="singles-carousel-nav mb-3 flex items-center justify-center gap-3">
        <Button type="button" variant="secondary" size="icon" className="size-11" disabled={index === 0} onClick={previous} aria-label="Previous card"><ChevronLeft /></Button>
        <p className="min-w-24 text-center font-mono text-sm" aria-live="polite"><strong>{index + 1}</strong><span className="text-muted-foreground"> / {items.length}</span></p>
        <Button type="button" variant="secondary" size="icon" className="size-11" disabled={index === items.length - 1} onClick={next} aria-label="Next card"><ChevronRight /></Button>
      </div>
      <div className="singles-carousel-item" key={getKey(item)}>{children(item, index)}</div>
      <p className="singles-carousel-hint mt-3 text-center text-xs text-muted-foreground">Swipe the card or use ← → keys</p>
    </section>
  )
}
