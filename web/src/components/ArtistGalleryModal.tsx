import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Palette, X, Heart } from "lucide-react"
import { toast } from "sonner"
import { api, cardImage, type CardResult } from "@/lib/api"
import { Button } from "@/components/ui/button"

interface ArtistGalleryModalProps {
  artistName: string
  isOpen: boolean
  onClose: () => void
}

export function ArtistGalleryModal({ artistName, isOpen, onClose }: ArtistGalleryModalProps) {
  const [following, setFollowing] = useState(false)

  const artistSearch = useQuery({
    queryKey: ["artist-gallery", artistName],
    queryFn: () =>
      api.get<{ cards: CardResult[] }>(
        `/api/cards/search?q=${encodeURIComponent(`artist:"${artistName}"`)}&page=1&limit=24`
      ),
    enabled: isOpen && !!artistName,
  })

  if (!isOpen || !artistName) return null

  const cards = artistSearch.data?.cards || []

  const toggleFollow = () => {
    setFollowing(!following)
    if (!following) {
      toast.success(`You are now following artist ${artistName}!`)
    } else {
      toast.info(`Unfollowed artist ${artistName}`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 overflow-y-auto">
      <div className="w-full max-w-4xl bg-[#0d0e17] border border-violet-500/20 rounded-2xl p-6 space-y-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-violet-500/20">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-violet-500/10 border border-violet-500/30 rounded-xl text-violet-300">
              <Palette className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white tracking-wide">{artistName}</h3>
              <p className="text-xs text-zinc-400">Featured MTG Artwork Gallery</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={toggleFollow}
              variant="outline"
              size="sm"
              className={`gap-1.5 text-xs ${
                following
                  ? "bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30"
                  : "bg-zinc-800/80 border-zinc-700 text-zinc-200 hover:bg-zinc-700"
              }`}
            >
              <Heart className={`w-3.5 h-3.5 ${following ? "fill-rose-400 text-rose-400" : ""}`} />
              {following ? "Following Artist" : "Follow Artist"}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="text-zinc-400 hover:text-white">
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Gallery Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-h-[60vh] overflow-y-auto pr-1 custom-scrollbar">
          {artistSearch.isLoading ? (
            <div className="col-span-full py-16 text-center text-zinc-500 text-sm">
              Loading artwork for {artistName}...
            </div>
          ) : cards.length === 0 ? (
            <div className="col-span-full py-16 text-center text-zinc-500 text-sm">
              No artwork found for {artistName}.
            </div>
          ) : (
            cards.map((card) => (
              <div
                key={card.scryfallId || card.name}
                className="group relative bg-[#141624] border border-white/5 rounded-xl overflow-hidden hover:border-violet-500/40 transition-all cursor-pointer shadow-md"
              >
                <img
                  src={cardImage(card.scryfallId, "normal")}
                  alt={card.name}
                  className="w-full aspect-[0.716] object-cover group-hover:scale-105 transition-transform duration-300"
                  loading="lazy"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2.5 text-xs">
                  <div className="font-semibold text-white truncate">{card.name}</div>
                  <div className="text-[10px] text-zinc-400 truncate mt-0.5">{card.type_line}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
