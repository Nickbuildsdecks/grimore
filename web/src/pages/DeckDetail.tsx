import { useMemo, useState, type FormEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Copy, Crown, Heart, MessageCircle, Pencil, Send } from "lucide-react"
import { toast } from "sonner"
import { api, cardImage, type DeckCard } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"

interface DeckMeta { id: string; deck_name: string; player_id: string; format?: string; cheapest_total_price?: number; is_legal?: number; legality_reason?: string; is_public?: number }
interface Social { likes: number; hasLiked: boolean; isOwner: boolean; customTags: string[]; comments: { id: string; store_nickname: string; avatar_url?: string; comment_text: string; created_at?: string }[] }
interface OwnerProfile { profile?: { store_nickname?: string; avatar_url?: string; profile_commander?: string } }

const ORDER = ["Creature", "Planeswalker", "Instant", "Sorcery", "Enchantment", "Artifact", "Land", "Other"]
function cardType(typeLine = "") { return ORDER.find((type) => typeLine.includes(type)) || "Other" }

export function DeckDetail() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [comment, setComment] = useState("")
  const meta = useQuery({ queryKey: ["deck-meta", deckId], queryFn: () => api.get<DeckMeta>(`/api/decks/${deckId}`), enabled: !!deckId })
  const cards = useQuery({ queryKey: ["deck-cards", deckId], queryFn: () => api.get<DeckCard[]>(`/api/decks/${deckId}/cards`), enabled: !!deckId })
  const social = useQuery({ queryKey: ["deck-social", deckId], queryFn: () => api.get<Social>(`/api/decks/${deckId}/social`), enabled: !!deckId })
  const owner = useQuery({ queryKey: ["profile", meta.data?.player_id], queryFn: () => api.get<OwnerProfile>(`/api/players/${meta.data!.player_id}/profile`), enabled: !!meta.data?.player_id })
  const like = useMutation({ mutationFn: () => api.post<{ liked: boolean }>(`/api/decks/${deckId}/like`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["deck-social", deckId] }), onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update favorite") })
  const clone = useMutation({ mutationFn: () => api.post<{ newDeckId: string }>(`/api/decks/${deckId}/clone`), onSuccess: (data) => { toast.success("Deck cloned to My Decks"); void qc.invalidateQueries({ queryKey: ["my-decks"] }); navigate(`/builder/${data.newDeckId}`) }, onError: (error) => toast.error(error instanceof Error ? error.message : "Could not clone deck") })
  const postComment = useMutation({ mutationFn: () => api.post(`/api/decks/${deckId}/comment`, { commentText: comment.trim() }), onSuccess: () => { setComment(""); toast.success("Comment posted"); void qc.invalidateQueries({ queryKey: ["deck-social", deckId] }) }, onError: (error) => toast.error(error instanceof Error ? error.message : "Could not post comment") })

  const commander = cards.data?.find((card) => card.is_commander === 1)
  const grouped = useMemo(() => ORDER.map((type) => ({ type, cards: (cards.data ?? []).filter((card) => card.is_commander !== 1 && cardType(card.type_line ?? "") === type) })).filter((group) => group.cards.length), [cards.data])
  const total = (cards.data ?? []).reduce((sum, card) => sum + card.quantity, 0)
  const ownerName = owner.data?.profile?.store_nickname || "Grimore player"

  if (meta.isPending || cards.isPending) return <div className="page-wrap"><Skeleton className="h-80 rounded-xl" /></div>
  if (meta.isError || cards.isError || !meta.data) return <div className="page-wrap"><section className="rounded-xl border border-destructive/30 bg-destructive/10 p-6"><h1 className="font-semibold">This deck could not be loaded</h1><Button variant="secondary" className="mt-4" asChild><Link to="/discover">Back to Discover</Link></Button></section></div>

  return (
    <div className="page-wrap">
      <Button variant="ghost" className="mb-4 px-2" onClick={() => navigate(-1)}><ArrowLeft /> Back</Button>
      <header className="grid gap-6 border-b border-border pb-6 md:grid-cols-[1fr_auto] md:items-end">
        <div><div className="flex flex-wrap gap-2">{meta.data.is_legal === 1 ? <Badge className="bg-emerald-500/15 text-emerald-300">Legal</Badge> : <Badge variant="destructive">Needs work</Badge>}<Badge variant="secondary" className="capitalize">{meta.data.format || "Commander"}</Badge>{social.data?.customTags?.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}</div><h1 className="mt-3 font-display text-4xl font-semibold md:text-5xl">{meta.data.deck_name}</h1><p className="mt-2 text-sm text-muted-foreground">by {ownerName} · {total} cards · ${Number(meta.data.cheapest_total_price ?? 0).toFixed(2)}</p>{meta.data.legality_reason && <p className="mt-2 max-w-2xl text-sm text-destructive">{meta.data.legality_reason}</p>}</div>
        <div className="flex flex-wrap gap-2">{social.data?.isOwner ? <Button asChild><Link to={`/builder/${deckId}`}><Pencil /> Edit deck</Link></Button> : <Button onClick={() => clone.mutate()} disabled={clone.isPending}><Copy /> {clone.isPending ? "Cloning…" : "Clone deck"}</Button>}<Button variant="secondary" aria-pressed={social.data?.hasLiked} onClick={() => like.mutate()}><Heart className={social.data?.hasLiked ? "fill-current text-primary" : ""} /> {social.data?.likes ?? 0}</Button></div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr]">
        <aside>{commander ? <figure className="sticky top-4"><img src={cardImage(commander.scryfall_id)} alt={commander.card_name} className="w-full rounded-xl" /><figcaption className="mt-2 flex items-center gap-2 text-sm font-semibold"><Crown className="size-4 text-primary" /> {commander.card_name}</figcaption></figure> : <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">No commander selected.</div>}</aside>
        <div className="min-w-0 space-y-7">{grouped.map((group) => <section key={group.type}><h2 className="mb-2 flex items-center justify-between border-b border-border pb-2 text-sm font-semibold"><span>{group.type}</span><span className="font-mono text-muted-foreground">{group.cards.reduce((sum, card) => sum + card.quantity, 0)}</span></h2><div className="grid grid-cols-1 gap-x-5 md:grid-cols-2 xl:grid-cols-3">{group.cards.map((card) => <div key={card.card_name} className="flex min-h-10 items-center gap-2 border-b border-border/60 text-sm"><span className="w-7 font-mono text-xs text-primary">{card.quantity}×</span><span className="min-w-0 flex-1 truncate">{card.card_name}</span><span className="font-mono text-xs text-muted-foreground">${Number(card.cheapest_card_price ?? 0).toFixed(2)}</span></div>)}</div></section>)}</div>
      </div>

      <section className="mt-10 max-w-3xl border-t border-border pt-6"><h2 className="flex items-center gap-2 text-lg font-semibold"><MessageCircle className="size-5" /> Discussion</h2><form className="mt-4 flex flex-col gap-2" onSubmit={(event: FormEvent) => { event.preventDefault(); if (comment.trim()) postComment.mutate() }}><Textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} placeholder="Ask about a card choice or share an idea…" aria-label="Comment" /><Button className="self-end" type="submit" disabled={!comment.trim() || postComment.isPending}><Send /> Post comment</Button></form><div className="mt-5 space-y-3">{(social.data?.comments ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No comments yet.</p> : social.data?.comments.map((item) => <article key={item.id} className="rounded-xl bg-card/70 p-4"><div className="flex items-center gap-2"><strong className="text-sm">{item.store_nickname}</strong>{item.created_at && <span className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleDateString()}</span>}</div><p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{item.comment_text}</p></article>)}</div></section>
    </div>
  )
}
