/**
 * One card at the table.
 *
 * Deliberately legible with **no artwork**. This environment cannot reach Scryfall and a fresh
 * Grimore database has no card images, so a face that depended on one would render as an empty
 * rectangle and the game would be unplayable. Name, cost, type line, power/toughness and oracle
 * text are all drawn from the card data, and an image is layered on only when the server actually
 * sent a URL.
 *
 * A card with no `card` on it is one this seat may not identify — the opponent's hand, a face-down
 * permanent — and renders as a back. That is not a UI choice: the identity is genuinely absent from
 * the payload, so there is nothing to draw even if the component wanted to.
 */
import { cn } from "@/lib/utils"
import type { VisibleCard } from "@grimore/rules-engine"

const MANA_VAR: Record<string, string> = {
  W: "var(--g-mana-w)",
  U: "var(--g-mana-u)",
  B: "var(--g-mana-b)",
  R: "var(--g-mana-r)",
  G: "var(--g-mana-g)",
}

/** The card's frame colour: its single colour, gold for multicolour, grey for colourless. */
function frameColor(colors: readonly string[] | undefined): string {
  if (!colors || colors.length === 0) return "var(--g-mana-c)"
  if (colors.length > 1) return "var(--g-mana-multi)"
  return MANA_VAR[colors[0]!] ?? "var(--g-mana-c)"
}

export type CardSize = "hand" | "board" | "pile" | "large"

const SIZES: Record<CardSize, string> = {
  // Width only: the aspect ratio holds the height, so one card never grows taller than its row.
  hand: "w-[88px] sm:w-[104px]",
  board: "w-[72px] sm:w-[92px]",
  pile: "w-[56px] sm:w-[68px]",
  large: "w-[210px]",
}

/**
 * The space a card takes up in a row, which is not the same as the card.
 *
 * A tapped card is rotated a quarter turn, and a CSS transform does not change the box the layout
 * engine reserved — so a rotated card sticks out of its own slot by a third of its height on each
 * side, overlapping whatever is next to it and being clipped by the row. The fix is a wrapper that
 * is the right shape for the orientation, with the card centred inside it: portrait normally,
 * landscape when tapped. The numbers are the same widths, with the 2.5:3.5 ratio applied.
 */
const SLOT: Record<CardSize, string> = {
  hand: "w-[88px] h-[123px] sm:w-[104px] sm:h-[146px]",
  board: "w-[72px] h-[101px] sm:w-[92px] sm:h-[129px]",
  pile: "w-[56px] h-[78px] sm:w-[68px] sm:h-[95px]",
  large: "w-[210px] h-[294px]",
}
const TAPPED_SLOT: Record<CardSize, string> = {
  hand: "w-[123px] h-[88px] sm:w-[146px] sm:h-[104px]",
  board: "w-[101px] h-[72px] sm:w-[129px] sm:h-[92px]",
  pile: "w-[78px] h-[56px] sm:w-[95px] sm:h-[68px]",
  large: "w-[294px] h-[210px]",
}

/**
 * Why the card is lit up. `target` is a legal choice waiting to be picked; the combat ones mark a
 * creature already in the fight. Kept separate from `selected`, which means "you picked this".
 */
export type CardHighlight = "target" | "attacking" | "blocking"

const HIGHLIGHT_RING: Record<CardHighlight, string> = {
  target: "border-[var(--g-status-info)] ring-2 ring-[var(--g-status-info)]",
  attacking: "border-[var(--g-mana-r)] ring-2 ring-[var(--g-mana-r)]",
  blocking: "border-[var(--g-mana-u)] ring-2 ring-[var(--g-mana-u)]",
}

export interface CardFaceProps {
  card: VisibleCard
  size?: CardSize
  onSelect?: (card: VisibleCard) => void
  /** Marks the card as chosen, for the attach flow where a second card has to be picked. */
  selected?: boolean
  /** Why it is lit: a legal target, an attacker, a blocker. */
  highlight?: CardHighlight | null
  /**
   * Short strings along the bottom — marked damage, "can't attack", "not ready".
   *
   * Passed in rather than worked out here because what is worth saying depends on the step, which
   * is a fact about the game and not about one card. See `cardBadges` in `lib/arena.ts`.
   */
  badges?: readonly string[]
  className?: string
}

