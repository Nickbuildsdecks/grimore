import { forwardRef, type ReactNode, type SVGProps } from "react"
import { cn } from "@/lib/utils"

/* ── Grimore Icons ──────────────────────────────────────────────────────
   The 21st-century wizard's cookbook set: cauldrons, phials, sprigs, and
   sigils drawn as modern stroke icons.

   Lucide-compatible contract: 24×24 grid with ~2px padding, fill="none",
   stroke="currentColor", round caps/joins, default strokeWidth 1.75.
   Style with Tailwind exactly like lucide:
     <Cauldron className="h-5 w-5 text-brass" strokeWidth={2} />

   Extras beyond lucide:
   - animated          → parts loop forever (active nav tab, hero moments)
   - animated="hover"  → parts animate while the icon, its parent link or
                         button, or a Tailwind .group ancestor is hovered
   - two-tone accent   → sparks/bubbles carry the `gi-accent` class; give
                         any ancestor `gi-accent-arcane` / `gi-accent-brass`
                         (defined in index.css) to tint them separately.   */

export interface GrimoreIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
  /** true = loop forever; "hover" = animate on hover (self, parent link/button, or .group) */
  animated?: boolean | "hover"
}

function createIcon(displayName: string, children: ReactNode) {
  const Icon = forwardRef<SVGSVGElement, GrimoreIconProps>(
    ({ size = 24, strokeWidth = 1.75, animated, className, ...props }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={props["aria-label"] ? undefined : true}
        className={cn(
          "gi",
          animated === true && "gi-animate",
          animated === "hover" && "gi-hover",
          className
        )}
        {...props}
      >
        {children}
      </svg>
    )
  )
  Icon.displayName = displayName
  return Icon
}

/* The signature accent: a small four-point spark, reused across the set */
const spark = (x: number, y: number, r = 1.6, cls = "gi-spark gi-accent") => (
  <path
    className={cls}
    d={`M${x} ${y - r}c.35 ${r * 0.55} ${r * 0.45} ${r * 0.65} ${r} ${r}c-${r * 0.55} .35-${r * 0.65} ${r * 0.45}-${r} ${r}c-.35-${r * 0.55}-${r * 0.45}-${r * 0.65}-${r}-${r}c${r * 0.55}-.35 ${r * 0.65}-${r * 0.45} ${r}-${r}z`}
  />
)

/* ── The brew ─────────────────────────────────────────────────────────── */

/** Bubbling league pot. Events, communal brews. */
export const Cauldron = createIcon(
  "Cauldron",
  <>
    <path d="M4.5 9.5h15" />
    <path d="M6 9.5c-.4 5.6 2 9.5 6 9.5s6.4-3.9 6-9.5" />
    <path d="M7.5 18.2 5.5 21M16.5 18.2l2 2.8" />
    <circle className="gi-bubble gi-accent" cx="10" cy="5.5" r="1.1" />
    <circle className="gi-bubble gi-bubble-2 gi-accent" cx="14" cy="3.6" r="1.5" />
    <circle className="gi-bubble gi-bubble-3 gi-accent" cx="13" cy="7" r=".6" />
  </>
)

/** Health potion. Life tracker. */
export const PotionFlask = createIcon(
  "PotionFlask",
  <>
    <path d="M9.5 3h5" />
    <path d="M10.5 3v4.2L5.8 16.6A3 3 0 0 0 8.5 21h7a3 3 0 0 0 2.7-4.4L13.5 7.2V3" />
    <path className="gi-liquid" d="M7.3 14.5h9.4" />
    <circle className="gi-bubble gi-accent" cx="12" cy="17.4" r="1" />
  </>
)

/** Open recipe tome. Decks, the grimoire itself. */
export const Spellbook = createIcon(
  "Spellbook",
  <>
    <path d="M12 7.2C10 5.6 7.4 5.1 4 5.3v13.5c3.4-.2 6 .3 8 1.9 2-1.6 4.6-2.1 8-1.9V5.3c-3.4-.2-6 .3-8 1.9z" />
    <path d="M12 7.2v13.5" />
    {spark(12, 2.9, 1.4)}
  </>
)

/** Sparking wand. Actions, magic-doing, the builder. */
export const Wand = createIcon(
  "Wand",
  <>
    <path className="gi-wand" d="M4 20 14.5 9.5" />
    {spark(17.5, 6.5, 2.6)}
    <path className="gi-glint" d="M20.5 12.5v.01M12.5 4.5v.01M21 3l-.9.9" />
  </>
)

/** Scrying orb on its stand. Discover. */
export const CrystalBall = createIcon(
  "CrystalBall",
  <>
    <circle className="gi-orb" cx="12" cy="10" r="6.5" />
    <path className="gi-glint" d="M8.6 8.4a4 4 0 0 1 2.3-1.7" />
    <path d="M7.5 20.5h9" />
    <path d="M9 20.5c-.6-1.3-1.5-2.2-2.4-2.7M15 20.5c.6-1.3 1.5-2.2 2.4-2.7" />
  </>
)

/** The cook's ladle, mid-stir. */
export const Ladle = createIcon(
  "Ladle",
  <>
    <g className="gi-stir">
      <path d="M15.5 12.5V6a2.75 2.75 0 0 1 5.5 0v.8" />
      <path d="M4 12.5h11.5v1.2a5.75 5.75 0 0 1-11.5 0z" />
    </g>
    {spark(7.5, 7.5, 1.5)}
  </>
)

/** Mortar and pestle. Crafting, tuning, deck surgery. */
export const MortarPestle = createIcon(
  "MortarPestle",
  <>
    <path d="M4 12.5h16v.8c0 4-3.6 7.2-8 7.2s-8-3.2-8-7.2z" />
    <path className="gi-pestle" d="m10 11.5 6.2-7.1a1.9 1.9 0 0 1 2.9 2.5l-5.4 6.1" />
  </>
)

