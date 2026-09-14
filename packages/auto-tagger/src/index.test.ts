import { describe, it, expect } from 'vitest';
import { CATEGORIES, classifyCard, detectCombos, norm, tagDeck, type CardInput } from './index.js';

const card = (name: string, typeLine = '', oracleText = ''): CardInput => ({ name, typeLine, oracleText });

describe('lands', () => {
  it('files basics under Lands and never under Ramp', () => {
    // "Standard lands NEVER count as Ramp" -- they are the mana curve, not acceleration.
    for (const name of ['Forest', 'Snow-Covered Island', 'Wastes']) {
      const tags = classifyCard(card(name, 'Basic Land'));
      expect(tags).toEqual(['Lands']);
      expect(tags).not.toContain('Ramp');
    }
  });

  it('files fetch lands under Lands ONLY — never Utility Lands, never Tutors', () => {
    // Their text says "search your library", which a text rule would read as a Tutor.
    for (const name of ['Polluted Delta', 'Misty Rainforest', 'Scalding Tarn', 'Prismatic Vista', 'Fabled Passage']) {
      const tags = classifyCard(card(name, 'Land', 'Search your library for a land card.'));
      expect(tags).toEqual(['Lands']);
      expect(tags).not.toContain('Utility Lands');
      expect(tags).not.toContain('Tutors');
    }
  });

  it('files non-mana utility lands under Utility Lands', () => {
    for (const name of ['Reliquary Tower', 'Bojuka Bog', 'Strip Mine', 'Maze of Ith', 'High Market']) {
      expect(classifyCard(card(name, 'Land'))).toContain('Utility Lands');
    }
  });

  it("keeps Urza's Saga as both a Utility Land and a Tutor", () => {
    const tags = classifyCard(card("Urza's Saga", 'Enchantment Land', 'Search your library for an artifact card.'));
    expect(tags).toContain('Utility Lands');
    expect(tags).toContain('Tutors');
  });

  it('treats an unlisted mana land as Lands, not Utility Lands', () => {
    expect(classifyCard(card('Command Tower', 'Land', 'Add one mana of any color in your commander\'s identity.')))
      .toEqual(['Lands']);
  });
});

describe('removal', () => {
  it('never tags a board wipe as single-target removal', () => {
    for (const name of ['Wrath of God', 'Toxic Deluge', 'Day of Black Sun', 'Culling Ritual', 'Damnation']) {
      const tags = classifyCard(card(name, 'Sorcery', 'Destroy all creatures. They cannot be regenerated.'));
      expect(tags).toContain('Mass Removal');
      expect(tags).not.toContain('Single Target Removal');
    }
  });

  it('tags spot removal as single-target only', () => {
    const tags = classifyCard(card('Swords to Plowshares', 'Instant', 'Exile target creature.'));
    expect(tags).toContain('Single Target Removal');
    expect(tags).not.toContain('Mass Removal');
  });

  it('recognises a wipe from its text even when it is not on the named list', () => {
    const tags = classifyCard(card('Nameless Sweeper', 'Sorcery', 'Destroy all creatures and all enchantments.'));
    expect(tags).toContain('Mass Removal');
    expect(tags).not.toContain('Single Target Removal');
  });
});

describe('graveyard', () => {
  it('never tags a reanimation spell as Blink & ETB', () => {
    for (const name of ['Reanimate', 'Animate Dead', 'Victimize', 'Necromancy']) {
      const tags = classifyCard(card(name, 'Sorcery',
        'Return target creature card from a graveyard to the battlefield. Exile it, then return it.'));
      expect(tags).toContain('Reanimation');
      expect(tags).not.toContain('Blink & ETB');
    }
  });

  it('separates recursion (to hand) from reanimation (to battlefield)', () => {
    const witness = classifyCard(card('Eternal Witness', 'Creature',
      'When Eternal Witness enters, return target card from your graveyard to your hand.'));
    expect(witness).toContain('Recursion');
    expect(witness).not.toContain('Reanimation');
  });

  it('tags self-mill as Graveyard Fillers', () => {
    expect(classifyCard(card("Stitcher's Supplier", 'Creature', 'Mill three cards.'))).toContain('Graveyard Fillers');
  });
});

describe('protection', () => {
  it('tags effects that protect the team', () => {
    const tags = classifyCard(card('Heroic Intervention', 'Instant',
      'Permanents you control gain hexproof and indestructible until end of turn.'));
    expect(tags).toContain('Protection');
  });

  it('never counts a self-protecting threat as team Protection', () => {
    // The directive names Koma and Carnage Tyrant specifically: these are Wincons, not Protection.
    for (const name of ['Koma, Cosmos Serpent', 'Carnage Tyrant']) {
      const tags = classifyCard(card(name, 'Legendary Creature', 'This creature has hexproof and is indestructible.'));
      expect(tags).toContain('Wincons / Finishers');
      expect(tags).not.toContain('Protection');
    }
  });
});

