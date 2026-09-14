import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokens } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tokensCss = readFileSync(join(root, "tokens.css"), "utf8");
const tailwindCss = readFileSync(join(root, "tailwind.css"), "utf8");

const DEFINED = /^\s*(--g-[a-z0-9-]+)\s*:/gm;
const REFERENCED = /var\((--g-[a-z0-9-]+)\)/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/;

function collect(re: RegExp, src: string): Set<string> {
  return new Set(Array.from(src.matchAll(re), (m) => m[1]));
}

const defined = collect(DEFINED, tokensCss);

describe("tokens.css", () => {
  it("defines a non-trivial token set", () => {
    expect(defined.size).toBeGreaterThan(100);
  });

  it("every --g-* token referenced inside tokens.css is defined", () => {
    for (const name of collect(REFERENCED, tokensCss)) {
      expect(defined.has(name), `${name} referenced but not defined`).toBe(true);
    }
  });

  it("includes the five elevation levels, WUBRG, and both brand fonts", () => {
    for (const n of [1, 2, 3, 4, 5]) expect(defined.has(`--g-elevation-${n}`)).toBe(true);
    for (const c of ["w", "u", "b", "r", "g"]) expect(defined.has(`--g-mana-${c}`)).toBe(true);
    expect(tokensCss).toMatch(/--g-font-display:\s*"Fraunces"/);
    expect(tokensCss).toMatch(/--g-font-body:\s*"Inter"/);
    expect(tokensCss).toContain("prefers-reduced-motion");
  });
});

describe("tailwind.css", () => {
  it("only references --g-* tokens that tokens.css defines", () => {
    const missing = [...collect(REFERENCED, tailwindCss)].filter((n) => !defined.has(n));
    expect(missing).toEqual([]);
  });

  it("contains no raw hex colors", () => {
    expect(tailwindCss).not.toMatch(HEX);
  });
});

describe("src/*.ts", () => {
  it("contains no raw hex colors (hex lives only in tokens.css)", () => {
    for (const f of readdirSync(here).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(here, f), "utf8");
      expect(src, `${f} contains a raw hex color`).not.toMatch(HEX);
    }
  });

  it("every var() the token object emits is defined in tokens.css", () => {
    const seen = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        for (const m of node.matchAll(REFERENCED)) seen.add(m[1]);
      } else if (node && typeof node === "object") {
        for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      }
    };
    walk(tokens);
    expect(seen.size).toBeGreaterThan(50);
    const missing = [...seen].filter((n) => !defined.has(n));
    expect(missing).toEqual([]);
  });
});