/** Recipe scroll. Decklists, rules text. */
export const Scroll = createIcon(
  "Scroll",
  <>
    <path d="M17.5 3H8a2 2 0 0 0-2 2v14a2 2 0 0 1-2 2h11.5a2 2 0 0 0 2-2V5a2 2 0 0 1 2-2 2 2 0 0 1 2 2v1.5h-4" />
    <path d="M4 21a2 2 0 0 1-2-2v-1.5h4" />
    <path className="gi-lines" d="M10 8.5h4.5M10 12h4.5M10 15.5h2.5" />
  </>
)

/** Candle with living flame. Late-night brewing sessions. */
export const CandleFlame = createIcon(
  "CandleFlame",
  <>
    <path d="M8.5 11.5h7V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1z" />
    <path className="gi-flame gi-accent" d="M12 8.6c2-1.4 2.2-3.4 0-5.8-2.2 2.4-2 4.4 0 5.8z" />
    <path d="M8.5 14.5c1 .8 2 .2 2 1.6" />
  </>
)

/** Fresh sprig for the pot. Growth, ramp, green things. */
export const HerbSprig = createIcon(
  "HerbSprig",
  <>
    <g className="gi-sway">
      <path d="M12 21V7.5" />
      <path d="M12 16.5c-3.2 0-5.3-1.6-5.6-4.3 3.2 0 5.3 1.6 5.6 4.3z" />
      <path d="M12 12.5c3.2 0 5.3-1.6 5.6-4.3-3.2 0-5.3 1.6-5.6 4.3z" />
      <path d="M12 7.5c-1.6-1.2-1.6-3.3 0-4.5 1.6 1.2 1.6 3.3 0 4.5z" />
    </g>
  </>
)

/** Standing stone with a cut rune. History, permanence. */
export const RuneStone = createIcon(
  "RuneStone",
  <>
    <path d="M8.5 21 7 7.2A2.4 2.4 0 0 1 9.4 4.6h5.2A2.4 2.4 0 0 1 17 7.2L15.5 21z" />
    <path className="gi-rune gi-accent" d="M11 8.5v8M11 10l3.2-1.6M11 13.6l3.2-1.6" />
  </>
)

/** Stoppered ingredient jar. Collections, the binder pantry. */
export const SpiceJar = createIcon(
  "SpiceJar",
  <>
    <path d="M8 8.5h8V19a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z" />
    <path d="M9 8.5v-2A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5v2" />
    <path className="gi-lines" d="M8 13.5h8" />
    <path className="gi-glint" d="M10.5 17h.01M12.8 16h.01M11.6 18.2h.01" />
  </>
)

/** Summoning ring. Discover, ritual, the brand's sigil. */
export const SigilCircle = createIcon(
  "SigilCircle",
  <>
    <circle className="gi-ring" cx="12" cy="12" r="8.5" strokeDasharray="4.4 3.2" />
    <path className="gi-gem gi-accent" d="m12 8.2 2.9 3.8-2.9 3.8-2.9-3.8z" />
    <path d="M12 12v.01" />
  </>
)

/** Crescent with attendant stars. Night mode, rest, phases. */
export const MoonPhase = createIcon(
  "MoonPhase",
  <>
    <path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z" />
    {spark(18.5, 5.5, 1.5)}
    <path className="gi-glint" d="M14.5 2.8v.01" />
  </>
)

/** The scrying eye. Search, inspection, oracle text. */
export const ScryingEye = createIcon(
  "ScryingEye",
  <>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle className="gi-pupil" cx="12" cy="12" r="2.6" />
    <path className="gi-glint" d="M13 10.8v.01" />
  </>
)

/** Loose mana spark. Sparkle accents, highlights, arcana. */
export const ManaSpark = createIcon(
  "ManaSpark",
  <>
    <path className="gi-spark" d="M12 4.5c.7 2.9 2 4.2 5 5-3 .8-4.3 2.1-5 5-.7-2.9-2-4.2-5-5 3-.8 4.3-2.1 5-5z" />
    {spark(18.6, 16.6, 1.9)}
    <path className="gi-glint" d="M6 18.5v.01" />
  </>
)

/** Brewing timer. Waiting on the pot, turn timers. */
export const BrewHourglass = createIcon(
  "BrewHourglass",
  <>
    <path d="M6.5 3h11M6.5 21h11" />
    <path d="M8 3v2.8c0 2.2 1.6 3.6 4 6.2-2.4 2.6-4 4-4 6.2V21" />
    <path d="M16 3v2.8c0 2.2-1.6 3.6-4 6.2 2.4 2.6 4 4 4 6.2V21" />
    <path className="gi-sand gi-accent" d="M10.2 17.5c.6-1 1-1.5 1.8-2.2.8.7 1.2 1.2 1.8 2.2z" />
  </>
)

/** Magnifier with a spark in the lens: familiar search, arcane twist. */
export const SpellSearch = createIcon(
  "SpellSearch",
  <>
    <circle cx="10.8" cy="10.8" r="6.8" />
    <path d="m20.5 20.5-4.9-4.9" />
    {spark(10.8, 10.8, 2.1)}
  </>
)

export const GRIMORE_ICONS = {
  Cauldron,
  PotionFlask,
  Spellbook,
  Wand,
  CrystalBall,
  Ladle,
  MortarPestle,
  Scroll,
  CandleFlame,
  HerbSprig,
  RuneStone,
  SpiceJar,
  SigilCircle,
  MoonPhase,
  ScryingEye,
  ManaSpark,
  BrewHourglass,
  SpellSearch,
} as const

export type GrimoreIconName = keyof typeof GRIMORE_ICONS
