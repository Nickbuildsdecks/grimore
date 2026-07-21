import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ArrowDown,
  ArrowUp,
  Brush,
  Check,
  ChevronLeft,
  ChevronRight,
  GalleryHorizontal,
  Grid2X2,
  History,
  LayoutList,
  LoaderCircle,
  Plus,
  Search as SearchIcon,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  UserCheck,
  UserPlus,
  X,
} from "lucide-react"
import { api, type CardResult, type Deck, type DeckCard } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SinglesCarousel } from "@/components/cards/SinglesCarousel"
import { CardArtAtmosphere } from "@/components/cards/CardArtShowcase"
import { PageHeader } from "@/components/PageHeader"

interface SearchResponse {
  cards: CardResult[]
  totalCards: number
  hasMore: boolean
}

interface FiltersState {
  type: string
  rarity: string
  format: string
  colors: string[]
  identityMode: "exact" | "at-most" | "includes"
  manaMin: string
  manaMax: string
  priceMax: string
}

interface CardDetails extends CardResult {
  legalities?: Record<string, string>
}

interface CardVersion {
  id: string
  name: string
  set: string
  set_name: string
  collector_number: string
  rarity: string
  price: number
  prices?: { normal: number | null; foil: number | null; etched: number | null }
  image_uri: string
  foil: boolean
  artist: string
  artistFollowed: boolean
  likes: number
  dislikes: number
  userVote: -1 | 0 | 1
}

interface FollowedArtist {
  name: string
  followedAt: string
}

interface ArtistFollowVariables {
  artist: string
  following: boolean
  printing: {
    cardName: string
    scryfallId: string
    imageUri: string
    setName: string
  }
}

interface ArtVoteResponse {
  success: boolean
  scryfallId: string
  likes: number
  dislikes: number
  userVote: -1 | 0 | 1
}

type ViewMode = "comfortable" | "compact" | "list" | "single"

const PAGE_SIZE = 25
const EMPTY_FILTERS: FiltersState = {
  type: "any",
  rarity: "any",
  format: "any",
  colors: [],
  identityMode: "exact",
  manaMin: "",
  manaMax: "",
  priceMax: "",
}

const QUICK = [
  { label: "Commanders", q: "is:commander" },
  { label: "Card draw", q: 'oracle:"draw a card"' },
  { label: "Removal", q: 'oracle:"destroy target"' },
  { label: "Ramp", q: 'oracle:"search your library for a" type:land' },
]

const COLOR_OPTIONS = [
  { value: "W", className: "bg-[#f5f0dc] text-black" },
  { value: "U", className: "bg-[#3b82f6] text-white" },
  { value: "B", className: "bg-[#3f3b45] text-white" },
  { value: "R", className: "bg-[#dc4b3e] text-white" },
  { value: "G", className: "bg-[#27905d] text-white" },
]

function safePage(value: string | null) {
  const parsed = Number.parseInt(value || "1", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function readRecentSearches(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("grimore-recent-card-searches") || "[]")
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 5) : []
  } catch {
    return []
  }
}

function formatPrice(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`
}

function artistSearchQuery(artist: string) {
  return `artist:"${artist.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function composeQuery(base: string, filters: FiltersState) {
  const identityOperator = filters.identityMode === "at-most" ? "<=" : filters.identityMode === "includes" ? ">=" : "="
  return [
    base.trim(),
    filters.type !== "any" ? `type:${filters.type}` : "",
    filters.rarity !== "any" ? `rarity:${filters.rarity}` : "",
    filters.format !== "any" ? `format:${filters.format}` : "",
    filters.colors.length ? `id${identityOperator}${filters.colors.join("")}` : "",
    filters.manaMin ? `mv>=${filters.manaMin}` : "",
    filters.manaMax ? `mv<=${filters.manaMax}` : "",
    filters.priceMax ? `usd<=${filters.priceMax}` : "",
  ].filter(Boolean).join(" ")
}

