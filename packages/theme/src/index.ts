/**
 * The Elevated Grimoire - typed token surface.
 *
 * Raw values (hex, rgb) live exclusively in `tokens.css`. This module exposes
 * the token *names* as CSS `var()` references plus the non-color scalars
 * (spacing, radii, durations) so TypeScript consumers (inline styles, canvas,
 * charts, motion libraries) can reference the design system without
 * duplicating values.
 */

const v = <N extends string>(name: N): `var(--g-${N})` => `var(--g-${name})`;

export const fonts = {
  display: v("font-display"),
  body: v("font-body"),
  mono: v("font-mono"),
} as const;

export const obsidian = {
  50: v("obsidian-50"),
  100: v("obsidian-100"),
  200: v("obsidian-200"),
  300: v("obsidian-300"),
  400: v("obsidian-400"),
  500: v("obsidian-500"),
  600: v("obsidian-600"),
  700: v("obsidian-700"),
  800: v("obsidian-800"),
  850: v("obsidian-850"),
  900: v("obsidian-900"),
  950: v("obsidian-950"),
} as const;

export const brand = {
  from: v("brand-from"),
  to: v("brand-to"),
  gradient: v("brand-gradient"),
  gradientSoft: v("brand-gradient-soft"),
  glow: v("brand-glow"),
  violet: {
    300: v("violet-300"),
    400: v("violet-400"),
    500: v("violet-500"),
    600: v("violet-600"),
    700: v("violet-700"),
  },
  magenta: {
    300: v("magenta-300"),
    400: v("magenta-400"),
    500: v("magenta-500"),
    600: v("magenta-600"),
    700: v("magenta-700"),
  },
} as const;

/** Magic: The Gathering color identity (WUBRG + colorless + multicolor). */
export const mana = {
  W: { base: v("mana-w"), deep: v("mana-w-deep") },
  U: { base: v("mana-u"), deep: v("mana-u-deep") },
  B: { base: v("mana-b"), deep: v("mana-b-deep") },
  R: { base: v("mana-r"), deep: v("mana-r-deep") },
  G: { base: v("mana-g"), deep: v("mana-g-deep") },
  C: { base: v("mana-c"), deep: v("mana-c-deep") },
  multi: v("mana-multi"),
} as const;

export type ManaColor = keyof typeof mana;

export const surface = {
  base: v("surface-base"),
  0: v("surface-0"),
  1: v("surface-1"),
  2: v("surface-2"),
  3: v("surface-3"),
  4: v("surface-4"),
  inverse: v("surface-inverse"),
} as const;

export const text = {
  primary: v("text-primary"),
  secondary: v("text-secondary"),
  muted: v("text-muted"),
  faint: v("text-faint"),
  inverse: v("text-inverse"),
  onBrand: v("text-on-brand"),
} as const;

export const border = {
  subtle: v("border-subtle"),
  default: v("border-default"),
  strong: v("border-strong"),
  brand: v("border-brand"),
  focus: v("border-focus"),
} as const;

export const accent = {
  default: v("accent"),
  hover: v("accent-hover"),
  active: v("accent-active"),
  secondary: v("accent-secondary"),
  tertiary: v("accent-tertiary"),
  info: v("accent-info"),
} as const;

export const status = {
  success: v("status-success"),
  warning: v("status-warning"),
  danger: v("status-danger"),
  info: v("status-info"),
} as const;

export const glass = {
  bg: v("glass-bg"),
  bgStrong: v("glass-bg-strong"),
  bgSubtle: v("glass-bg-subtle"),
  border: v("glass-border"),
  highlight: v("glass-highlight"),
  blur: v("glass-blur"),
  blurStrong: v("glass-blur-strong"),
  saturate: v("glass-saturate"),
} as const;

export const radius = {
  xs: "0.25rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  "2xl": "2rem",
  full: "9999px",
} as const;

export const space = {
  0: "0",
  px: "1px",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  10: "2.5rem",
  12: "3rem",
  16: "4rem",
  20: "5rem",
  24: "6rem",
  32: "8rem",
} as const;

export const elevation = {
  1: v("elevation-1"),
  2: v("elevation-2"),
  3: v("elevation-3"),
  4: v("elevation-4"),
  5: v("elevation-5"),
} as const;

export type ElevationLevel = keyof typeof elevation;

/** Durations in milliseconds, mirroring `--g-duration-*`. */
export const durationMs = {
  instant: 80,
  fast: 150,
  base: 240,
  slow: 400,
  slower: 700,
} as const;

export const duration = {
  instant: v("duration-instant"),
  fast: v("duration-fast"),
  base: v("duration-base"),
  slow: v("duration-slow"),
  slower: v("duration-slower"),
} as const;

export const easing = {
  standard: v("ease-standard"),
  enter: v("ease-enter"),
  exit: v("ease-exit"),
  spring: v("ease-spring"),
} as const;

/** Bezier control points for JS animation libraries (framer-motion, GSAP). */
export const easingCurve = {
  standard: [0.2, 0, 0, 1],
  enter: [0, 0, 0.2, 1],
  exit: [0.4, 0, 1, 1],
  spring: [0.34, 1.56, 0.64, 1],
} as const;

export const motion = {
  rise: v("motion-rise"),
  fade: v("motion-fade"),
  scaleIn: v("motion-scale-in"),
  shimmer: v("motion-shimmer"),
} as const;

export const typography = {
  size: {
    xs: v("text-xs"),
    sm: v("text-sm"),
    base: v("text-base"),
    lg: v("text-lg"),
    xl: v("text-xl"),
    "2xl": v("text-2xl"),
    "3xl": v("text-3xl"),
    "4xl": v("text-4xl"),
    "5xl": v("text-5xl"),
    "6xl": v("text-6xl"),
  },
  leading: {
    tight: v("leading-tight"),
    snug: v("leading-snug"),
    normal: v("leading-normal"),
    relaxed: v("leading-relaxed"),
  },
  tracking: {
    tight: v("tracking-tight"),
    normal: v("tracking-normal"),
    wide: v("tracking-wide"),
    caps: v("tracking-caps"),
  },
  weight: {
    light: v("weight-light"),
    regular: v("weight-regular"),
    medium: v("weight-medium"),
    semibold: v("weight-semibold"),
    bold: v("weight-bold"),
  },
} as const;

export const tokens = {
  fonts,
  obsidian,
  brand,
  mana,
  surface,
  text,
  border,
  accent,
  status,
  glass,
  radius,
  space,
  elevation,
  duration,
  durationMs,
  easing,
  easingCurve,
  motion,
  typography,
} as const;

export type Tokens = typeof tokens;

/** Returns `true` when the user has asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis === "undefined") return false;
  const g = globalThis as { matchMedia?: (q: string) => { matches: boolean } };
  return typeof g.matchMedia === "function"
    ? g.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export default tokens;
