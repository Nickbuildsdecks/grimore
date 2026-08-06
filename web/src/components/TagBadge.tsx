import { cn } from "@/lib/utils"

interface TagBadgeProps {
  tag: string
  count?: number
  onClick?: () => void
  active?: boolean
  className?: string
}

export function getTagColorClass(tag: string): string {
  const t = tag.toLowerCase()
  if (t.includes("ramp")) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25"
  if (t.includes("advantage") || t.includes("draw")) return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25"
  if (t.includes("removal") || t.includes("wipe")) return "bg-rose-500/15 text-rose-300 border-rose-500/30 hover:bg-rose-500/25"
  if (t.includes("protection")) return "bg-teal-500/15 text-teal-300 border-teal-500/30 hover:bg-teal-500/25"
  if (t.includes("tutor")) return "bg-purple-500/15 text-purple-300 border-purple-500/30 hover:bg-purple-500/25"
  if (t.includes("wincon") || t.includes("combo")) return "bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25"
  if (t.includes("recursion") || t.includes("reanimation")) return "bg-indigo-500/15 text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/25"
  if (t.includes("stax")) return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30 hover:bg-zinc-500/25"
  if (t.includes("land")) return "bg-amber-700/15 text-amber-200 border-amber-600/30 hover:bg-amber-700/25"
  return "bg-violet-500/15 text-violet-300 border-violet-500/30 hover:bg-violet-500/25"
}

export function TagBadge({ tag, count, onClick, active, className }: TagBadgeProps) {
  const colorClass = getTagColorClass(tag)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all cursor-pointer select-none",
        colorClass,
        active && "ring-2 ring-violet-400 ring-offset-1 ring-offset-black",
        className
      )}
    >
      <span>{tag}</span>
      {count !== undefined && (
        <span className="ml-0.5 px-1.5 py-0.2 rounded-full bg-black/40 text-[10px] opacity-80 font-mono">
          {count}
        </span>
      )}
    </button>
  )
}
