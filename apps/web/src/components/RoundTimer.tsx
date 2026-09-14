import { useState, useEffect } from "react"
import { Clock, Play, Pause, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface RoundTimerProps {
  initialMinutes?: number
  onTimerEnd?: () => void
  isAdmin?: boolean
}

export function RoundTimer({ initialMinutes = 50, onTimerEnd, isAdmin = false }: RoundTimerProps) {
  const [timeLeft, setTimeLeft] = useState(initialMinutes * 60)
  const [isRunning, setIsRunning] = useState(false)

  useEffect(() => {
    let interval: any = null
    if (isRunning && timeLeft > 0) {
      interval = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            setIsRunning(false)
            if (onTimerEnd) onTimerEnd()
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [isRunning, timeLeft, onTimerEnd])

  const minutes = Math.floor(timeLeft / 60)
  const seconds = timeLeft % 60
  const formatTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`

  const isLow = timeLeft <= 5 * 60 && timeLeft > 0
  const isExpired = timeLeft === 0

  return (
    <div className="flex items-center gap-3 bg-surface-1 border border-violet-500/20 px-4 py-2 rounded-2xl shadow-md">
      <Clock className={`w-4 h-4 ${isExpired ? "text-rose-500 animate-pulse" : isLow ? "text-amber-400 animate-pulse" : "text-violet-400"}`} />
      <span className={`font-mono text-lg font-bold tracking-wider ${isExpired ? "text-rose-400" : isLow ? "text-amber-300" : "text-white"}`}>
        {formatTime}
      </span>

      {isAdmin && (
        <div className="flex items-center gap-1 ml-2 border-l border-white/10 pl-2">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-zinc-400 hover:text-white"
            onClick={() => setIsRunning(!isRunning)}
          >
            {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 text-emerald-400" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-zinc-400 hover:text-white"
            onClick={() => {
              setIsRunning(false)
              setTimeLeft(initialMinutes * 60)
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