describe('card advantage vs selection', () => {
  it('prefers Card Advantage when a card both draws and filters', () => {
    const tags = classifyCard(card('Windfall', 'Sorcery', 'Each player discards their hand, then draws cards.'));
    expect(tags).toContain('Card Advantage');
    expect(tags).not.toContain('Card Selection');
  });

  it('tags pure filtering as Card Selection', () => {
    for (const name of ['Ponder', 'Brainstorm', 'Preordain', 'Sylvan Library', 'Impulse']) {
      const tags = classifyCard(card(name, 'Sorcery', 'Look at the top three cards of your library.'));
      expect(tags).toContain('Card Selection');
      expect(tags).not.toContain('Card Advantage');
    }
  });
});

describe('other roles', () => {
  it('tags wincons, tutors, stax, ramp and sacrifice outlets', () => {
    expect(classifyCard(card('Approach of the Second Sun', 'Sorcery', 'You win the game.')))
      .toContain('Wincons / Finishers');
    expect(classifyCard(card('Demonic Tutor', 'Sorcery', 'Search your library for a card.'))).toContain('Tutors');
    expect(classifyCard(card('Rule of Law', 'Enchantment', "Each player can't cast more than one spell each turn.")))
      .toContain('Stax');
    expect(classifyCard(card('Sol Ring', 'Artifact', '{T}: Add {C}{C}.'))).toContain('Ramp');
    expect(classifyCard(card('Viscera Seer', 'Creature', 'Sacrifice a creature: Scry 1.')))
      .toContain('Sacrifice Outlets');
  });

  it('falls back to Unique only when nothing matches', () => {
    expect(classifyCard(card('Vanilla Bear', 'Creature — Bear', ''))).toEqual(['Unique']);
    // And never alongside a real role.
    const tags = classifyCard(card('Sol Ring', 'Artifact', '{T}: Add {C}{C}.'));
    expect(tags).not.toContain('Unique');
  });

  it('returns tags in the documented display order', () => {
    const tags = classifyCard(card('Toxic Deluge', 'Sorcery', 'Destroy all creatures. Search your library.'));
    const positions = tags.map((t) => CATEGORIES.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('combo detection', () => {
  it('tags both pieces when the whole combo is present', () => {
    const found = detectCombos(['Heliod, Sun-Crowned', 'Walking Ballista', 'Forest']);
    expect(found.get(norm('Heliod, Sun-Crowned'))).toEqual(['Combo: Heliod + Walking Ballista']);
    expect(found.get(norm('Walking Ballista'))).toEqual(['Combo: Heliod + Walking Ballista']);
    expect(found.has(norm('Forest'))).toBe(false);
  });

  it('tags nothing when only one piece is present', () => {
    expect(detectCombos(['Walking Ballista', 'Forest']).size).toBe(0);
  });

  it('matches regardless of punctuation and case', () => {
    const found = detectCombos(["thassas oracle", 'DEMONIC CONSULTATION']);
    expect(found.get(norm("Thassa's Oracle"))).toContain("Combo: Thassa's Oracle + Demonic Consultation");
  });

  it('gives a card every combo it belongs to', () => {
    const found = detectCombos(['Kiki-Jiki, Mirror Breaker', 'Pestermite', 'Deceiver Exarch']);
    expect(found.get(norm('Kiki-Jiki, Mirror Breaker'))).toHaveLength(2);
    expect(found.get(norm('Pestermite'))).toEqual(['Combo: Kiki-Jiki + Pestermite']);
  });
});

describe('tagDeck', () => {
  it('leads with combo headers, then functional roles', () => {
    const tagged = tagDeck([
      card('Heliod, Sun-Crowned', 'Legendary Creature', 'Whenever you gain life, put a +1/+1 counter.'),
      card('Walking Ballista', 'Artifact Creature', 'Remove a +1/+1 counter: deals damage to target creature.'),
      card('Sol Ring', 'Artifact', '{T}: Add {C}{C}.'),
      card('Forest', 'Basic Land'),
    ]);
    const heliod = tagged.find((t) => t.name === 'Heliod, Sun-Crowned')!;
    expect(heliod.tags[0]).toBe('Combo: Heliod + Walking Ballista');
    expect(tagged.find((t) => t.name === 'Sol Ring')!.tags).toEqual(['Ramp']);
    expect(tagged.find((t) => t.name === 'Forest')!.tags).toEqual(['Lands']);
  });

  it('never leaves Unique next to a combo header', () => {
    // A card with no oracle text would be Unique on its own, but being half a combo is a role.
    const tagged = tagDeck([card('Chain of Smog'), card('Witherbloom Apprentice')]);
    for (const t of tagged) {
      expect(t.tags).toContain('Combo: Chain of Smog + Witherbloom Apprentice');
      expect(t.tags).not.toContain('Unique');
    }
  });

  it('tags every card in the list exactly once', () => {
    const names = ['Forest', 'Sol Ring', 'Wrath of God', 'Reanimate', 'Vanilla Bear'];
    const tagged = tagDeck(names.map((n) => card(n, '', 'Destroy all creatures.')));
    expect(tagged.map((t) => t.name)).toEqual(names);
    expect(tagged.every((t) => t.tags.length > 0)).toBe(true);
  });

  it('survives cards with no type line or oracle text at all', () => {
    // The local card table has gaps; a missing row must not throw or produce an empty tag list.
    const tagged = tagDeck([{ name: 'Some Unreleased Card' }]);
    expect(tagged[0].tags).toEqual(['Unique']);
  });
});
