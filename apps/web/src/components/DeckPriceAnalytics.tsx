import { useState } from "react"
import { DollarSign, ShoppingCart, Copy, Check, TrendingDown } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"

interface CardPriceItem {
  name: string
  qty: number
  price: number
  scryfallId?: string | null
}

interface DeckPriceAnalyticsProps {
  cards: CardPriceItem[]
  onOptimizePrices?: () => void
}

export function DeckPriceAnalytics({ cards, onOptimizePrices }: DeckPriceAnalyticsProps) {
  const [copiedTCG, setCopiedTCG] = useState(false)

  const totalPrice = cards.reduce((sum, c) => sum + c.price * c.qty, 0)
  const totalCards = cards.reduce((sum, c) => sum + c.qty, 0)

  // Sort top 5 most expensive cards
  const topExpensive = [...cards]
    .sort((a, b) => b.price - a.price)
    .slice(0, 5)

  // Generate TCGplayer buy list text format (e.g. "1 Sol Ring\n1 Rhystic Study")
  const generateBuyListText = () => {
    return cards.map((c) => `${c.qty} ${c.name}`).join("\n")
  }

  const copyTCGList = () => {
    navigator.clipboard.writeText(generateBuyListText())
    setCopiedTCG(true)
    toast.success("Deck buy list copied to clipboard!")
    setTimeout(() => setCopiedTCG(false), 2500)
  }

  const openTCGDirect = () => {
    const queryStr = cards.map((c) => `${c.qty} ${c.name}`).join("||")
    const tcgMassEntryUrl = `https://store.tcgplayer.com/massentry?c=${encodeURIComponent(queryStr)}`
    const affiliateUrl = `https://partner.tcgplayer.com/xJoE0d?u=${encodeURIComponent(tcgMassEntryUrl)}`
    window.open(affiliateUrl, "_blank")
  }

  const openCardKingdomDirect = () => {
    const queryStr = cards.map((c) => `${c.qty} ${c.name}`).join("\n")
    const ckUrl = `https://www.cardkingdom.com/builder?partner=grimore&main=${encodeURIComponent(queryStr)}`
    window.open(ckUrl, "_blank")
  }

  return (
    <div className="bg-surface-1 border border-violet-500/20 rounded-2xl p-5 space-y-5 shadow-xl">
      {/* Total & Summary Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-violet-500/15">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-violet-400 uppercase tracking-wider">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            Deck Price Analytics
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-white">${totalPrice.toFixed(2)}</span>
            <span className="text-xs text-zinc-400">({totalCards} total cards)</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {onOptimizePrices && (
            <Button
              onClick={onOptimizePrices}
              variant="outline"
              size="sm"
              className="bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 text-xs gap-1.5"
            >
              <TrendingDown className="w-3.5 h-3.5" />
              Swap Lowest Printings
            </Button>
          )}
          <Button
            onClick={copyTCGList}
            variant="outline"
            size="sm"
            className="bg-zinc-800/80 border-zinc-700 text-zinc-200 hover:bg-zinc-700 text-xs gap-1.5"
          >
            {copiedTCG ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            Copy Buy List
          </Button>
          <Button
            onClick={openTCGDirect}
            size="sm"
            className="bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold gap-1.5"
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            TCGplayer Checkout
          </Button>
          <Button
            onClick={openCardKingdomDirect}
            size="sm"
            className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold gap-1.5"
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            Card Kingdom Checkout
          </Button>
        </div>
      </div>

      {/* Top 5 Most Expensive Cards List */}
      <div>
        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2.5">
          Top Value Cards
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
          {topExpensive.map((card) => (
            <div
              key={card.name}
              className="bg-surface-2 border border-white/5 rounded-xl p-2.5 flex flex-col justify-between hover:border-violet-500/30 transition-all"
            >
              <div className="text-xs font-medium text-white truncate" title={card.name}>
                {card.name}
              </div>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-zinc-500">x{card.qty}</span>
                <span className="text-emerald-400 font-semibold">${(card.price * card.qty).toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
