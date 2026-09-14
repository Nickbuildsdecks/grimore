import { describe, expect, it } from 'vitest';
import { findProfanity, firstProfaneField, isProfane, PROFANITY_WORDS } from './moderation.js';

/**
 * The false-positive cases are the point of this module, so they are asserted by name: every one of
 * them is rejected by legacy's `isProfane`, and several are real card names a player would
 * reasonably put in a deck name.
 */
describe('moderation', () => {
  describe('rejects what legacy rejected', () => {
    it.each(PROFANITY_WORDS)('flags the bare word %s', (word) => {
      expect(findProfanity(word)).toBe(word);
    });

    it('flags a word embedded in a sentence', () => {
      expect(isProfane('this deck is shit')).toBe(true);
    });

    it('is case insensitive', () => {
      expect(isProfane('SHIT')).toBe(true);
      expect(isProfane('ShIt')).toBe(true);
    });

    it('sees through punctuation spread between the letters', () => {
      expect(isProfane('f-u-c-k')).toBe(true);
      expect(isProfane('f.u.c.k')).toBe(true);
      expect(isProfane('f u c k')).toBe(true);
    });
  });

  describe('closes the evasions legacy let through', () => {
    it('folds leet digits onto their letters', () => {
      expect(isProfane('sh1t')).toBe(true);
      expect(isProfane('f4ggot')).toBe(true);
      expect(isProfane('b1tch')).toBe(true);
      expect(isProfane('cr4p')).toBe(true);
    });

    it('folds symbol substitutions', () => {
      expect(isProfane('sh!t')).toBe(true);
      expect(isProfane('@sshole')).toBe(true);
    });

    it('treats a masking character as one unknown letter', () => {
      expect(isProfane('f*ck')).toBe(true);
      expect(isProfane('sh#t')).toBe(true);
    });

    it('reduces a stretched word onto its root', () => {
      expect(isProfane('fuuuck')).toBe(true);
      expect(isProfane('shiiiit')).toBe(true);
    });

    it('strips diacritics', () => {
      expect(isProfane('fück')).toBe(true);
    });
  });

  describe('does not flag real words that merely contain one', () => {
    // Every one of these is rejected by legacy's matcher.
    it.each([
      'Scrap Mastery',
      'Scrapheap Scrounger',
      'Scrap Trawler',
      'Scrapyard Recombiner',
      "Scrapheap's Revenge",
      'scrapbooking',
      'Dickinson',
      'Charles Dickens',
      'pussyfooting around',
      'bastardized the format',
      'Scunthorpe',
    ])('allows %s', (text) => {
      expect(findProfanity(text)).toBeNull();
    });

    it('allows shiitake, which survives even the deduplicating pass', () => {
      // dedupe("shiitake") is "shitake", which contains dedupe("shit") — the allow list is what
      // saves it, so this asserts the allow list is consulted on both match paths.
      expect(findProfanity('shiitake mushrooms')).toBeNull();
    });

    it('scopes an exemption to the word it excuses', () => {
      // "scrap" is exempt from crap, not from everything else it might contain.
      expect(findProfanity('scrapfuck')).toBe('fuck');
    });
  });

  describe('does not join adjacent words', () => {
    // Legacy stripped the spaces before matching, so each of these produced a hit across the seam.
    it.each([
      'Goblins Hit Hard',
      'Boros Hits Hard',
      'Mass Hysteria',
      'Titans Hit The Table',
    ])('allows %s', (text) => {
      expect(findProfanity(text)).toBeNull();
    });

    it('still catches a real word next to an innocent one', () => {
      expect(findProfanity('Goblins Hit shit')).toBe('shit');
    });
  });

  describe('does not flag punctuation on its own', () => {
    it.each(['####', '****', '????', '...', '---'])('allows %s', (text) => {
      expect(findProfanity(text)).toBeNull();
    });
  });

  describe('empty input', () => {
    it.each([null, undefined, ''])('treats %s as clean', (text) => {
      expect(isProfane(text)).toBe(false);
      expect(findProfanity(text)).toBeNull();
    });
  });

  describe('firstProfaneField', () => {
    it('returns the label of the first offending field', () => {
      expect(
        firstProfaneField({ Nickname: 'Scrap Fan', Bio: 'this is shit', Commander: 'Atraxa' }),
      ).toBe('Bio');
    });

    it('returns null when every field is clean', () => {
      expect(
        firstProfaneField({ Nickname: 'Scrapheap Scrounger', Bio: null, Commander: undefined }),
      ).toBeNull();
    });
  });
});
