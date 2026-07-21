import { useQuery } from "@tanstack/react-query"
import { api, cardImage, type CardResult } from "@/lib/api"

export interface ShowcaseCard {
  name: string
  scryfallId?: string | null
  imageUri?: string | null
  artist?: string
  price?: number
  typeLine?: string
  cmc?: number
}

interface UseShowcaseCardsOptions {
  preferred?: ShowcaseCard[]
  fallbackQuery?: string
  limit?: number
  enabled?: boolean
}

const DEFAULT_QUERY = "is:commander game:paper usd<25"

export function useShowcaseCards({ preferred = [], fallbackQuery = DEFAULT_QUERY, limit = 8, enabled = true }: UseShowcaseCardsOptions = {}) {
  const usablePreferred = preferred.filter((card) => card.imageUri || card.scryfallId).slice(0, limit)
  const fallback = useQuery({
    queryKey: ["showcase-art", fallbackQuery, limit],
    queryFn: () => api.get<{ cards: CardResult[] }>(`/api/cards/search?q=${encodeURIComponent(fallbackQuery)}&page=1&limit=${limit}`),
    enabled: enabled && usablePreferred.length === 0,
    staleTime: 30 * 60 * 1000,
  })

  const fallbackCards = (fallback.data?.cards ?? []).map((card) => ({
    name: card.name,
    scryfallId: card.scryfallId,
    imageUri: card.image_uri,
    artist: card.artist,
    price: card.price,
    typeLine: card.type_line,
    cmc: card.cmc,
  }))

  return {
    cards: usablePreferred.length > 0 ? usablePreferred : fallbackCards,
    isFallback: usablePreferred.length === 0,
    isPending: enabled && usablePreferred.length === 0 && fallback.isPending,
  }
}

export function showcaseImage(card?: ShowcaseCard) {
  return card?.imageUri || cardImage(card?.scryfallId) || ""
}
