import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router-dom"
import { Copy, Layers3, Search, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { api, cardImage } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SwipeStack } from "@/components/cards/SwipeStack"
import { useShowcaseCards, showcaseImage, type ShowcaseCard } from "@/hooks/useShowcaseCards"

interface DiscoverDeck {
  id: string
  deckName: string
  creatorName: string
  price?: number
  likes: number
  clones: number
  hasLiked: boolean
  commanderName: string
  commanderScryfallId: string | null
  tags: string[]
  customTags: string[]
}

type FeedMode = "cards" | "decks"

function artCrop(scryfallId?: string | null) {
  return cardImage(scryfallId).replace("/normal/", "/art_crop/")
}

export function Discover() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [mode, setMode] = useState<FeedMode>("cards")
  const [sort, setSort] = useState<"recent" | "trending">("trending")

  const decks = useQuery({ queryKey: ["discover", sort], queryFn: () => api.get<DiscoverDeck[]>(`/api/decks/discover?sort=${sort}`) })
  const followedArtists = useQuery({ queryKey: ["followed-artists"], queryFn: () => api.get<{ name: string }[]>("/api/artists/followed") })
  const followedArtist = followedArtists.data?.[0]?.name
  const showcase = useShowcaseCards({ fallbackQuery: followedArtist ? `artist:"${followedArtist.replaceAll('"', "")}" game:paper` : "is:commander game:paper", limit: 24 })

  const likeDeck = useMutation({
    mutationFn: (deckId: string) => api.post<{ liked: boolean }>(`/api/decks/${deckId}/like`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["discover"] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save this deck"),
  })
  const cloneDeck = useMutation({
    mutationFn: (deckId: string) => api.post<{ newDeckId: string }>(`/api/decks/${deckId}/clone`),
    onSuccess: (data) => { toast.success("Deck added to your collection"); void qc.invalidateQueries({ queryKey: ["my-decks"] }); navigate(`/builder/${data.newDeckId}`) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not copy this deck"),
  })
  const voteCard = useMutation({
    mutationFn: ({ card, vote }: { card: ShowcaseCard; vote: -1 | 1 }) => {
      if (!card.scryfallId) throw new Error("This printing cannot be rated yet")
      return api.post(`/api/cards/versions/${card.scryfallId}/vote`, { cardName: card.name, vote })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save this preference"),
  })

  const communityDecks = decks.data ?? []

  return (
    <div className="discovery-swipe-page">
      <header className="discovery-swipe-header">
        <div><h1>Discover</h1><p>Swipe into your next favorite card or Commander build.</p></div>
        <Button variant="ghost" size="icon" asChild aria-label="Search every card"><Link to="/search"><Search /></Link></Button>
      </header>

      <div className="discovery-feed-bar">
        <div className="discovery-mode-switch" role="tablist" aria-label="Discovery feed">
          <button type="button" role="tab" aria-selected={mode === "cards"} onClick={() => setMode("cards")}><Sparkles /> Cards</button>
          <button type="button" role="tab" aria-selected={mode === "decks"} onClick={() => setMode("decks")}><Layers3 /> Decks{communityDecks.length > 0 && <span>{communityDecks.length}</span>}</button>
        </div>
        <div className="discovery-feed-actions">
          <Button className="discovery-feed-search" variant="ghost" size="icon" asChild aria-label="Search every card"><Link to="/search"><Search /></Link></Button>
          {mode === "decks" && <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}><SelectTrigger size="sm" className="w-28" aria-label="Sort deck feed"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="trending">Trending</SelectItem><SelectItem value="recent">Recent</SelectItem></SelectContent></Select>}
        </div>
      </div>

      {mode === "cards" ? (
        showcase.isPending ? <div className="swipe-stack-loading"><img src="/logo.svg?v=mythic" alt="" /><p>Shuffling your card feed…</p></div> : (
          <SwipeStack
            items={showcase.cards}
            getKey={(card) => `${card.name}-${card.scryfallId}`}
            ariaLabel="Card discovery stack"
            onAccept={(card) => voteCard.mutate({ card, vote: 1 })}
            onReject={(card) => voteCard.mutate({ card, vote: -1 })}
            onInspect={(card) => navigate(`/search?q=${encodeURIComponent(card.name)}&view=single`)}
            acceptLabel="Like this card art"
            rejectLabel="Pass on this card art"
            inspectLabel="Inspect card details"
            renderItem={(card) => <div className="discovery-card-face"><img src={showcaseImage(card)} alt={card.name} draggable={false} /><div className="discovery-card-meta"><div><strong>{card.name}</strong><span>{card.artist ? `Art by ${card.artist}` : card.typeLine || "Magic card"}</span></div>{typeof card.price === "number" && <b>${card.price.toFixed(2)}</b>}</div></div>}
          />
        )
      ) : decks.isPending ? <div className="swipe-stack-loading"><img src="/logo.svg?v=mythic" alt="" /><p>Loading community decks…</p></div> : communityDecks.length > 0 ? (
        <SwipeStack
          items={communityDecks}
          getKey={(deck) => deck.id}
          ariaLabel="Community deck discovery stack"
          onAccept={(deck) => { if (!deck.hasLiked) likeDeck.mutate(deck.id) }}
          onReject={() => undefined}
          onInspect={(deck) => navigate(`/discover/${deck.id}`)}
          acceptLabel="Like this deck"
          rejectLabel="Pass on this deck"
          inspectLabel="Inspect deck details"
          renderItem={(deck) => <div className="discovery-deck-face">{deck.commanderScryfallId ? <img src={artCrop(deck.commanderScryfallId)} alt="" draggable={false} /> : <img src="/logo.svg?v=mythic" alt="" className="discovery-deck-placeholder" />}<div className="discovery-deck-shade" /><div className="discovery-deck-meta"><span>{deck.commanderName || "Commander deck"}</span><h2>{deck.deckName}</h2><p>by {deck.creatorName}</p><dl><div><dt>Likes</dt><dd>{deck.likes}</dd></div><div><dt>Copies</dt><dd>{deck.clones}</dd></div>{typeof deck.price === "number" && <div><dt>Value</dt><dd>${deck.price.toFixed(0)}</dd></div>}</dl><Button variant="secondary" onClick={(event) => { event.stopPropagation(); cloneDeck.mutate(deck.id) }} disabled={cloneDeck.isPending}><Copy /> Copy deck</Button></div></div>}
        />
      ) : (
        <div className="swipe-stack-complete discovery-decks-empty"><Layers3 /><h2>No community decks are in the stack yet.</h2><p>Publish the first list, then it becomes swipeable for everyone.</p><Button asChild><Link to="/builder/new">Build the first deck</Link></Button></div>
      )}
    </div>
  )
}
