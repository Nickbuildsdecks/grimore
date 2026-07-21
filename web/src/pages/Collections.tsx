import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, LayoutGrid, Minus, PackageOpen, Plus, Recycle, Search, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api, cardImage, type CardResult, type Collection } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BinderPreview } from "@/components/cards/CardArtShowcase"
import { useShowcaseCards } from "@/hooks/useShowcaseCards"
import { PageHeader } from "@/components/PageHeader"

interface CollectionCard {
  card_name: string
  quantity: number
  scryfall_id?: string | null
  price?: number | null
  is_foil?: number
  is_for_trade?: number
  condition?: string
  language?: string
  purchase_price?: number | null
}

export function Collections() {
  const qc = useQueryClient()
  const initializedCollection = useRef(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [cardName, setCardName] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null)
  const [recycleOpen, setRecycleOpen] = useState(false)

  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<{ success: boolean; collections: Collection[] }>("/api/collections"),
  })

  const cards = useQuery({
    queryKey: ["collection-cards", activeId],
    queryFn: () => api.get<{ success: boolean; cards: CollectionCard[] }>(`/api/collections/${activeId}/cards`),
    enabled: !!activeId,
  })
  const cardSearch = useQuery({
    queryKey: ["collection-card-search", cardName],
    queryFn: () => api.get<{ cards: CardResult[] }>(`/api/cards/search?q=${encodeURIComponent(cardName)}&page=1&limit=8`),
    enabled: !!activeId && cardName.trim().length >= 2,
  })
  const deletedItems = useQuery({
    queryKey: ["deleted-items"],
    queryFn: () => api.get<{ success: boolean; items: { id: string; item_type: string; name: string; deleted_at: string }[] }>("/api/recovery/deleted-items"),
    enabled: recycleOpen,
  })

  const list = collections.data?.collections ?? []
  const firstCollectionId = list[0]?.id
  const cardList = cards.data?.cards ?? []
  const totalValue = list.reduce((a, c) => a + Number(c.total_value ?? 0), 0)
  const active = list.find((c) => c.id === activeId)
  const showcase = useShowcaseCards({
    preferred: cardList.map((card) => ({ name: card.card_name, scryfallId: card.scryfall_id })),
    fallbackQuery: "game:paper unique:art rarity:r",
    limit: 8,
  })

  useEffect(() => {
    if (!collections.isSuccess || initializedCollection.current) return
    initializedCollection.current = true
    if (firstCollectionId) setActiveId(firstCollectionId)
  }, [collections.isSuccess, firstCollectionId])

  const createCollection = useMutation({
    mutationFn: (name: string) => api.post<{ collectionId: string }>("/api/collections", { name }),
    onSuccess: (data) => {
      setNewName("")
      setCreateOpen(false)
      setActiveId(data.collectionId)
      toast.success("Collection created")
      void qc.invalidateQueries({ queryKey: ["collections"] })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create collection"),
  })

  const deleteCollection = useMutation({
    mutationFn: (id: string) => api.delete(`/api/collections/${id}`),
    onSuccess: () => {
      setActiveId(null)
      setDeleteTarget(null)
      toast.success("Collection moved to the recycle bin")
      void qc.invalidateQueries({ queryKey: ["collections"] })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete collection"),
  })

  const addCard = useMutation({
    mutationFn: (card?: CardResult) => api.post(`/api/collections/${activeId}/cards`, { cardName: card?.name ?? cardName.trim(), scryfallId: card?.scryfallId, quantity: 1 }),
    onSuccess: (_data, card) => {
      toast.success(`Added ${card?.name ?? cardName.trim()}`)
      setCardName("")
      void qc.invalidateQueries({ queryKey: ["collection-cards", activeId] })
      void qc.invalidateQueries({ queryKey: ["collections"] })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add card"),
  })

  const updateQuantity = useMutation({
    mutationFn: ({ card, quantity }: { card: CollectionCard; quantity: number }) => quantity <= 0
      ? api.delete(`/api/collections/${activeId}/cards`, { cardName: card.card_name, scryfallId: card.scryfall_id, isFoil: card.is_foil === 1, condition: card.condition || "NM", language: card.language || "EN" })
      : api.put(`/api/collections/${activeId}/cards`, { cardName: card.card_name, scryfallId: card.scryfall_id, isFoil: card.is_foil === 1, condition: card.condition || "NM", language: card.language || "EN", newQuantity: quantity, newIsFoil: card.is_foil === 1, newIsForTrade: card.is_for_trade === 1, newCondition: card.condition || "NM", newLanguage: card.language || "EN", newPurchasePrice: card.purchase_price ?? null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["collection-cards", activeId] }); void qc.invalidateQueries({ queryKey: ["collections"] }) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update quantity"),
  })
  const restoreItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/recovery/restore/${id}`),
    onSuccess: () => { toast.success("Item restored"); void qc.invalidateQueries({ queryKey: ["deleted-items"] }); void qc.invalidateQueries({ queryKey: ["collections"] }); void qc.invalidateQueries({ queryKey: ["my-decks"] }) },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not restore item"),
  })

  return (
    <div className="page-wrap">
      <PageHeader
        title="My Collections"
        description="Track printings, condition, trade inventory, and the value of every binder."
        actions={<><span className="flex min-h-11 items-center rounded-lg border border-brass/25 bg-brass/5 px-3 text-sm"><span className="mr-2 text-muted-foreground">Value</span><strong className="font-mono text-brass-bright">${totalValue.toFixed(2)}</strong></span><Button variant="secondary" onClick={() => setRecycleOpen(true)}><Recycle /> Recycle bin</Button>{list.length > 0 && <Button onClick={() => setCreateOpen(true)}><Plus /> New collection</Button>}</>}
      />
      <div className={cn("flex flex-col gap-6", list.length > 0 && "md:flex-row")}>
      {/* Binder list */}
      {list.length > 0 && <aside className={cn("md:w-72 md:shrink-0", activeId && "hidden md:block")}>

        {collections.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map((c) => (
              <li key={c.id} className="flex items-stretch gap-1">
                <button
                  onClick={() => setActiveId(c.id)}
                  className={cn(
                    "min-w-0 flex-1 rounded-xl border border-border bg-card/60 p-3 text-left transition-colors hover:border-brass/30",
                    activeId === c.id && "border-brass/50 bg-card"
                  )}
                >
                  <span className="flex items-center gap-2 font-semibold">
                    {c.is_wishlist ? (
                      <Sparkles className="h-4 w-4 text-arcane-bright" />
                    ) : (
                      <LayoutGrid className="h-4 w-4 text-brass" />
                    )}
                    {c.name}
                  </span>
                  <span className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{c.total_cards} cards</span>
                    <span className="font-mono text-brass-bright">
                      ${Number(c.total_value ?? 0).toFixed(2)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="w-11 shrink-0 rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => {
                    setDeleteTarget(c)
                  }}
                >
                  <Trash2 className="mx-auto h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>}

      {/* Content */}
      <section className="min-w-0 flex-1">
        {collections.isPending ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="aspect-[0.716] rounded-xl" />)}</div>
        ) : !activeId ? (
          <div className="binder-stage">
            <div className="binder-stage-copy">
              <p className="binder-stage-index">Binder 001</p>
              <h2>Build a collection<br />you can actually use.</h2>
              <p>Keep the exact printing, condition, language, foil status, trade availability, and price attached to every card—not buried in a spreadsheet.</p>
              <div className="binder-stage-ledger"><span><strong>Exact</strong> printings</span><span><strong>Live</strong> valuation</span><span><strong>Trade</strong> inventory</span></div>
              <Button onClick={() => setCreateOpen(true)}><Plus /> Open your first binder</Button>
            </div>
            <BinderPreview cards={showcase.cards} isPending={showcase.isPending} />
          </div>
        ) : (
          <>
            <header className="mb-4 flex flex-wrap items-center gap-3">
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Back to collections" onClick={() => setActiveId(null)}><ArrowLeft /></Button>
              <div className="min-w-0 flex-1"><h2 className="truncate text-xl font-semibold">{active?.name}</h2><p className="text-sm text-muted-foreground">{cardList.reduce((total, card) => total + card.quantity, 0)} cards · ${Number(active?.total_value ?? 0).toFixed(2)}</p></div>
              {active?.is_public === 1 && (
                <Badge className="bg-arcane/20 text-arcane-bright">Public</Badge>
              )}
            </header>
            <form
              className="relative mb-5 flex max-w-2xl gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (cardName.trim()) addCard.mutate(undefined)
              }}
            >
              <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={cardName} onChange={(e) => setCardName(e.target.value)} className="pl-9" placeholder="Search cards to add" aria-label="Card name" />{cardName.trim().length >= 2 && <div className="absolute inset-x-0 top-12 z-20 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg">{cardSearch.isPending ? <p className="p-4 text-sm text-muted-foreground">Searching…</p> : (cardSearch.data?.cards ?? []).map((card) => <button key={`${card.name}-${card.scryfallId}`} type="button" className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary" onClick={() => addCard.mutate(card)}>{card.image_uri && <img src={card.image_uri} alt="" className="h-12 w-9 rounded object-cover" />}<span className="min-w-0 flex-1"><strong className="block truncate text-sm">{card.name}</strong><span className="block truncate text-xs text-muted-foreground">{card.type_line}</span></span><Plus className="size-4" /></button>)}</div>}</div>
              <Button type="submit" disabled={!cardName.trim() || addCard.isPending}><Plus /> Add card</Button>
            </form>
            {cards.isPending ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 10 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[0.716] rounded-xl" />
                ))}
              </div>
            ) : cardList.length === 0 ? (
              <div className="py-16 text-center"><PackageOpen className="mx-auto size-9 text-muted-foreground" /><h2 className="mt-3 font-semibold">This binder is ready</h2><p className="mt-1 text-sm text-muted-foreground">Search above to add its first card.</p></div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {cardList.map((c) => {
                  const img = cardImage(c.scryfall_id ?? undefined)
                  return (
                    <article
                      key={`${c.card_name}-${c.is_foil}`}
                      className="overflow-hidden rounded-xl border border-border bg-card/90"
                    >
                      {img ? (
                        <img src={img} alt={c.card_name} loading="lazy" className="aspect-[0.716] w-full object-cover" />
                      ) : (
                        <div className="flex aspect-[0.716] items-center justify-center p-3 text-center text-xs text-muted-foreground">
                          {c.card_name}
                        </div>
                      )}
                      <div className="p-2 text-xs"><div className="flex items-center justify-between gap-1"><span className="min-w-0 truncate font-medium">
                          {c.quantity > 1 && <span className="mr-1 font-mono text-brass-bright">{c.quantity}×</span>}
                          {c.card_name}
                        </span>
                        {c.is_foil === 1 && <Badge className="ml-1 shrink-0 bg-brass/20 text-brass-bright text-[0.6rem]">FOIL</Badge>}
                        </div><div className="mt-1 flex items-center justify-end"><Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label={`Remove one ${c.card_name}`} onClick={() => updateQuantity.mutate({ card: c, quantity: c.quantity - 1 })}><Minus /></Button><span className="min-w-8 text-center font-mono">{c.quantity}</span><Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label={`Add one ${c.card_name}`} onClick={() => addCard.mutate({ name: c.card_name, scryfallId: c.scryfall_id ?? undefined, type_line: "", oracle_text: "", mana_cost: "", cmc: 0, colors: [], rarity: "", image_uri: img, price: c.price ?? undefined })}><Plus /></Button><Button variant="ghost" size="icon" className="size-11 text-destructive sm:size-9" aria-label={`Remove ${c.card_name}`} onClick={() => updateQuantity.mutate({ card: c, quantity: 0 })}><Trash2 /></Button></div></div>
                    </article>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>Create a collection</DialogTitle><DialogDescription>Use separate binders for your collection, trade stock, cubes, or a set project.</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); if (newName.trim()) createCollection.mutate(newName.trim()) }} className="space-y-4"><Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Commander staples" aria-label="Collection name" autoFocus /><Button type="submit" className="w-full" disabled={!newName.trim() || createCollection.isPending}>{createCollection.isPending ? "Creating…" : "Create collection"}</Button></form></DialogContent></Dialog>
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}><DialogContent><DialogHeader><DialogTitle>Move {deleteTarget?.name} to the recycle bin?</DialogTitle><DialogDescription>The collection will leave this binder immediately and can be restored later from the recycle bin.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={deleteCollection.isPending} onClick={() => deleteTarget && deleteCollection.mutate(deleteTarget.id)}>{deleteCollection.isPending ? "Moving…" : "Move to recycle bin"}</Button></div></DialogContent></Dialog>
      <Dialog open={recycleOpen} onOpenChange={setRecycleOpen}><DialogContent><DialogHeader><DialogTitle>Recycle bin</DialogTitle><DialogDescription>Restore recently deleted decks and collections.</DialogDescription></DialogHeader>{deletedItems.isPending ? <div className="space-y-2">{Array.from({length:3}).map((_, index) => <Skeleton key={index} className="h-14" />)}</div> : (deletedItems.data?.items ?? []).length === 0 ? <div className="py-10 text-center"><Recycle className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">The recycle bin is empty.</p></div> : <ul className="space-y-2">{deletedItems.data?.items.map((item) => <li key={item.id} className="flex min-h-14 items-center gap-3 rounded-xl bg-card px-3"><div className="min-w-0 flex-1"><strong className="block truncate text-sm">{item.name}</strong><span className="text-xs capitalize text-muted-foreground">{item.item_type} · {new Date(item.deleted_at).toLocaleDateString()}</span></div><Button variant="secondary" disabled={restoreItem.isPending} onClick={() => restoreItem.mutate(item.id)}>Restore</Button></li>)}</ul>}</DialogContent></Dialog>
    </div>
  )
}
