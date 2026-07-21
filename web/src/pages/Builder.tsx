import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Crown,
  GalleryHorizontal,
  Grid3X3,
  List,
  Minus,
  Plus,
  Save,
  Search as SearchIcon,
  Trash2,
} from "lucide-react"
import { api, cardImage, type CardResult, type DeckCard } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SinglesCarousel } from "@/components/cards/SinglesCarousel"
import { CardArtRail } from "@/components/cards/CardArtShowcase"
import { type ShowcaseCard, useShowcaseCards } from "@/hooks/useShowcaseCards"

interface BuilderCard {
  name: string
  qty: number
  scryfallId: string | null
  price: number
  custom_tag: string | null
  type_line: string
  cmc: number
  isCommander: boolean
}

const TYPE_ORDER = [
  "Creature",
  "Planeswalker",
  "Instant",
  "Sorcery",
  "Enchantment",
  "Artifact",
  "Land",
  "Other",
]

function primaryType(typeLine: string): string {
  for (const t of TYPE_ORDER) if (typeLine.includes(t)) return t
  return "Other"
}

export function Builder() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const isNew = !deckId || deckId === "new"

  const [name, setName] = useState("New Deck")
  const [cards, setCards] = useState<BuilderCard[]>([])
  const [savedDeckId, setSavedDeckId] = useState<string | null>(isNew ? null : deckId!)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [format, setFormat] = useState("commander")
  const [isPublic, setIsPublic] = useState(false)
  const [keepCheapest, setKeepCheapest] = useState(false)
  const [viewMode, setViewMode] = useState<"list" | "grid" | "single">(() => window.matchMedia("(max-width: 767px)").matches ? "single" : localStorage.getItem("grimore-builder-view") === "single" ? "single" : localStorage.getItem("grimore-builder-view") === "grid" ? "grid" : "list")
  const loadedRef = useRef(false)
  const revisionRef = useRef(0)
  const savingRef = useRef(false)
  const [autosaveNonce, setAutosaveNonce] = useState(0)

  useEffect(() => {
    localStorage.setItem("grimore-builder-view", viewMode)
  }, [viewMode])

  /* Load existing deck */
  const deckMeta = useQuery({
    queryKey: ["deck-meta", deckId],
    queryFn: () => api.get<{ deck_name: string; is_public: number; format: string; keep_cheapest?: number }>(`/api/decks/${deckId}`),
    enabled: !isNew,
  })
  const deckCards = useQuery({
    queryKey: ["deck-cards", deckId],
    queryFn: () => api.get<DeckCard[]>(`/api/decks/${deckId}/cards`),
    enabled: !isNew,
  })

  useEffect(() => {
    if (loadedRef.current || isNew) return
    if (deckMeta.data && deckCards.data) {
      loadedRef.current = true
      setName(deckMeta.data.deck_name)
      setFormat(deckMeta.data.format || "commander")
      setIsPublic(deckMeta.data.is_public === 1)
      setKeepCheapest(deckMeta.data.keep_cheapest === 1)
      setCards(
        deckCards.data.map((c) => ({
          name: c.card_name,
          qty: c.quantity,
          scryfallId: c.scryfall_id,
          price: c.cheapest_card_price ?? 0,
          custom_tag: c.custom_tag,
          type_line: c.type_line ?? "",
          cmc: c.cmc ?? 0,
          isCommander: c.is_commander === 1,
        }))
      )
    }
  }, [deckMeta.data, deckCards.data, isNew])

  /* Inline card search */
  const search = useQuery({
    queryKey: ["builder-search", searchTerm],
    queryFn: () =>
      api.get<{ cards: CardResult[] }>(
        `/api/cards/search?q=${encodeURIComponent(searchTerm)}&page=1&limit=12`
      ),
    enabled: searchTerm.trim().length >= 2,
    placeholderData: (prev) => prev,
  })
  const showcase = useShowcaseCards({
    preferred: cards.map((card) => ({ name: card.name, scryfallId: card.scryfallId })),
    fallbackQuery: "is:commander game:paper usd<25",
    limit: 8,
  })

  /* Derived stats */
  const totalCards = cards.reduce((a, c) => a + c.qty, 0)
  const totalPrice = cards.reduce((a, c) => a + c.price * c.qty, 0)
  const commander = cards.filter((c) => c.isCommander)
  const curve = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0]
    cards.forEach((c) => {
      if (c.type_line.includes("Land")) return
      const i = Math.min(6, Math.max(0, Math.floor(c.cmc)))
      buckets[i]! += c.qty
    })
    return buckets
  }, [cards])
  const curveMax = Math.max(1, ...curve)

  const grouped = useMemo(() => {
    const map = new Map<string, BuilderCard[]>()
    for (const c of cards.filter((c) => !c.isCommander)) {
      const t = primaryType(c.type_line)
      if (!map.has(t)) map.set(t, [])
      map.get(t)!.push(c)
    }
    return TYPE_ORDER.filter((t) => map.has(t)).map((t) => ({
      type: t,
      cards: map.get(t)!.sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name)),
    }))
  }, [cards])

  /* Mutations on local state */
  const mutate = (fn: (prev: BuilderCard[]) => BuilderCard[]) => {
    setCards(fn)
    markDirty()
  }

  const markDirty = () => {
    revisionRef.current += 1
    setDirty(true)
  }

  const addCard = (card: CardResult) =>
    mutate((prev) => {
      const existing = prev.find((c) => c.name === card.name)
      if (existing)
        return prev.map((c) => (c.name === card.name ? { ...c, qty: c.qty + 1 } : c))
      return [
        ...prev,
        {
          name: card.name,
          qty: 1,
          scryfallId: card.scryfallId ?? null,
          price: card.price ?? 0,
          custom_tag: null,
          type_line: card.type_line,
          cmc: card.cmc,
          isCommander: false,
        },
      ]
    })

  const chooseCommander = (card: ShowcaseCard) => {
    mutate((prev) => [
      ...prev.filter((item) => item.name !== card.name),
      {
        name: card.name,
        qty: 1,
        scryfallId: card.scryfallId ?? null,
        price: card.price ?? 0,
        custom_tag: null,
        type_line: card.typeLine || "Legendary Creature",
        cmc: card.cmc ?? 0,
        isCommander: true,
      },
    ])
    toast.success(`${card.name} is your commander`)
  }

  const setQty = (name: string, qty: number) =>
    mutate((prev) =>
      qty <= 0
        ? prev.filter((c) => c.name !== name)
        : prev.map((c) => (c.name === name ? { ...c, qty } : c))
    )

  const toggleCommander = (name: string) =>
    mutate((prev) => prev.map((c) => (c.name === name ? { ...c, isCommander: !c.isCommander } : c)))

  /* Autosave (debounced) */
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => {
      void save()
    }, 1200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, name, format, isPublic, keepCheapest, dirty, autosaveNonce])

  async function save() {
    if (savingRef.current) return
    savingRef.current = true
    const savingRevision = revisionRef.current
    setSaving(true)
    try {
      const body = {
        deckId: savedDeckId,
        deckName: name || "New Deck",
        commanderCards: cards
          .filter((c) => c.isCommander)
          .map((c) => ({ name: c.name, qty: c.qty, scryfallId: c.scryfallId, price: c.price, custom_tag: c.custom_tag })),
        mainboardCards: cards
          .filter((c) => !c.isCommander)
          .map((c) => ({ name: c.name, qty: c.qty, scryfallId: c.scryfallId, price: c.price, custom_tag: c.custom_tag })),
        isPublic: isPublic ? 1 : 0,
        format,
        keepCheapest: keepCheapest ? 1 : 0,
      }
      const res = await api.post<{ success: boolean; deckId: string }>(
        "/api/decks/builder-save",
        body
      )
      setSavedDeckId(res.deckId)
      if (revisionRef.current === savingRevision) setDirty(false)
      if (isNew) navigate(`/builder/${res.deckId}`, { replace: true })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Autosave failed")
    } finally {
      savingRef.current = false
      setSaving(false)
      if (revisionRef.current !== savingRevision) setAutosaveNonce((value) => value + 1)
    }
  }

  const loading = !isNew && (deckMeta.isPending || deckCards.isPending)

  return (
    <div className="mx-auto min-h-dvh max-w-[1600px] px-3 py-3 sm:px-4 lg:px-5">
      <h1 className="sr-only">{isNew ? "Create a deck" : `Edit ${name}`}</h1>
      {/* Top bar */}
      <header className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Button variant="secondary" size="icon" aria-label="Back to decks" onClick={() => navigate("/decks")}>
          <ArrowLeft />
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            markDirty()
          }}
          aria-label="Deck name"
          className="min-w-0 flex-1 text-base font-semibold sm:max-w-72"
        />
        <Select value={format} onValueChange={(value) => { setFormat(value); markDirty() }}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="commander">Commander</SelectItem><SelectItem value="brawl">Brawl</SelectItem><SelectItem value="standard">Standard</SelectItem></SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span>
            <span className="text-muted-foreground">Cards</span>{" "}
            <strong className="font-mono text-brass-bright">{totalCards}</strong>
          </span>
          <span>
            <span className="text-muted-foreground">Total</span>{" "}
            <strong className="font-mono text-brass-bright">${totalPrice.toFixed(2)}</strong>
          </span>
          <span
            className={cn(
              "hidden text-xs font-semibold uppercase tracking-wider sm:block",
              saving ? "text-arcane-bright" : dirty ? "text-muted-foreground" : "text-emerald-400"
            )}
          >
            {saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}
          </span>
          <Button variant="secondary" className="min-w-11" onClick={() => void save()} disabled={saving || !dirty}><Save /> <span className="hidden sm:inline">Save</span></Button>
        </div>
        <details className="group w-full text-sm"><summary className="flex min-h-11 w-fit cursor-pointer list-none items-center rounded-lg px-2 font-medium text-muted-foreground hover:bg-secondary hover:text-foreground">Deck options <ChevronDown className="ml-2 size-4 transition-transform group-open:rotate-180" /></summary><div className="flex flex-wrap gap-x-5 border-t border-border pt-2"><Label className="flex min-h-11 cursor-pointer items-center gap-2"><Checkbox checked={isPublic} onCheckedChange={(value) => { setIsPublic(value === true); markDirty() }} /> Public deck</Label><Label className="flex min-h-11 cursor-pointer items-center gap-2"><Checkbox checked={keepCheapest} onCheckedChange={(value) => { setKeepCheapest(value === true); markDirty() }} /> Keep cheapest printings</Label></div></details>
      </header>

      {(deckMeta.isError || deckCards.isError) && <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">This deck could not be loaded. Return to My Decks and try again.</div>}

      <div className="grid gap-4 xl:grid-cols-[135px_1fr]">
        {/* Left rail: commander + stats */}
        <aside className="order-2 grid grid-cols-2 gap-3 sm:grid-cols-[135px_1fr] xl:order-none xl:block xl:space-y-3">
          <section className="surface-panel rounded-xl p-2 sm:w-[135px]">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brass">
              <Crown className="h-4 w-4" /> Commander
            </h2>
            {commander.length === 0 ? (
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                Pick an inspiration card or search the library.
              </p>
            ) : (
              commander.map((c) => (
                <figure key={c.name} className="relative mx-auto mb-2 w-full max-w-[125px] overflow-hidden rounded-lg">
                  {c.scryfallId ? (
                    <img src={cardImage(c.scryfallId)} alt={c.name} className="w-full" />
                  ) : (
                    <div className="flex aspect-[0.716] items-center justify-center border border-border p-3 text-center text-sm">
                      {c.name}
                    </div>
                  )}
                  <button
                    className="absolute right-1 top-1 flex size-11 items-center justify-center rounded-full bg-background/90 text-brass-bright backdrop-blur"
                    onClick={() => toggleCommander(c.name)}
                    aria-label={`Demote ${c.name} from commander`}
                  >
                    <Crown className="h-4 w-4" />
                  </button>
                </figure>
              ))
            )}
          </section>

          <section className="surface-panel min-w-0 rounded-xl p-3 xl:w-[135px]">
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-parchment">Curve</h2>
            <div className="flex h-16 items-end justify-between gap-1">
              {curve.map((n, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-linear-to-t from-brass-deep to-brass-bright"
                    style={{ height: `${(n / curveMax) * 100}%`, minHeight: n > 0 ? 3 : 0 }}
                  />
                  <span className="text-[0.6rem] text-muted-foreground">{i === 6 ? "7+" : i}</span>
                </div>
              ))}
            </div>
            <dl className="mt-3 space-y-1 border-t border-border pt-2 text-xs"><div className="flex justify-between"><dt className="text-muted-foreground">Cards</dt><dd className="font-mono">{totalCards}/100</dd></div><div className="flex justify-between"><dt className="text-muted-foreground">Value</dt><dd className="font-mono text-primary">${totalPrice.toFixed(2)}</dd></div></dl>
          </section>
        </aside>

        {/* Main: search + list */}
        <section className="order-first min-w-0 xl:order-none">
          <div className="sticky top-0 z-20 flex gap-2 bg-background/90 pb-3 backdrop-blur-xl">
            <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Add cards — search the library…"
              className="pl-10"
              aria-label="Add cards"
            />
            {searchTerm.trim().length >= 2 && (
              <div className="absolute inset-x-0 top-12 z-30 max-h-[min(60vh,480px)] overflow-y-auto rounded-xl border border-border bg-popover shadow-lg">
                {search.isPending ? (
                  <p className="p-4 text-sm text-muted-foreground">Searching…</p>
                ) : (search.data?.cards ?? []).length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No cards found.</p>
                ) : (
                  (search.data?.cards ?? []).map((card) => (
                    <button
                      key={`${card.name}-${card.scryfallId}`}
                      className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => {
                        addCard(card)
                        setSearchTerm("")
                        toast.success(`Added ${card.name}`)
                      }}
                    >
                      {card.scryfallId && (
                        <img
                          src={cardImage(card.scryfallId, "small")}
                          alt=""
                          className="h-12 w-9 rounded object-cover"
                          loading="lazy"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{card.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {card.type_line}
                        </span>
                      </span>
                      {typeof card.price === "number" && (
                        <span className="font-mono text-xs text-brass-bright">
                          ${card.price.toFixed(2)}
                        </span>
                      )}
                      <Plus className="h-4 w-4 text-brass" />
                    </button>
                  ))
                )}
              </div>
            )}
            </div>
            <div className="flex rounded-xl border border-border bg-secondary/55 p-1" aria-label="Deck view">
              <Button variant="ghost" size="icon" className={cn("size-11 border-0 sm:size-9", viewMode === "list" && "bg-primary/12 text-primary hover:bg-primary/16")} aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List /></Button>
              <Button variant="ghost" size="icon" className={cn("size-11 border-0 sm:size-9", viewMode === "grid" && "bg-primary/12 text-primary hover:bg-primary/16")} aria-label="Card grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid3X3 /></Button>
              <Button variant="ghost" size="icon" className={cn("size-11 border-0 sm:size-9", viewMode === "single" && "bg-primary/12 text-primary hover:bg-primary/16")} aria-label="Singles swipe view" aria-pressed={viewMode === "single"} onClick={() => setViewMode("single")}><GalleryHorizontal /></Button>
            </div>
          </div>

          {loading ? (
            <div className="mt-6 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          ) : cards.length === 0 ? (
            <div className="mt-8">
              <div className="mb-7 text-center">
                <h2 className="text-2xl font-semibold">Choose your commander</h2>
                <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">Tap a suggestion below or search the library above. Your own cards replace these live suggestions as the deck takes shape.</p>
              </div>
              <CardArtRail cards={showcase.cards} title="Commander inspiration" isFallback={showcase.isFallback} isPending={showcase.isPending} onSelect={chooseCommander} actionLabel="Choose as commander" />
            </div>
          ) : viewMode === "single" ? (
            <SinglesCarousel items={cards} getKey={(card) => card.name} ariaLabel="Deck singles">
              {(card) => (
                <article className="mx-auto grid max-w-3xl items-center gap-5 md:grid-cols-[minmax(260px,360px)_1fr] md:gap-8">
                  <div className="relative mx-auto w-[min(78vw,360px)] overflow-hidden rounded-xl border border-border bg-card">
                    {card.scryfallId ? <img src={cardImage(card.scryfallId)} alt={card.name} className="aspect-[0.716] w-full object-cover" /> : <div className="flex aspect-[0.716] items-center justify-center p-6 text-center text-sm text-muted-foreground">{card.name}</div>}
                    {card.isCommander && <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-xs font-semibold text-primary"><Crown className="size-3.5" /> Commander</span>}
                  </div>
                  <div className="min-w-0 px-2 text-center md:px-0 md:text-left">
                    <h2 className="text-balance font-display text-2xl font-semibold md:text-3xl">{card.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{card.type_line || "Card details unavailable"}</p>
                    <dl className="mt-5 grid grid-cols-3 divide-x divide-border border-y border-border py-3 text-center"><div><dt className="text-xs text-muted-foreground">Copies</dt><dd className="mt-1 font-mono text-lg text-primary">{card.qty}</dd></div><div><dt className="text-xs text-muted-foreground">Each</dt><dd className="mt-1 font-mono text-sm">${card.price.toFixed(2)}</dd></div><div><dt className="text-xs text-muted-foreground">Total</dt><dd className="mt-1 font-mono text-sm">${(card.price * card.qty).toFixed(2)}</dd></div></dl>
                    <div className="mt-5 flex flex-wrap justify-center gap-2 md:justify-start">
                      <Button type="button" variant="secondary" size="icon" className="size-11" aria-label={`Remove one ${card.name}`} onClick={() => setQty(card.name, card.qty - 1)}><Minus /></Button>
                      <Button type="button" size="icon" className="size-11" aria-label={`Add one ${card.name}`} onClick={() => setQty(card.name, card.qty + 1)}><Plus /></Button>
                      <Button type="button" variant="secondary" className="min-h-11" aria-pressed={card.isCommander} onClick={() => toggleCommander(card.name)}><Crown /> {card.isCommander ? "Commander" : "Make commander"}</Button>
                      <Button type="button" variant="ghost" size="icon" className="size-11 text-destructive" aria-label={`Remove ${card.name}`} onClick={() => setQty(card.name, 0)}><Trash2 /></Button>
                    </div>
                  </div>
                </article>
              )}
            </SinglesCarousel>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(135px,1fr))] gap-2">
              {cards.map((card) => <article key={card.name} className="group relative min-w-0 overflow-hidden rounded-lg bg-card"><button type="button" className="block w-full" onClick={() => setQty(card.name, card.qty + 1)} aria-label={`Add one ${card.name}`}>{card.scryfallId ? <img src={cardImage(card.scryfallId)} alt={card.name} loading="lazy" className="aspect-[0.716] w-full object-cover" /> : <div className="flex aspect-[0.716] items-center justify-center p-3 text-center text-xs">{card.name}</div>}</button><div className="flex min-h-11 items-center gap-1 px-2"><span className="font-mono text-xs text-primary">{card.qty}×</span><span className="min-w-0 flex-1 truncate text-xs font-medium">{card.name}</span><Button variant="ghost" size="icon" className="size-11 sm:size-9" aria-label={`Remove one ${card.name}`} onClick={() => setQty(card.name, card.qty - 1)}><Minus /></Button></div>{card.isCommander && <Crown className="absolute left-2 top-2 size-5 rounded-full bg-background/90 p-1 text-primary" />}</article>)}
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {grouped.map((group) => (
                <section key={group.type}>
                  <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-parchment">
                    {group.type}{" "}
                    <span className="font-mono text-muted-foreground">
                      {group.cards.reduce((a, c) => a + c.qty, 0)}
                    </span>
                  </h3>
                  <ul className="overflow-hidden rounded-xl border border-border">
                    {group.cards.map((c) => (
                      <li
                        key={c.name}
                        className="flex min-h-12 items-center gap-2 border-b border-border bg-card/50 px-2 py-1 last:border-b-0 hover:bg-card sm:px-3"
                      >
                        <span className="w-10 text-center font-mono text-sm text-muted-foreground">
                          {c.qty}×
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                        <span className="hidden font-mono text-xs text-muted-foreground sm:block">
                          ${(c.price * c.qty).toFixed(2)}
                        </span>
                        <span className="hidden font-mono text-[0.65rem] text-muted-foreground/60 md:block">
                          {c.cmc}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 sm:size-9"
                            aria-label={`Make ${c.name} commander`}
                            onClick={() => toggleCommander(c.name)}
                          >
                            <Crown className="h-4 w-4 text-muted-foreground hover:text-brass-bright" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 sm:size-9"
                            aria-label={`Remove one ${c.name}`}
                            onClick={() => setQty(c.name, c.qty - 1)}
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 sm:size-9"
                            aria-label={`Add one ${c.name}`}
                            onClick={() => setQty(c.name, c.qty + 1)}
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11 sm:size-9"
                            aria-label={`Remove ${c.name}`}
                            onClick={() => setQty(c.name, 0)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive/70" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
