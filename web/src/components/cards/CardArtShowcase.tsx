import { ArrowRight, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { showcaseImage, type ShowcaseCard } from "@/hooks/useShowcaseCards"

export function CardArtFan({ cards, className }: { cards: ShowcaseCard[]; className?: string }) {
  const visible = cards.slice(0, 3)
  if (visible.length === 0) return <CardArtFanSkeleton className={className} />

  return (
    <div className={cn("card-art-fan" , className)} aria-label="Featured Magic card artwork">
      {visible.map((card, index) => (
        <figure key={`${card.name}-${card.scryfallId ?? index}`} className="card-art-fan-item" data-position={index}>
          <img src={showcaseImage(card)} alt={card.name} loading="lazy" />
          <figcaption>{card.name}</figcaption>
        </figure>
      ))}
      <div className="card-art-fan-glow" aria-hidden="true" />
    </div>
  )
}

function CardArtFanSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("card-art-fan", className)} aria-hidden="true">
      {[0, 1, 2].map((index) => <Skeleton key={index} className="card-art-fan-item aspect-[0.716]" data-position={index} />)}
    </div>
  )
}

interface CardArtRailProps {
  cards: ShowcaseCard[]
  title: string
  description?: string
  isFallback?: boolean
  isPending?: boolean
  onSelect?: (card: ShowcaseCard) => void
  actionLabel?: string
  className?: string
}

export function CardArtRail({
  cards,
  title,
  description,
  isFallback,
  isPending,
  onSelect,
  actionLabel = "View card",
  className,
}: CardArtRailProps) {
  return (
    <section className={cn("art-rail", className)} aria-labelledby={`art-rail-${title.replace(/\W+/g, "-").toLowerCase()}`}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={`art-rail-${title.replace(/\W+/g, "-").toLowerCase()}`} className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="size-4 text-brass-bright" /> {title}
          </h2>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {isFallback && <span className="text-xs text-muted-foreground">Live from Scryfall</span>}
      </div>
      <div className="scrollbar-thin -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-3 sm:mx-0 sm:px-0">
        {isPending
          ? Array.from({ length: 6 }).map((_, index) => <div key={index} className="art-rail-card grid aspect-[0.716] place-items-center border border-border bg-card/75" aria-hidden="true"><img src="/logo.svg?v=mythic" alt="" className="size-12 animate-pulse opacity-35" /></div>)
          : cards.map((card) => {
              const image = showcaseImage(card)
              const content = (
                <>
                  <img src={image} alt={card.name} loading="lazy" className="aspect-[0.716] w-full object-cover" />
                  <span className="art-rail-card-label"><span className="truncate">{card.name}</span>{onSelect && <ArrowRight className="size-4 shrink-0" />}</span>
                </>
              )
              return onSelect ? (
                <button key={`${card.name}-${card.scryfallId}`} type="button" className="art-rail-card" onClick={() => onSelect(card)} aria-label={`${actionLabel}: ${card.name}`}>{content}</button>
              ) : (
                <article key={`${card.name}-${card.scryfallId}`} className="art-rail-card">{content}</article>
              )
            })}
      </div>
    </section>
  )
}

interface CardArtGalleryProps {
  cards: ShowcaseCard[]
  title: string
  description: string
  isFallback?: boolean
  isPending?: boolean
  onSelect: (card: ShowcaseCard) => void
}

export function CardArtGallery({ cards, title, description, isFallback, isPending, onSelect }: CardArtGalleryProps) {
  const visible = cards.slice(0, 5)
  return (
    <section className="card-art-gallery" aria-labelledby="discover-gallery-title">
      <div className="card-art-gallery-heading">
        <div>
          <h2 id="discover-gallery-title">{title}</h2>
          <p>{description}</p>
        </div>
        {isFallback && <span>Curated live from Scryfall</span>}
      </div>
      <div className="card-art-gallery-grid">
        {isPending
          ? Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="card-art-gallery-item card-art-gallery-placeholder" data-position={index} aria-hidden="true"><img src="/logo.svg?v=mythic" alt="" /></div>
            ))
          : visible.map((card, index) => (
              <button key={`${card.name}-${card.scryfallId ?? index}`} type="button" className="card-art-gallery-item" data-position={index} onClick={() => onSelect(card)}>
                <img src={showcaseArtCrop(card)} alt="" loading="lazy" />
                <span><strong>{card.name}</strong>{card.artist && <small>Art by {card.artist}</small>}<ArrowRight /></span>
              </button>
            ))}
      </div>
    </section>
  )
}

interface BinderPreviewProps {
  cards: ShowcaseCard[]
  isPending?: boolean
}

export function BinderPreview({ cards, isPending }: BinderPreviewProps) {
  const visible = cards.slice(0, 6)
  return (
    <div className="binder-preview" aria-label="Preview of a six-pocket Magic card binder page">
      <div className="binder-preview-spine" aria-hidden="true">{[0, 1, 2, 3].map((index) => <i key={index} />)}</div>
      <div className="binder-preview-page">
        {isPending
          ? Array.from({ length: 6 }).map((_, index) => <div key={index} className="binder-pocket"><img src="/logo.svg?v=mythic" alt="" className="binder-pocket-logo" /></div>)
          : visible.map((card, index) => <div key={`${card.name}-${card.scryfallId ?? index}`} className="binder-pocket"><img src={showcaseImage(card)} alt={card.name} loading="lazy" /></div>)}
      </div>
    </div>
  )
}

export function CardArtAtmosphere({ cards, className }: { cards: ShowcaseCard[]; className?: string }) {
  const visible = cards.filter((card) => showcaseImage(card)).slice(0, 3)
  if (visible.length === 0) return null
  return (
    <div className={cn("card-art-atmosphere", className)} aria-hidden="true">
      {visible.map((card, index) => (
        <div key={`${card.name}-${index}`} className="card-art-atmosphere-layer" data-position={index} style={{ backgroundImage: `url("${showcaseArtCrop(card).replaceAll('"', '\\"')}")` }} />
      ))}
    </div>
  )
}

function showcaseArtCrop(card: ShowcaseCard) {
  return showcaseImage(card).replace("/normal/", "/art_crop/").replace("/small/", "/art_crop/")
}
