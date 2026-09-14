/**
 * Infinite-combo signatures. A combo tags its pieces only when EVERY piece is in the decklist,
 * so a deck holding one half of a two-card combo gets no combo header.
 */
export interface ComboSignature {
  readonly name: string;
  readonly cards: readonly string[];
}

export const INFINITE_COMBOS: readonly ComboSignature[] = [
  { name: 'Combo: Heliod + Walking Ballista', cards: ['Heliod, Sun-Crowned', 'Walking Ballista'] },
  { name: "Combo: Thassa's Oracle + Demonic Consultation", cards: ["Thassa's Oracle", 'Demonic Consultation'] },
  { name: "Combo: Thassa's Oracle + Tainted Pact", cards: ["Thassa's Oracle", 'Tainted Pact'] },
  { name: 'Combo: Peregrine Drake + Deadeye Navigator', cards: ['Peregrine Drake', 'Deadeye Navigator'] },
  { name: "Combo: Hazel's Brewmaster + Devoted Druid", cards: ["Hazel's Brewmaster", 'Devoted Druid'] },
  { name: 'Combo: Chain of Smog + Witherbloom Apprentice', cards: ['Chain of Smog', 'Witherbloom Apprentice'] },
  { name: 'Combo: Chain of Smog + Professor Onyx', cards: ['Chain of Smog', 'Professor Onyx'] },
  { name: 'Combo: Kiki-Jiki + Zealous Conscripts', cards: ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts'] },
  { name: 'Combo: Kiki-Jiki + Deceiver Exarch', cards: ['Kiki-Jiki, Mirror Breaker', 'Deceiver Exarch'] },
  { name: 'Combo: Kiki-Jiki + Pestermite', cards: ['Kiki-Jiki, Mirror Breaker', 'Pestermite'] },
  { name: 'Combo: Kiki-Jiki + Felidar Guardian', cards: ['Kiki-Jiki, Mirror Breaker', 'Felidar Guardian'] },
  { name: 'Combo: Splinter Twin + Deceiver Exarch', cards: ['Splinter Twin', 'Deceiver Exarch'] },
  { name: 'Combo: Splinter Twin + Pestermite', cards: ['Splinter Twin', 'Pestermite'] },
  { name: 'Combo: Dualcaster Mage + Twinflame', cards: ['Dualcaster Mage', 'Twinflame'] },
  { name: 'Combo: Dualcaster Mage + Heat Shimmer', cards: ['Dualcaster Mage', 'Heat Shimmer'] },
  { name: 'Combo: Sanguine Bond + Exquisite Blood', cards: ['Sanguine Bond', 'Exquisite Blood'] },
  { name: 'Combo: Basalt Monolith + Rings of Brighthearth', cards: ['Basalt Monolith', 'Rings of Brighthearth'] },
  { name: 'Combo: Basalt Monolith + Forsaken Monument', cards: ['Basalt Monolith', 'Forsaken Monument'] },
  { name: 'Combo: Grim Monolith + Power Artifact', cards: ['Grim Monolith', 'Power Artifact'] },
  { name: 'Combo: Phyrexian Altar + Gravecrawler', cards: ['Phyrexian Altar', 'Gravecrawler'] },
  { name: "Combo: Ashnod's Altar + Nim Deathmantle", cards: ["Ashnod's Altar", 'Nim Deathmantle'] },
  { name: "Combo: Painter's Servant + Grindstone", cards: ["Painter's Servant", 'Grindstone'] },
  { name: 'Combo: Mindcrank + Bloodchief Ascension', cards: ['Mindcrank', 'Bloodchief Ascension'] },
  { name: 'Combo: Mindcrank + Duskmantle Guildmage', cards: ['Mindcrank', 'Duskmantle Guildmage'] },
  { name: 'Combo: Freed from the Real + Bloom Tender', cards: ['Freed from the Real', 'Bloom Tender'] },
  { name: 'Combo: Freed from the Real + Faeburrow Elder', cards: ['Freed from the Real', 'Faeburrow Elder'] },
  { name: "Combo: Pemmin's Aura + Bloom Tender", cards: ["Pemmin's Aura", 'Bloom Tender'] },
  { name: "Combo: Pemmin's Aura + Faeburrow Elder", cards: ["Pemmin's Aura", 'Faeburrow Elder'] },
  { name: "Combo: Sensei's Divining Top + Bolas's Citadel", cards: ["Sensei's Divining Top", "Bolas's Citadel"] },
  { name: 'Combo: Godo + Helm of the Host', cards: ['Godo, Bandit Warlord', 'Helm of the Host'] },
  { name: 'Combo: Malcolm + Glint-Horn Buccaneer', cards: ['Malcolm, Keen-Eyed Navigator', 'Glint-Horn Buccaneer'] },
  { name: 'Combo: Niv-Mizzet + Curiosity', cards: ['Niv-Mizzet, Parun', 'Curiosity'] },
  { name: 'Combo: Niv-Mizzet + Curiosity', cards: ['Niv-Mizzet, the Firemind', 'Curiosity'] },
  { name: 'Combo: Niv-Mizzet + Ophidian Eye', cards: ['Niv-Mizzet, Parun', 'Ophidian Eye'] },
  { name: 'Combo: Niv-Mizzet + Tandem Lookout', cards: ['Niv-Mizzet, Parun', 'Tandem Lookout'] },
  { name: 'Combo: Stella Lee + Twisted Fealty', cards: ['Stella Lee, Wild Card', 'Twisted Fealty'] },
  { name: 'Combo: Earthcraft + Squirrel Nest', cards: ['Earthcraft', 'Squirrel Nest'] },
] as const;
