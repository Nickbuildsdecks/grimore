import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, X, Check } from "lucide-react"
import { CommanderCrown } from "@/icons"
import { api, cardImage, type CardResult } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface CommanderDrawerProps {
  isOpen: boolean
  onClose: () => void
  onSelectCommander: (card: CardResult) => void
  currentCommanderName?: string
}

export function CommanderDrawer({ isOpen, onClose, onSelectCommander, currentCommanderName }: CommanderDrawerProps) {
  const [query, setQuery] = useState("")

  const commanderSearch = useQuery({
    queryKey: ["commander-drawer-search", query],
    queryFn: () =>
      api.get<{ cards: CardResult[] }>(
        `/api/cards/search?q=${encodeURIComponent(query ? `${query} is:commander` : "is:commander order:edhrec")}&page=1&limit=20`
      ),
    enabled: isOpen,
    placeholderData: (prev) => prev,
  })

  if (!isOpen) return null

  const cardList = commanderSearch.data?.cards || []

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-[#0c0d14] border-l border-violet-500/20 p-6 flex flex-col h-full shadow-2xl overflow-hidden">
        {/* Drawer Header */}
        <div className="flex items-center justify-between pb-4 border-b border-violet-500/20">
          <div className="flex items-center gap-2">
            <CommanderCrown className="w-5 h-5 text-amber-400" />
            <h2 className="text-lg font-bold text-white tracking-wide">Select Commander</h2>
          </div>
          <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-white" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Search Input */}
        <div className="relative my-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search legendary creatures & planeswalkers..."
            className="pl-9 bg-[#141622] border-zinc-800 focus:border-violet-500 text-white placeholder:text-zinc-500"
            autoFocus
          />
        </div>

        {/* Commander Cards Grid */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-3 custom-scrollbar">
          {commanderSearch.isLoading ? (
            <div className="text-center py-12 text-zinc-500 text-sm">Searching commanders...</div>
          ) : cardList.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 text-sm">No commanders found for "{query}".</div>
          ) : (
            cardList.map((card) => {
              const isCurrent = currentCommanderName === card.name
              const imgUrl = cardImage(card.scryfallId, "normal")
              return (
                <div
                  key={card.scryfallId || card.name}
                  onClick={() => {
                    onSelectCommander(card)
                    onClose()
                  }}
                  className={`group relative flex items-center gap-3 p-2.5 rounded-xl border transition-all cursor-pointer ${
                    isCurrent
                      ? "bg-amber-500/10 border-amber-500/40"
                      : "bg-[#141622]/80 border-zinc-800/80 hover:border-violet-500/50 hover:bg-[#1a1c2d]"
                  }`}
                >
                  <img
                    src={imgUrl}
                    alt={card.name}
                    className="w-12 h-16 object-cover rounded-md shadow-md border border-white/10 group-hover:scale-105 transition-transform"
                    loading="lazy"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-white truncate group-hover:text-violet-300">
                        {card.name}
                      </h4>
                      {isCurrent && <Check className="w-4 h-4 text-amber-400 shrink-0" />}
                    </div>
                    <p className="text-xs text-zinc-400 truncate mt-0.5">{card.type_line}</p>
                    <div className="flex items-center justify-between mt-1 text-xs text-zinc-500">
                      <span>CMC {card.cmc}</span>
                      <span className="text-emerald-400 font-medium">${(card.price || 0.15).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