export function CardFace({ card, size = "board", onSelect, selected, highlight, badges, className }: CardFaceProps) {
  const def = card.card
  const hidden = def === undefined
  const counters = Object.entries(card.counters).filter(([, n]) => n !== 0)
  const label = hidden ? "Face-down card" : def.name
  /**
   * The engine's current power and toughness, not the printed ones.
   *
   * A creature with a +1/+1 counter, an anthem or an until-end-of-turn pump genuinely is a
   * different size, and the server sends what it computed. Drawing the printed numbers would show
   * a 2/2 the engine is treating as a 5/5, which is the kind of disagreement that loses a game.
   */
  const body = card.power !== undefined && card.toughness !== undefined
    ? { power: String(card.power), toughness: String(card.toughness), computed: true }
    : def?.power !== undefined && def.toughness !== undefined
      ? { power: def.power, toughness: def.toughness, computed: false }
      : null

  return (
    <span
      data-testid={`slot-${card.id}`}
      className={cn("relative block shrink-0", card.tapped ? TAPPED_SLOT[size] : SLOT[size])}
    >
    <button
      type="button"
      data-testid={`card-${card.id}`}
      data-card-name={hidden ? "" : def.name}
      data-tapped={card.tapped ? "true" : "false"}
      data-hidden={hidden ? "true" : "false"}
      aria-label={label}
      title={hidden ? "Face down" : `${def.name} — ${def.typeLine}`}
      onClick={onSelect ? () => onSelect(card) : undefined}
      disabled={!onSelect}
      className={cn(
        "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
        "aspect-[2.5/3.5] rounded-[6px] border text-left transition-transform",
        "overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        SIZES[size],
        onSelect && "cursor-pointer",
        // Tapped cards lie on their side, as they do on a table. The wrapper above is already the
        // landscape shape, so the rotation happens inside a slot that has room for it.
        card.tapped && "rotate-90",
        selected
          ? "border-[var(--g-gold-400)] ring-2 ring-[var(--g-gold-400)]"
          : highlight
            ? HIGHLIGHT_RING[highlight]
            : "border-white/15",
        className,
      )}
      style={{ background: hidden ? undefined : `linear-gradient(160deg, ${frameColor(def.colors)} 0%, rgba(8,8,12,0.92) 58%)` }}
    >
      {hidden ? (
        <span
          className="absolute inset-0 flex items-center justify-center"
          style={{
            background:
              "repeating-linear-gradient(45deg, rgba(120,90,200,0.35) 0 6px, rgba(30,24,60,0.9) 6px 12px)",
          }}
        >
          <span className="text-[9px] font-bold uppercase tracking-widest text-white/55">Grimore</span>
        </span>
      ) : (
        <>
          {def.imageUri ? (
            <img src={def.imageUri} alt={def.name} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
          ) : null}
          <span className="relative flex h-full flex-col gap-0.5 p-1">
            <span className="flex items-start justify-between gap-1">
              <span className={cn("font-semibold leading-tight text-white", size === "large" ? "text-[12px]" : "text-[8px] sm:text-[9px]")}>
                {def.name}
              </span>
              {def.manaCost ? (
                <span className={cn("shrink-0 font-mono text-white/80", size === "large" ? "text-[11px]" : "text-[7px] sm:text-[8px]")}>
                  {def.manaCost}
                </span>
              ) : null}
            </span>
            <span className={cn("leading-tight text-white/65", size === "large" ? "text-[10px]" : "text-[6px] sm:text-[7px]")}>
              {def.typeLine}
            </span>
            {size === "large" && def.oracleText ? (
              <span className="mt-1 whitespace-pre-line text-[10px] leading-snug text-white/80">{def.oracleText}</span>
            ) : null}
            <span className="mt-auto flex items-end justify-between gap-1">
              {counters.length > 0 ? (
                <span className="flex flex-wrap gap-0.5">
                  {counters.map(([key, n]) => (
                    <span
                      key={key}
                      data-testid={`counter-${card.id}-${key}`}
                      className="rounded bg-[var(--g-gold-400)] px-1 text-[7px] font-bold text-black"
                    >
                      {key === "+1/+1" ? `+${n}/+${n}` : `${key} ${n}`}
                    </span>
                  ))}
                </span>
              ) : (
                <span />
              )}
              {body !== null ? (
                <span
                  data-testid={`body-${card.id}`}
                  className={cn(
                    "shrink-0 font-bold text-white",
                    size === "large" ? "text-[13px]" : "text-[8px] sm:text-[9px]",
                    // A body the engine changed is worth noticing, so it is gold rather than white.
                    body.computed && (body.power !== def.power || body.toughness !== def.toughness) &&
                      "text-[var(--g-gold-400)]",
                  )}
                >
                  {body.power}/{body.toughness}
                </span>
              ) : null}
            </span>
          </span>
        </>
      )}
      {card.isCommander ? (
        <span className="absolute left-0 top-0 rounded-br bg-[var(--g-gold-400)] px-1 text-[6px] font-bold uppercase text-black">
          CMD
        </span>
      ) : null}
      {card.isToken ? (
        <span className="absolute right-0 top-0 rounded-bl bg-white/20 px-1 text-[6px] font-bold uppercase text-white">
          TKN
        </span>
      ) : null}
      {card.attachedTo !== null ? (
        <span className="absolute bottom-0 left-0 rounded-tr bg-[var(--g-status-info)] px-1 text-[6px] font-bold uppercase text-black">
          ATT
        </span>
      ) : null}
      {badges !== undefined && badges.length > 0 ? (
        <span
          data-testid={`badges-${card.id}`}
          className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-0.5 bg-black/55 px-0.5 py-px"
        >
          {badges.map((text) => (
            <span key={text} className="text-[6px] font-semibold uppercase leading-tight tracking-wide text-white/90">
              {text}
            </span>
          ))}
        </span>
      ) : null}
    </button>
    </span>
  )
}
