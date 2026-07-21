import { useMemo, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Compass, Download, MoreHorizontal, Plus, Search, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api, cardImage, type Deck } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CardArtAtmosphere, CardArtFan } from "@/components/cards/CardArtShowcase"
import { useShowcaseCards } from "@/hooks/useShowcaseCards"
import { PageHeader } from "@/components/PageHeader"

function DeckCard({ deck, onDelete }: { deck: Deck; onDelete: (deck: Deck) => void }) {
  const art = cardImage(deck.commander_scryfall_id)
  return (
    <article className="group relative min-w-0 overflow-hidden rounded-xl border border-border bg-card/85 transition-colors hover:border-primary/45">
      <Link to={`/builder/${deck.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <div className="relative aspect-[16/10] overflow-hidden bg-muted">
          {art ? (
            <img src={art} alt="" loading="lazy" className="h-full w-full object-cover object-[center_18%] transition-transform duration-300 group-hover:scale-[1.025]" />
          ) : (
            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-primary/12 to-transparent"><img src="/logo.svg?v=mythic" alt="" className="size-16 opacity-55" /></div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-card to-transparent" />
          <div className="absolute bottom-2 left-3 right-3 flex items-end justify-between gap-2">
            <Badge variant="secondary" className="max-w-[70%] truncate bg-background/85 backdrop-blur-sm">{deck.commander_name || "Choose commander"}</Badge>
            {deck.is_public === 1 && <Badge className="bg-accent text-accent-foreground">Public</Badge>}
          </div>
        </div>
        <div className="px-4 py-3 pr-12">
          <h2 className="truncate text-base font-semibold">{deck.deck_name}</h2>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="uppercase">{deck.format || "Commander"}</span>
            {deck.total_wins != null && <><span>•</span><span>{deck.total_wins} wins</span></>}
          </p>
        </div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="absolute bottom-2 right-2" aria-label={`More actions for ${deck.deck_name}`}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild><Link to={`/builder/${deck.id}`}>Open deck</Link></DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(deck)}><Trash2 /> Delete deck</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  )
}

export function Decks() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [importOpen, setImportOpen] = useState(false)
  const [moxfieldUrl, setMoxfieldUrl] = useState("")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState("updated")
  const [deleteTarget, setDeleteTarget] = useState<Deck | null>(null)

  const decks = useQuery({ queryKey: ["my-decks"], queryFn: () => api.get<Deck[]>("/api/decks/my-decks") })
  const showcase = useShowcaseCards({
    preferred: (decks.data ?? []).map((deck) => ({ name: deck.commander_name || deck.deck_name, scryfallId: deck.commander_scryfall_id })),
    fallbackQuery: "is:commander game:paper usd<25",
    limit: 8,
  })
  const list = useMemo(() => {
    const filtered = (decks.data ?? []).filter((deck) => `${deck.deck_name} ${deck.commander_name ?? ""} ${deck.format ?? ""}`.toLowerCase().includes(query.toLowerCase()))
    return filtered.sort((a, b) => sort === "name" ? a.deck_name.localeCompare(b.deck_name) : sort === "wins" ? Number(b.total_wins ?? 0) - Number(a.total_wins ?? 0) : String(b.last_checked ?? "").localeCompare(String(a.last_checked ?? "")))
  }, [decks.data, query, sort])

  const importDeck = useMutation({
    mutationFn: () => api.post<{ deckId: string }>("/api/decks/register", { moxfieldUrl: moxfieldUrl.trim() }),
    onSuccess: (data) => { toast.success("Moxfield deck imported"); setImportOpen(false); setMoxfieldUrl(""); void qc.invalidateQueries({ queryKey: ["my-decks"] }); navigate(`/builder/${data.deckId}`) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not import deck"),
  })
  const deleteDeck = useMutation({
    mutationFn: (id: string) => api.delete(`/api/decks/${id}`),
    onSuccess: () => { toast.success("Deck deleted"); setDeleteTarget(null); void qc.invalidateQueries({ queryKey: ["my-decks"] }) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete deck"),
  })

  function submitImport(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (moxfieldUrl.trim()) importDeck.mutate() }
  const hasDecks = (decks.data?.length ?? 0) > 0

  return (
    <div className="page-wrap">
      <PageHeader
        title="My Decks"
        description="Build, tune, price, and bring your Commander collection to the table."
        actions={hasDecks ? <><Button variant="secondary" onClick={() => setImportOpen(true)}><Download /> Import</Button><Button onClick={() => navigate("/builder/new")}><Plus /> New deck</Button></> : undefined}
      />

      {decks.isPending ? (
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="aspect-[4/3] rounded-xl" />)}</div>
      ) : decks.isError ? (
        <section className="mt-8 rounded-xl border border-destructive/30 bg-destructive/8 p-6"><h2 className="font-semibold">Your decks could not be loaded</h2><p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p><Button variant="secondary" className="mt-4" onClick={() => void decks.refetch()}>Try again</Button></section>
      ) : hasDecks ? (
        <>
          <div className="ui-toolbar flex-col sm:flex-row">
            <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="Search decks or commanders" aria-label="Search your decks" /></div>
            <Select value={sort} onValueChange={setSort}><SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="updated">Recently updated</SelectItem><SelectItem value="name">Deck name</SelectItem><SelectItem value="wins">Most wins</SelectItem></SelectContent></Select>
          </div>
          {list.length ? <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{list.map((deck) => <DeckCard key={deck.id} deck={deck} onDelete={setDeleteTarget} />)}</div> : <p className="py-16 text-center text-muted-foreground">No decks match “{query}”.</p>}
        </>
      ) : (
        <section className="brew-stage">
          <CardArtAtmosphere cards={showcase.cards} />
          <div className="brew-stage-copy">
            <p className="brew-stage-kicker">Your table is open</p>
            <h2>Start with a legend.<br />Make it yours.</h2>
            <p>Choose a commander, start from a blank hundred, or bring over a public Moxfield list. The curve, legality, price, and every table-ready detail stay in one place.</p>
            <ul className="brew-stage-facts" aria-label="Deck builder features"><li>Commander-first</li><li>Live prices</li><li>Legality checks</li></ul>
            <div className="brew-stage-actions"><Button onClick={() => navigate("/builder/new")}><Plus /> Build a deck</Button><Button variant="secondary" onClick={() => setImportOpen(true)}><Download /> Import Moxfield</Button><Button variant="ghost" asChild><Link to="/discover"><Compass /> Browse decks <ArrowRight /></Link></Button></div>
          </div>
          <div className="brew-stage-art">
            <CardArtFan cards={showcase.cards} />
            <button type="button" className="brew-stage-art-link" onClick={() => showcase.cards[0] && navigate(`/search?q=${encodeURIComponent(showcase.cards[0].name)}&view=single`)} disabled={!showcase.cards[0]}><Sparkles /> Inspect this commander</button>
          </div>
        </section>
      )}

      <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>Import from Moxfield</DialogTitle><DialogDescription>Paste a public Moxfield deck URL. Grimore imports the commander, cards, prices, and settings.</DialogDescription></DialogHeader><form onSubmit={submitImport} className="space-y-4"><div className="space-y-1.5"><Label htmlFor="moxfield-url">Moxfield deck URL</Label><Input id="moxfield-url" type="url" value={moxfieldUrl} onChange={(event) => setMoxfieldUrl(event.target.value)} placeholder="https://www.moxfield.com/decks/…" required /></div><Button type="submit" className="w-full" disabled={!moxfieldUrl.trim() || importDeck.isPending}>{importDeck.isPending ? "Importing…" : "Import deck"}</Button></form></DialogContent></Dialog>
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}><DialogContent><DialogHeader><DialogTitle>Delete {deleteTarget?.deck_name}?</DialogTitle><DialogDescription>This permanently removes the deck and its saved card list.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={deleteDeck.isPending} onClick={() => deleteTarget && deleteDeck.mutate(deleteTarget.id)}>{deleteDeck.isPending ? "Deleting…" : "Delete deck"}</Button></div></DialogContent></Dialog>
    </div>
  )
}
