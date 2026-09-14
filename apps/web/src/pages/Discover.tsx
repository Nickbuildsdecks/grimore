import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router-dom"
import { Copy, Search } from "lucide-react"
import {
  ManaSpark,
  Spellbook,
} from "@/icons"
import { toast } from "sonner"
import { apiClient } from "@/lib/apiClient"
import { queryKeys } from "@/lib/queries"
import { api, cardImage } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SwipeStack } from "@/components/cards/SwipeStack"
import { useShowcaseCards, showcaseImage, type ShowcaseCard } from "@/hooks/useShowcaseCards"

type FeedMode = "cards" | "decks"

function artCrop(scryfallId?: string | null) {
  return cardImage(scryfallId).replace("/normal/", "/art_crop/")
}

export function Discover() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [mode, setMode] = useState<FeedMode>("cards")
  const [sort, setSort] = useState<"recent" | "trending">("trending")

  // v2 serves the discover feed from GET /api/decks with real pagination; legacy had a separate
  // /api/decks/discover that returned a bare array.
  const decks = useQuery({
    queryKey: queryKeys.decks.discover({ sort: sort as "newest" | "popular" | "likes" }),
    queryFn: () => apiClient.decks.discover({ sort: sort as "newest" | "popular" | "likes", limit: 60 }),
    select: (page) => page.items,
  })
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
  /* Gameplay taste. These cards differ from one another, so a swipe here says
     nothing about artwork and must not touch the printing's art votes. */
  const voteCard = useMutation({
    mutationFn: ({ card, vote }: { card: ShowcaseCard; vote: -1 | 1 }) =>
      api.post("/api/cards/swipes", {
        cardName: card.name,
        scryfallId: card.scryfallId,
        vote,
        source: "discover_swipe",
        typeLine: card.typeLine,
        cmc: card.cmc,
        price: card.price,
      }),
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
          <button type="button" role="tab" aria-selected={mode === "cards"} onClick={() => setMode("cards")}><ManaSpark /> Cards</button>
          <button type="button" role="tab" aria-selected={mode === "decks"} onClick={() => setMode("decks")}><Spellbook /> Decks{communityDecks.length > 0 && <span>{communityDecks.length}</span>}</button>
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
          onAccept={(deck) => { if (!deck.has_liked) likeDeck.mutate(deck.id) }}
          onReject={() => undefined}
          onInspect={(deck) => navigate(`/discover/${deck.id}`)}
          acceptLabel="Like this deck"
          rejectLabel="Pass on this deck"
          inspectLabel="Inspect deck details"
          renderItem={(deck) => <div className="discovery-deck-face">{deck.commander_scryfall_id ? <img src={artCrop(deck.commander_scryfall_id)} alt="" draggable={false} /> : <img src="/logo.svg?v=mythic" alt="" className="discovery-deck-placeholder" />}<div className="discovery-deck-shade" /><div className="discovery-deck-meta"><span>{deck.commander_name || "Commander deck"}</span><h2>{deck.deck_name}</h2><p>by {deck.creator_name}</p><dl><div><dt>Likes</dt><dd>{deck.likes_count}</dd></div><div><dt>Copies</dt><dd>{deck.clones_count}</dd></div>{typeof deck.cheapest_total_price === "number" && <div><dt>Value</dt><dd>${deck.cheapest_total_price.toFixed(0)}</dd></div>}</dl><Button variant="secondary" onClick={(event) => { event.stopPropagation(); cloneDeck.mutate(deck.id) }} disabled={cloneDeck.isPending}><Copy /> Copy deck</Button></div></div>}
        />
      ) : (
        <div className="swipe-stack-complete discovery-decks-empty"><Spellbook /><h2>No community decks are in the stack yet.</h2><p>Publish the first list, then it becomes swipeable for everyone.</p><Button asChild><Link to="/builder/new">Build the first deck</Link></Button></div>
      )}
    </div>
  )
}