export function CardSearch() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const searchRef = useRef<HTMLInputElement>(null)

  const initialFilters = useRef<FiltersState>({
    type: searchParams.get("type") || "any",
    rarity: searchParams.get("rarity") || "any",
    format: searchParams.get("format") || "any",
    colors: (searchParams.get("colors") || "").split("").filter(Boolean),
    identityMode: (searchParams.get("identity") as FiltersState["identityMode"]) || "exact",
    manaMin: searchParams.get("mvMin") || "",
    manaMax: searchParams.get("mvMax") || "",
    priceMax: searchParams.get("priceMax") || "",
  }).current

  const [input, setInput] = useState(() => searchParams.get("q") || "")
  const [baseQuery, setBaseQuery] = useState(() => searchParams.get("q") || "")
  const [query, setQuery] = useState(() => composeQuery(searchParams.get("q") || "", initialFilters))
  const [page, setPage] = useState(() => safePage(searchParams.get("page")))
  const [sort, setSort] = useState(() => searchParams.get("sort") || "name")
  const [direction, setDirection] = useState<"asc" | "desc">(() => searchParams.get("dir") === "desc" ? "desc" : "asc")
  const [view, setView] = useState<ViewMode>(() => {
    const requested = searchParams.get("view")
    if (requested === "compact" || requested === "list" || requested === "single" || requested === "comfortable") return requested
    if (window.matchMedia("(max-width: 767px)").matches) return "single"
    const saved = localStorage.getItem("grimore-card-search-view")
    return saved === "compact" || saved === "list" || saved === "single" ? saved : "comfortable"
  })
  const [targetDeck, setTargetDeck] = useState(() => localStorage.getItem("grimore-search-target-deck") || "")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filters, setFilters] = useState<FiltersState>(initialFilters)
  const [draftFilters, setDraftFilters] = useState<FiltersState>(initialFilters)
  const [selectedCard, setSelectedCard] = useState<CardResult | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState("")
  const [visibleVersionCount, setVisibleVersionCount] = useState(12)
  const [recentSearches, setRecentSearches] = useState(readRecentSearches)

  const decks = useQuery({
    queryKey: ["my-decks"],
    queryFn: () => api.get<Deck[]>("/api/decks/my-decks"),
  })

  const followedArtists = useQuery({
    queryKey: ["followed-artists"],
    queryFn: () => api.get<FollowedArtist[]>("/api/artists/followed"),
  })

  useEffect(() => {
    if (!decks.data) return
    if (targetDeck && !decks.data.some((deck) => deck.id === targetDeck)) setTargetDeck("")
  }, [decks.data, targetDeck])

  useEffect(() => {
    if (targetDeck) localStorage.setItem("grimore-search-target-deck", targetDeck)
    else localStorage.removeItem("grimore-search-target-deck")
  }, [targetDeck])

  useEffect(() => {
    localStorage.setItem("grimore-card-search-view", view)
  }, [view])

  useEffect(() => {
    const next = new URLSearchParams()
    if (baseQuery.trim()) next.set("q", baseQuery.trim())
    if (page > 1) next.set("page", String(page))
    if (sort !== "name") next.set("sort", sort)
    if (direction !== "asc") next.set("dir", direction)
    if (view !== "comfortable") next.set("view", view)
    if (filters.type !== "any") next.set("type", filters.type)
    if (filters.rarity !== "any") next.set("rarity", filters.rarity)
    if (filters.format !== "any") next.set("format", filters.format)
    if (filters.colors.length) next.set("colors", filters.colors.join(""))
    if (filters.identityMode !== "exact") next.set("identity", filters.identityMode)
    if (filters.manaMin) next.set("mvMin", filters.manaMin)
    if (filters.manaMax) next.set("mvMax", filters.manaMax)
    if (filters.priceMax) next.set("priceMax", filters.priceMax)
    setSearchParams(next, { replace: true })
  }, [baseQuery, direction, filters, page, query, setSearchParams, sort, view])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable
      if (event.key === "/" && !isTyping) {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setInput("")
        setBaseQuery("")
        setQuery("")
        setPage(1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const results = useQuery({
    queryKey: ["card-search", query, page, sort, direction],
    queryFn: () => api.get<SearchResponse>(
      `/api/cards/search?q=${encodeURIComponent(query)}&page=${page}&limit=${PAGE_SIZE}&sort=${sort}&dir=${direction}`
    ),
    enabled: query.trim().length > 0,
    placeholderData: (previous) => previous,
  })

  const targetDeckCards = useQuery({
    queryKey: ["deck-cards", targetDeck],
    queryFn: () => api.get<DeckCard[]>(`/api/decks/${targetDeck}/cards`),
    enabled: Boolean(targetDeck),
  })

  const cardDetails = useQuery({
    queryKey: ["card-details", selectedCard?.name],
    queryFn: () => api.get<CardDetails>(`/api/cards/details?name=${encodeURIComponent(selectedCard?.name || "")}`),
    enabled: Boolean(selectedCard),
  })

  const versions = useQuery({
    queryKey: ["card-versions", selectedCard?.name],
    queryFn: () => api.get<CardVersion[]>(`/api/cards/versions?name=${encodeURIComponent(selectedCard?.name || "")}`),
    enabled: Boolean(selectedCard),
  })

  useEffect(() => {
    if (!selectedCard) {
      setSelectedVersionId("")
      return
    }
    setSelectedVersionId(selectedCard.scryfallId || "")
    setVisibleVersionCount(12)
  }, [selectedCard])

  useEffect(() => {
    if (!selectedCard || !versions.data?.length) return
    const preferred = versions.data.find((version) => version.artistFollowed)
    if (preferred && (!selectedVersionId || selectedVersionId === selectedCard.scryfallId)) {
      setSelectedVersionId(preferred.id)
    }
  }, [selectedCard, selectedVersionId, versions.data])

  const followArtist = useMutation({
    mutationFn: ({ artist, following, printing }: ArtistFollowVariables) =>
      api.post<{ success: boolean; artist: string; following: boolean }>("/api/artists/follow", {
        artist,
        following,
        printing,
      }),
    onMutate: async ({ artist, following }) => {
      const versionsKey = selectedCard ? ["card-versions", selectedCard.name] : null
      await Promise.all([
        versionsKey ? qc.cancelQueries({ queryKey: versionsKey }) : Promise.resolve(),
        qc.cancelQueries({ queryKey: ["followed-artists"] }),
        qc.cancelQueries({ queryKey: ["card-search"] }),
      ])
      const previousVersions = versionsKey ? qc.getQueryData<CardVersion[]>(versionsKey) : undefined
      const previousArtists = qc.getQueryData<FollowedArtist[]>(["followed-artists"])
      const previousSearches = qc.getQueriesData<SearchResponse>({ queryKey: ["card-search"] })
      const artistKey = artist.toLocaleLowerCase()
      if (versionsKey) {
        qc.setQueryData<CardVersion[]>(versionsKey, (current) => current?.map((item) =>
          item.artist.toLocaleLowerCase() === artistKey ? { ...item, artistFollowed: following } : item
        ))
      }
      qc.setQueriesData<SearchResponse>({ queryKey: ["card-search"] }, (current) => current ? {
        ...current,
        cards: current.cards.map((card) => card.artist?.toLocaleLowerCase() === artistKey ? { ...card, artistFollowed: following } : card),
      } : current)
      qc.setQueryData<FollowedArtist[]>(["followed-artists"], (current = []) => following
        ? [...current.filter((item) => item.name.toLocaleLowerCase() !== artistKey), { name: artist, followedAt: new Date().toISOString() }].sort((a, b) => a.name.localeCompare(b.name))
        : current.filter((item) => item.name.toLocaleLowerCase() !== artistKey)
      )
      return { previousVersions, previousArtists, previousSearches, versionsKey }
    },
    onSuccess: ({ artist, following }) => {
      toast.success(following ? `Following ${artist}` : `Unfollowed ${artist}`)
      void qc.invalidateQueries({ queryKey: ["card-search"] })
    },
    onError: (error, _variables, context) => {
      if (context?.previousVersions && context.versionsKey) qc.setQueryData(context.versionsKey, context.previousVersions)
      if (context?.previousArtists) qc.setQueryData(["followed-artists"], context.previousArtists)
      context?.previousSearches.forEach(([queryKey, data]) => qc.setQueryData(queryKey, data))
      toast.error(error instanceof Error ? error.message : "Could not update this illustrator")
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["followed-artists"] })
      if (selectedCard) void qc.invalidateQueries({ queryKey: ["card-versions", selectedCard.name] })
    },
  })

  const voteForArt = useMutation({
    mutationFn: ({ version, vote, cardName }: { version: CardVersion; vote: -1 | 0 | 1; cardName: string }) =>
      api.post<ArtVoteResponse>(`/api/cards/versions/${version.id}/vote`, { cardName, vote }),
    onMutate: async ({ version, vote, cardName }) => {
      const queryKey = ["card-versions", cardName]
      await qc.cancelQueries({ queryKey })
      const previous = qc.getQueryData<CardVersion[]>(queryKey)
      qc.setQueryData<CardVersion[]>(queryKey, (current) => current?.map((item) => {
        if (item.id !== version.id) return item
        return {
          ...item,
          likes: Math.max(0, item.likes - (item.userVote === 1 ? 1 : 0) + (vote === 1 ? 1 : 0)),
          dislikes: Math.max(0, item.dislikes - (item.userVote === -1 ? 1 : 0) + (vote === -1 ? 1 : 0)),
          userVote: vote,
        }
      }))
      return { previous, queryKey }
    },
    onSuccess: (result, { cardName }) => {
      qc.setQueryData<CardVersion[]>(["card-versions", cardName], (current) => current?.map((item) =>
        item.id === result.scryfallId
          ? { ...item, likes: result.likes, dislikes: result.dislikes, userVote: result.userVote }
          : item
      ))
    },
    onError: (error, _variables, context) => {
      if (context?.previous) qc.setQueryData(context.queryKey, context.previous)
      toast.error(error instanceof Error ? error.message : "Could not save your art preference")
    },
  })

  const addCard = useMutation({
    mutationFn: (card: CardResult) => {
      if (!targetDeck) throw new Error("Choose a deck first")
      return api.post<{ success: boolean; quantity: number }>(`/api/decks/${targetDeck}/cards`, {
        name: card.name,
        price: card.price ?? 0.10,
        scryfallId: card.scryfallId ?? null,
      })
    },
    onSuccess: (data, card) => {
      toast.success(`${card.name} added · ${data.quantity} in deck`)
      void qc.invalidateQueries({ queryKey: ["deck-cards", targetDeck] })
      void qc.invalidateQueries({ queryKey: ["my-decks"] })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add card"),
  })

  const cardQuantities = useMemo(() => new Map(
    (targetDeckCards.data ?? []).map((card) => [card.card_name.toLowerCase(), card.quantity])
  ), [targetDeckCards.data])

  function rememberSearch(value: string) {
    if (!value.trim()) return
    const next = [value.trim(), ...recentSearches.filter((item) => item !== value.trim())].slice(0, 5)
    setRecentSearches(next)
    localStorage.setItem("grimore-recent-card-searches", JSON.stringify(next))
  }

  function runSearch(base: string, nextFilters = filters) {
    const value = composeQuery(base, nextFilters)
    setInput(base)
    setBaseQuery(base)
    setPage(1)
    setQuery(value)
    rememberSearch(base)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    runSearch(input)
  }

  function resetSearch() {
    setInput("")
    setBaseQuery("")
    setQuery("")
    setPage(1)
    setFilters(EMPTY_FILTERS)
    setDraftFilters(EMPTY_FILTERS)
    searchRef.current?.focus()
  }

  function removeFilter(key: keyof FiltersState) {
    const next = { ...filters, [key]: key === "colors" ? [] : EMPTY_FILTERS[key] } as FiltersState
    setFilters(next)
    runSearch(input, next)
  }

  const activeFilters = [
    filters.format !== "any" ? { key: "format" as const, label: filters.format } : null,
    filters.type !== "any" ? { key: "type" as const, label: filters.type } : null,
    filters.rarity !== "any" ? { key: "rarity" as const, label: filters.rarity } : null,
    filters.colors.length ? { key: "colors" as const, label: `${filters.identityMode}: ${filters.colors.join("")}` } : null,
    filters.manaMin ? { key: "manaMin" as const, label: `MV ≥ ${filters.manaMin}` } : null,
    filters.manaMax ? { key: "manaMax" as const, label: `MV ≤ ${filters.manaMax}` } : null,
    filters.priceMax ? { key: "priceMax" as const, label: `≤ $${filters.priceMax}` } : null,
  ].filter(Boolean) as { key: keyof FiltersState; label: string }[]

  const totalPages = results.data ? Math.max(1, Math.ceil(results.data.totalCards / PAGE_SIZE)) : 1
  const atmosphereCards = (results.data?.cards ?? []).slice(0, 3).map((card) => ({
    name: card.name,
    scryfallId: card.scryfallId,
    imageUri: card.image_uri,
  }))
  const selectedVersion = versions.data?.find((version) => version.id === selectedVersionId) ?? versions.data?.[0]
  const detailCard: CardResult | null = selectedCard ? {
    ...selectedCard,
    scryfallId: selectedVersion?.id || selectedCard.scryfallId,
    image_uri: selectedVersion?.image_uri || selectedCard.image_uri,
    price: selectedVersion?.price ?? selectedCard.price,
  } : null

  function paginationControls(position: "top" | "bottom") {
    if (totalPages <= 1) return null
    return (
      <nav aria-label={`${position === "top" ? "Top" : "Bottom"} search pagination`} className={cn("flex items-center gap-1", position === "top" && "search-top-pagination")}>
        <Button variant="secondary" size="icon" className="size-11" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} aria-label="Previous page"><ChevronLeft /></Button>
        <span className="min-w-16 text-center text-sm text-muted-foreground">{page} / {totalPages}</span>
        <Button variant="secondary" size="icon" className="size-11" disabled={!results.data?.hasMore} onClick={() => setPage((current) => current + 1)} aria-label="Next page"><ChevronRight /></Button>
      </nav>
    )
  }

  function addButton(card: CardResult, expanded = false) {
    const quantity = cardQuantities.get(card.name.toLowerCase()) ?? 0
    const pending = addCard.isPending && addCard.variables?.name === card.name
    const button = (
      <Button
        size={expanded ? "default" : "icon"}
        variant={targetDeck ? "default" : "secondary"}
        className={cn("relative shrink-0", expanded && "w-full")}
        aria-label={targetDeck ? `Add ${card.name} to selected deck` : "Choose a deck before adding cards"}
        disabled={!targetDeck || pending}
        onClick={() => addCard.mutate(card)}
      >
        {pending ? <LoaderCircle className="animate-spin" /> : quantity > 0 ? <Check /> : <Plus />}
        {expanded && (targetDeck ? quantity > 0 ? `Add another · ${quantity} in deck` : "Add to selected deck" : "Choose a deck to add this card")}
        {!expanded && quantity > 0 && <span className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 font-mono text-[0.62rem] font-bold text-accent-foreground">{quantity}</span>}
      </Button>
    )
    if (targetDeck) return button
    return <Tooltip><TooltipTrigger asChild><span className={cn("inline-flex", expanded && "w-full")}>{button}</span></TooltipTrigger><TooltipContent>Choose or create a deck first</TooltipContent></Tooltip>
  }

  return (
    <TooltipProvider>
      <div className="card-search-page page-wrap relative isolate pb-5 md:pb-8" data-view={view}>
        <CardArtAtmosphere cards={atmosphereCards} className="search-art-atmosphere" />
        <PageHeader className="card-search-page-header" title="Card Search" description="Find exact cards, explore Scryfall syntax, compare printings, and add directly to a deck." />

        <form onSubmit={submit} className="search-command-panel surface-panel sticky top-0 z-20 rounded-xl p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="search-command-field relative min-w-0 flex-[1_1_320px]">
              <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input ref={searchRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Card name or Scryfall syntax" className="pl-10 pr-11 text-base" aria-label="Card search" />
              {input ? <button type="button" aria-label="Clear search" className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={resetSearch}><X className="size-4" /></button> : <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground sm:block">/</kbd>}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
              <Button type="submit" className="search-submit w-full px-6 sm:w-auto" disabled={!input.trim() || results.isFetching}>{results.isFetching ? <LoaderCircle className="animate-spin" /> : <SearchIcon />}<span className="search-action-label">Search</span></Button>
              <Button type="button" variant="secondary" className="search-filters w-full sm:w-auto" aria-expanded={filtersOpen} onClick={() => { setDraftFilters(filters); setFiltersOpen(true) }}><SlidersHorizontal /><span className="search-action-label">Filters</span>{activeFilters.length > 0 && <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[0.65rem] text-primary-foreground">{activeFilters.length}</span>}</Button>
            </div>
          </div>
          {activeFilters.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2" aria-label="Active filters">{activeFilters.map((filter) => <button key={filter.key} type="button" className="flex min-h-8 items-center gap-1 rounded-full bg-secondary px-2.5 text-xs font-medium capitalize text-secondary-foreground hover:bg-secondary/80" onClick={() => removeFilter(filter.key)}>{filter.label}<X className="size-3" /></button>)}</div>}
          {(followedArtists.data?.length ?? 0) > 0 && <nav className="search-followed-artists scrollbar-thin mt-2 flex items-center gap-2 overflow-x-auto border-t border-border pt-2" aria-label="Followed illustrators"><span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground"><Brush className="size-3.5" /> Illustrators</span>{followedArtists.data?.map((artist) => <button key={artist.name} type="button" className="min-h-11 shrink-0 rounded-full bg-secondary px-3 text-xs font-medium text-secondary-foreground transition-colors hover:bg-primary/15 hover:text-primary" onClick={() => runSearch(artistSearchQuery(artist.name))}>Art by {artist.name}</button>)}</nav>}
        </form>

        {query && <div className={cn("search-deck-context mt-3 flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border pb-3 text-sm", (decks.data?.length ?? 0) === 0 && "is-empty")}>{(decks.data?.length ?? 0) > 0 ? <><span className="text-muted-foreground">Add results to</span><Select value={targetDeck} onValueChange={setTargetDeck}><SelectTrigger className="w-full sm:w-56" aria-label="Deck receiving searched cards"><SelectValue placeholder="Choose a deck" /></SelectTrigger><SelectContent>{(decks.data ?? []).map((deck) => <SelectItem key={deck.id} value={deck.id}>{deck.deck_name}</SelectItem>)}</SelectContent></Select></> : <><span className="max-w-[48ch] text-muted-foreground">Browse freely, or create a deck to start saving cards.</span><Button variant="secondary" asChild><Link to="/builder/new"><Plus /> Create a deck</Link></Button></>}</div>}

        {!query ? (
          <section className="mx-auto max-w-3xl py-8 text-center md:py-10">
            <h2 className="text-2xl font-semibold">Search by name, role, rules text, or Scryfall syntax</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">Use a quick role below or type directly into the command bar.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">{QUICK.map((item) => <Button key={item.label} variant="secondary" onClick={() => runSearch(item.q)}>{item.label}</Button>)}</div>
            {recentSearches.length > 0 && <div className="mt-6 border-t border-border pt-5"><p className="mb-2 flex items-center justify-center gap-2 text-xs font-semibold text-muted-foreground"><History className="size-4" /> Recent searches</p><div className="flex flex-wrap justify-center gap-2">{recentSearches.map((item) => <Button key={item} variant="ghost" size="sm" onClick={() => runSearch(item)}>{item}</Button>)}</div></div>}
          </section>
        ) : (
          <>
            <div className="search-results-toolbar mt-4 flex flex-col items-stretch gap-3 border-b border-border px-1 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="search-results-count"><p className="text-sm"><strong className="font-mono text-lg">{results.data?.totalCards ?? "…"}</strong> <span className="text-muted-foreground">{results.data?.totalCards === 1 ? "card" : "cards"}</span></p><p className="max-w-[52ch] truncate font-mono text-[0.68rem] text-muted-foreground" title={query}>{query}</p></div>
              <div className="search-results-controls w-full space-y-2 sm:flex sm:w-auto sm:items-center sm:gap-2 sm:space-y-0">
                <div className="search-sort-controls flex gap-2">
                  <Select value={sort} onValueChange={(value) => { setSort(value); setPage(1) }}><SelectTrigger className="min-w-0 flex-1 sm:w-32" aria-label="Sort results"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="name">Name</SelectItem><SelectItem value="price">Price</SelectItem><SelectItem value="cmc">Mana value</SelectItem><SelectItem value="rarity">Rarity</SelectItem></SelectContent></Select>
                  <Tooltip><TooltipTrigger asChild><Button variant="secondary" size="icon" aria-label={direction === "asc" ? "Sort descending" : "Sort ascending"} onClick={() => { setDirection((current) => current === "asc" ? "desc" : "asc"); setPage(1) }}>{direction === "asc" ? <ArrowUp /> : <ArrowDown />}</Button></TooltipTrigger><TooltipContent>{direction === "asc" ? "Ascending" : "Descending"}</TooltipContent></Tooltip>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="search-view-controls flex items-center rounded-xl border border-border bg-secondary/55 p-1" aria-label="Result layout">
                  {([['comfortable', Grid2X2, 'Comfortable grid'], ['compact', Grid2X2, 'Compact grid'], ['list', LayoutList, 'List view'], ['single', GalleryHorizontal, 'Singles swipe view']] as const).map(([mode, Icon, label]) => <Tooltip key={mode}><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={label} aria-pressed={view === mode} onClick={() => setView(mode)} className={cn("search-view-option size-11 border-0", `search-view-option-${mode}`, view === mode && "bg-primary/12 text-primary hover:bg-primary/16")}>{<Icon className={cn("size-4", mode === "compact" && "scale-75")} />}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}
                  </div>
                  {paginationControls("top")}
                </div>
              </div>
            </div>

            {results.isPending ? (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">{Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="aspect-[0.716] rounded-xl" />)}</div>
            ) : results.isError ? (
              <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/10 p-6"><h2 className="font-semibold">Search failed</h2><p className="mt-1 text-sm text-muted-foreground">Try a card name, remove a filter, or simplify the Scryfall query.</p><Button variant="secondary" className="mt-4" onClick={() => void results.refetch()}>Try again</Button></div>
            ) : (results.data?.cards ?? []).length === 0 ? (
              <div className="py-16 text-center"><h2 className="font-display text-2xl font-semibold">No cards found</h2><p className="mt-2 text-sm text-muted-foreground">Check spelling, remove a filter, or try a broader query.</p><Button variant="secondary" className="mt-4" onClick={resetSearch}>Clear search</Button></div>
            ) : view === "single" ? (
              <SinglesCarousel items={results.data?.cards ?? []} getKey={(card) => `${card.name}-${card.scryfallId}`} ariaLabel="Card search singles">
                {(card) => (
                  <article className="mx-auto grid max-w-3xl items-center gap-5 md:grid-cols-[minmax(260px,360px)_1fr] md:gap-8">
                    <div className="relative mx-auto w-[min(78vw,360px)] overflow-hidden rounded-xl border border-border bg-card">
                      {card.artistFollowed && <span className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-xs font-semibold text-primary"><Brush className="size-3.5 shrink-0" /><span className="truncate">{card.artist}</span></span>}
                      {card.image_uri ? <img src={card.image_uri} alt={card.name} className="aspect-[0.716] w-full object-cover" /> : <div className="flex aspect-[0.716] items-center justify-center p-6 text-center text-sm text-muted-foreground">Artwork unavailable</div>}
                    </div>
                    <div className="min-w-0 px-2 text-center md:px-0 md:text-left">
                      <h2 className="text-balance font-display text-2xl font-semibold md:text-3xl">{card.name}</h2>
                      <p className="mt-1 text-sm text-muted-foreground">{card.type_line}</p>
                      <div className="mt-4 flex flex-wrap justify-center gap-2 md:justify-start"><Badge variant="secondary" className="capitalize">{card.rarity}</Badge><Badge variant="outline" className="font-mono text-primary">{formatPrice(card.price)}</Badge></div>
                      {card.artist && <div className="mt-4 flex min-h-11 flex-wrap items-center justify-center gap-2 md:justify-start"><p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"><Brush className="size-4 shrink-0" /> Illustrated by <strong className="truncate font-semibold text-foreground">{card.artist}</strong></p><Button type="button" size="sm" variant={card.artistFollowed ? "secondary" : "outline"} className="min-h-11 shrink-0" aria-pressed={card.artistFollowed} disabled={followArtist.isPending && followArtist.variables?.artist === card.artist} onClick={() => followArtist.mutate({ artist: card.artist!, following: !card.artistFollowed, printing: { cardName: card.name, scryfallId: card.scryfallId || "", imageUri: card.image_uri, setName: card.set_name || "" } })}>{followArtist.isPending && followArtist.variables?.artist === card.artist ? <LoaderCircle className="animate-spin" /> : card.artistFollowed ? <UserCheck /> : <UserPlus />}{card.artistFollowed ? "Following" : "Follow"}</Button></div>}
                      <p className="mx-auto mt-4 line-clamp-5 max-w-xl whitespace-pre-line text-sm leading-relaxed text-muted-foreground md:mx-0">{card.oracle_text || "No Oracle text available."}</p>
                      <div className="mt-5 flex flex-col gap-2 sm:flex-row md:justify-start"><Button type="button" variant="secondary" className="sm:flex-1" onClick={() => setSelectedCard(card)}>Card details</Button><div className="sm:flex-1">{addButton(card, true)}</div></div>
                    </div>
                  </article>
                )}
              </SinglesCarousel>
            ) : (
              <div className={cn("mt-4 grid", view === "list" ? "grid-cols-1 gap-2 lg:grid-cols-2" : view === "compact" ? "grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6" : "grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5")}>
                {(results.data?.cards ?? []).map((card) => {
                  const quantity = cardQuantities.get(card.name.toLowerCase()) ?? 0
                  if (view === "list") return <article key={`${card.name}-${card.scryfallId}`} className="flex min-h-28 overflow-hidden rounded-xl border border-border bg-card/90"><button type="button" className="w-24 shrink-0 sm:w-28" onClick={() => setSelectedCard(card)} aria-label={`View ${card.name} details`}>{card.image_uri ? <img src={card.image_uri} alt="" loading="lazy" className="h-full w-full object-cover object-top" /> : <span className="flex h-full items-center justify-center p-2 text-xs text-muted-foreground">No image</span>}</button><div className="flex min-w-0 flex-1 flex-col p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{card.name}</h2><p className="truncate text-xs text-muted-foreground">{card.type_line}</p>{card.artistFollowed && <p className="mt-1 flex items-center gap-1 truncate text-xs font-medium text-primary"><Brush className="size-3 shrink-0" /> Art by {card.artist}</p>}</div><span className="shrink-0 font-mono text-xs text-brass-bright">{formatPrice(card.price)}</span></div><p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{card.oracle_text || "No Oracle text."}</p><div className="mt-auto flex items-center justify-between pt-2"><button type="button" className="min-h-11 text-xs font-medium text-primary hover:underline" onClick={() => setSelectedCard(card)}>Card details</button><div className="flex items-center gap-2">{quantity > 0 && <span className="text-xs text-muted-foreground">{quantity} in deck</span>}{addButton(card)}</div></div></div></article>
                  return <figure key={`${card.name}-${card.scryfallId}`} className="group relative min-w-0 overflow-hidden rounded-xl border border-border bg-card/90 transition-colors hover:border-primary/45">{card.artistFollowed && <span className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-[0.65rem] font-semibold text-primary"><Brush className="size-3 shrink-0" /><span className="truncate">{card.artist}</span></span>}<button type="button" className="block w-full" onClick={() => setSelectedCard(card)} aria-label={`View ${card.name} details`}>{card.image_uri ? <img src={card.image_uri} alt={card.name} loading="lazy" className="aspect-[0.716] w-full object-cover" /> : <span className="flex aspect-[0.716] items-center justify-center p-3 text-center text-xs text-muted-foreground">{card.name}</span>}</button><figcaption className="flex min-h-[68px] items-center justify-between gap-1 p-2"><div className="min-w-0"><p className="line-clamp-2 text-xs font-semibold leading-tight">{card.name}</p><p className="mt-1 font-mono text-[0.7rem] text-brass-bright">{formatPrice(card.price)}</p></div>{addButton(card)}</figcaption></figure>
                })}
              </div>
            )}

            {(results.data?.cards ?? []).length > 0 && totalPages > 1 && <div className="mt-6 flex items-center justify-between border-t border-border pt-4"><p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>{paginationControls("bottom")}</div>}
          </>
        )}

        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
          <SheetContent className="w-[min(94vw,430px)]">
            <SheetHeader><SheetTitle>Search filters</SheetTitle><SheetDescription>Build a precise query without memorizing Scryfall syntax.</SheetDescription></SheetHeader>
            <div className="space-y-5 overflow-y-auto px-4 pb-6">
              <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label>Format legality</Label><Select value={draftFilters.format} onValueChange={(value) => setDraftFilters((current) => ({ ...current, format: value }))}><SelectTrigger className="w-full" aria-label="Format legality"><SelectValue /></SelectTrigger><SelectContent>{["any","commander","brawl","standard","pioneer","modern","legacy","vintage","pauper"].map((value) => <SelectItem key={value} value={value} className="capitalize">{value === "any" ? "Any format" : value}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>Card type</Label><Select value={draftFilters.type} onValueChange={(value) => setDraftFilters((current) => ({ ...current, type: value }))}><SelectTrigger className="w-full" aria-label="Card type"><SelectValue /></SelectTrigger><SelectContent>{["any","creature","instant","sorcery","artifact","enchantment","planeswalker","land"].map((value) => <SelectItem key={value} value={value} className="capitalize">{value === "any" ? "Any type" : value}</SelectItem>)}</SelectContent></Select></div></div>
              <div className="space-y-2"><Label>Rarity</Label><Select value={draftFilters.rarity} onValueChange={(value) => setDraftFilters((current) => ({ ...current, rarity: value }))}><SelectTrigger className="w-full" aria-label="Rarity"><SelectValue /></SelectTrigger><SelectContent>{["any","common","uncommon","rare","mythic"].map((value) => <SelectItem key={value} value={value} className="capitalize">{value === "any" ? "Any rarity" : value}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-3"><div className="flex items-center justify-between gap-3"><Label>Color identity</Label><Select value={draftFilters.identityMode} onValueChange={(value: FiltersState["identityMode"]) => setDraftFilters((current) => ({ ...current, identityMode: value }))}><SelectTrigger className="w-32" aria-label="Color identity match"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exact">Exactly</SelectItem><SelectItem value="at-most">At most</SelectItem><SelectItem value="includes">Includes</SelectItem></SelectContent></Select></div><div className="flex flex-wrap gap-2">{COLOR_OPTIONS.map((color) => <button key={color.value} type="button" aria-label={`${color.value} color`} aria-pressed={draftFilters.colors.includes(color.value)} onClick={() => setDraftFilters((current) => ({ ...current, colors: current.colors.includes(color.value) ? current.colors.filter((item) => item !== color.value) : [...current.colors, color.value] }))} className={cn("size-11 rounded-full font-bold ring-offset-2 ring-offset-background", color.className, draftFilters.colors.includes(color.value) && "ring-2 ring-primary")}>{color.value}</button>)}</div></div>
              <div className="space-y-2"><Label>Mana value</Label><div className="grid grid-cols-2 gap-2"><Input inputMode="numeric" placeholder="Minimum" value={draftFilters.manaMin} onChange={(event) => setDraftFilters((current) => ({ ...current, manaMin: event.target.value.replace(/[^0-9.]/g, "") }))} aria-label="Minimum mana value" /><Input inputMode="numeric" placeholder="Maximum" value={draftFilters.manaMax} onChange={(event) => setDraftFilters((current) => ({ ...current, manaMax: event.target.value.replace(/[^0-9.]/g, "") }))} aria-label="Maximum mana value" /></div></div>
              <div className="space-y-2"><Label htmlFor="price-max">Maximum price (USD)</Label><Input id="price-max" inputMode="decimal" placeholder="No maximum" value={draftFilters.priceMax} onChange={(event) => setDraftFilters((current) => ({ ...current, priceMax: event.target.value.replace(/[^0-9.]/g, "") }))} /></div>
              <div className="flex gap-2 pt-2"><Button className="flex-1" onClick={() => { setFilters(draftFilters); runSearch(input, draftFilters); setFiltersOpen(false) }}>Apply filters</Button><Button variant="secondary" onClick={() => setDraftFilters(EMPTY_FILTERS)}>Reset</Button></div>
            </div>
          </SheetContent>
        </Sheet>

        <Dialog open={Boolean(selectedCard)} onOpenChange={(open) => !open && setSelectedCard(null)}>
          <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader><DialogTitle>{selectedCard?.name}</DialogTitle><DialogDescription>{cardDetails.data?.type_line || selectedCard?.type_line}</DialogDescription></DialogHeader>
            {detailCard && <div className="grid gap-5 sm:grid-cols-[240px_1fr]">
              <img src={detailCard.image_uri} alt={detailCard.name} className="mx-auto w-full max-w-[280px] rounded-xl" />
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2 text-xs"><Badge variant="secondary" className="capitalize">{detailCard.rarity}</Badge><Badge variant="secondary">Mana value {detailCard.cmc}</Badge><Badge variant="outline" className="font-mono text-primary">{formatPrice(detailCard.price)}</Badge></div>
                <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{cardDetails.data?.oracle_text || detailCard.oracle_text || "No Oracle text available."}</p>
                {cardDetails.data?.legalities && <div className="mt-4"><p className="mb-2 text-xs font-semibold text-muted-foreground">Legal in</p><div className="flex flex-wrap gap-1.5">{Object.entries(cardDetails.data.legalities).filter(([, status]) => status === "legal" || status === "restricted").slice(0, 8).map(([format]) => <Badge key={format} variant="outline" className="capitalize">{format.replaceAll("_", " ")}</Badge>)}</div></div>}
                <div className="mt-5 space-y-2"><Label>Printing</Label><Select value={selectedVersion?.id || selectedVersionId} onValueChange={setSelectedVersionId} disabled={versions.isPending || !(versions.data?.length)}><SelectTrigger className="w-full" aria-label="Card printing"><SelectValue placeholder={versions.isPending ? "Loading printings…" : "Choose printing"} /></SelectTrigger><SelectContent>{(versions.data ?? []).map((version) => <SelectItem key={version.id} value={version.id}>{version.set} · #{version.collector_number} · {version.set_name} · {formatPrice(version.price)}</SelectItem>)}</SelectContent></Select></div>
                {selectedVersion?.prices && <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-secondary/70 p-3 text-center"><div><dt className="text-[0.68rem] text-muted-foreground">Normal</dt><dd className="mt-1 font-mono text-xs">{formatPrice(selectedVersion.prices.normal)}</dd></div><div><dt className="text-[0.68rem] text-muted-foreground">Foil</dt><dd className="mt-1 font-mono text-xs">{formatPrice(selectedVersion.prices.foil)}</dd></div><div><dt className="text-[0.68rem] text-muted-foreground">Etched</dt><dd className="mt-1 font-mono text-xs">{formatPrice(selectedVersion.prices.etched)}</dd></div></dl>}
                {selectedVersion?.artist && selectedVersion.artist !== "Unknown illustrator" && <div className="mt-3 flex min-h-12 items-center justify-between gap-3 border-y border-border py-2"><div className="min-w-0"><p className="text-[0.68rem] text-muted-foreground">Illustrated by</p><p className="truncate text-sm font-semibold">{selectedVersion.artist}</p></div><Button type="button" size="sm" variant={selectedVersion.artistFollowed ? "secondary" : "outline"} className="shrink-0" aria-pressed={selectedVersion.artistFollowed} disabled={followArtist.isPending} onClick={() => followArtist.mutate({ artist: selectedVersion.artist, following: !selectedVersion.artistFollowed, printing: { cardName: selectedVersion.name, scryfallId: selectedVersion.id, imageUri: selectedVersion.image_uri, setName: selectedVersion.set_name } })}>{followArtist.isPending ? <LoaderCircle className="animate-spin" /> : selectedVersion.artistFollowed ? <UserCheck /> : <UserPlus />}{selectedVersion.artistFollowed ? "Following" : "Follow"}</Button></div>}
                <section className="mt-5 min-w-0" aria-labelledby="art-gallery-title">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <h3 id="art-gallery-title" className="text-sm font-semibold">Rate the artwork</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">Pick the printings you would—or would not—play.</p>
                    </div>
                    {!!versions.data?.length && <span className="shrink-0 font-mono text-[0.68rem] text-muted-foreground">{versions.data.length} versions</span>}
                  </div>
                  {versions.isPending ? (
                    <div className="mt-3 flex gap-3 overflow-hidden" aria-label="Loading artwork versions">
                      {[0, 1, 2].map((item) => <Skeleton key={item} className="h-56 w-32 shrink-0 rounded-xl" />)}
                    </div>
                  ) : (
                    <>
                      <div className="scrollbar-thin mt-3 flex snap-x gap-3 overflow-x-auto pb-2">
                        {(versions.data ?? []).slice(0, visibleVersionCount).map((version) => {
                          const isSelected = version.id === selectedVersion?.id
                          const votePending = voteForArt.isPending && voteForArt.variables?.version.id === version.id
                          return (
                            <article key={version.id} className={cn("w-32 shrink-0 snap-start overflow-hidden rounded-xl border bg-card/85 transition-colors", isSelected ? "border-primary ring-1 ring-primary/35" : "border-border hover:border-primary/45")}>
                              <button type="button" className="block w-full text-left" onClick={() => setSelectedVersionId(version.id)} aria-label={`Select ${version.set_name} artwork`} aria-pressed={isSelected}>
                                {version.image_uri ? <img src={version.image_uri} alt={`${version.name}, ${version.set_name} printing`} loading="lazy" className="aspect-[0.716] w-full object-cover" /> : <span className="flex aspect-[0.716] items-center justify-center p-3 text-center text-xs text-muted-foreground">Artwork unavailable</span>}
                                <span className="block min-w-0 border-t border-border px-2.5 py-2">
                                  <span className="flex items-center justify-between gap-1"><span className="block truncate text-xs font-semibold">{version.set}</span>{version.artistFollowed && <UserCheck className="size-3.5 shrink-0 text-primary" aria-label="Followed illustrator" />}</span>
                                  <span className={cn("mt-0.5 block truncate text-[0.65rem]", version.artistFollowed ? "font-medium text-primary" : "text-muted-foreground")}>{version.artist}</span>
                                  <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-muted-foreground">#{version.collector_number} · {formatPrice(version.price)}</span>
                                </span>
                              </button>
                              <div className="grid grid-cols-2 border-t border-border">
                                <button
                                  type="button"
                                  className={cn("flex min-h-11 items-center justify-center gap-1.5 border-r border-border text-xs transition-colors hover:bg-primary/10 hover:text-primary", version.userVote === 1 ? "bg-primary/15 text-primary" : "text-muted-foreground")}
                                  aria-label={`${version.userVote === 1 ? "Remove like from" : "Like"} ${version.set_name} artwork. ${version.likes} ${version.likes === 1 ? "like" : "likes"}`}
                                  aria-pressed={version.userVote === 1}
                                  disabled={votePending}
                                  onClick={() => selectedCard && voteForArt.mutate({ version, vote: version.userVote === 1 ? 0 : 1, cardName: selectedCard.name })}
                                >
                                  {votePending ? <LoaderCircle className="size-3.5 animate-spin" /> : <ThumbsUp className="size-3.5" />}
                                  <span>{version.likes}</span>
                                </button>
                                <button
                                  type="button"
                                  className={cn("flex min-h-11 items-center justify-center gap-1.5 text-xs transition-colors hover:bg-destructive/10 hover:text-destructive", version.userVote === -1 ? "bg-destructive/15 text-destructive" : "text-muted-foreground")}
                                  aria-label={`${version.userVote === -1 ? "Remove dislike from" : "Dislike"} ${version.set_name} artwork. ${version.dislikes} ${version.dislikes === 1 ? "dislike" : "dislikes"}`}
                                  aria-pressed={version.userVote === -1}
                                  disabled={votePending}
                                  onClick={() => selectedCard && voteForArt.mutate({ version, vote: version.userVote === -1 ? 0 : -1, cardName: selectedCard.name })}
                                >
                                  {votePending ? <LoaderCircle className="size-3.5 animate-spin" /> : <ThumbsDown className="size-3.5" />}
                                  <span>{version.dislikes}</span>
                                </button>
                              </div>
                            </article>
                          )
                        })}
                      </div>
                      {(versions.data?.length ?? 0) > visibleVersionCount && <Button type="button" variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setVisibleVersionCount((current) => current + 12)}>Show 12 more artworks</Button>}
                    </>
                  )}
                </section>
                <div className="mt-5 space-y-2">{(decks.data?.length ?? 0) > 0 ? <><Select value={targetDeck} onValueChange={setTargetDeck}><SelectTrigger className="w-full" aria-label="Add card to deck"><SelectValue placeholder="Choose target deck…" /></SelectTrigger><SelectContent>{(decks.data ?? []).map((deck) => <SelectItem key={deck.id} value={deck.id}>{deck.deck_name}</SelectItem>)}</SelectContent></Select>{addButton(detailCard, true)}</> : <Button variant="secondary" asChild className="w-full"><Link to="/builder/new"><Plus /> Create a deck first</Link></Button>}</div>
              </div>
            </div>}
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
