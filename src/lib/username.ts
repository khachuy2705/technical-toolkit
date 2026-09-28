/**
 * Usernames drawn from Marvel and DC superhero names.
 *
 * A username is one hero name, written the way the options say — lowercase or
 * capitalised, joined or spaced — plus an optional one- or two-digit ending
 * for when the plain name is taken. The hero and the ending are drawn together
 * as one index into heroes × endings, which is what lets a bulk list be
 * distinct without drawing again and hoping.
 */

import { distinctIndices } from './random';
import { DC_HEROES, MARVEL_HEROES } from './wordlists/heroes';

export type Universe = 'marvel' | 'dc';
export type LetterCase = 'lower' | 'capital';
export type Spacing = 'joined' | 'spaced';
export type DigitCount = 0 | 1 | 2;

export interface UniverseSpec {
  readonly id: Universe;
  readonly label: string;
  readonly heroes: readonly string[];
}

export const UNIVERSES: readonly UniverseSpec[] = [
  { id: 'marvel', label: 'Marvel', heroes: MARVEL_HEROES },
  { id: 'dc', label: 'DC', heroes: DC_HEROES },
];

export const DIGIT_COUNTS: readonly DigitCount[] = [0, 1, 2];

/**
 * The bulk panel's ceiling. Each universe holds at least this many heroes —
 * the suite asserts it — so a full bulk list is all different names even with
 * no digits and one universe ticked.
 */
export const BULK_MAX = 100;

export interface UsernameOptions {
  /** One or both; their heroes are drawn from as one pool. */
  universes: readonly Universe[];
  /** `capital` upper-cases the first letter of every word. */
  letterCase: LetterCase;
  /** `spaced` puts a space between words, and before the digits. */
  spacing: Spacing;
  /** Digits appended at the end: none, one (0–9) or two (00–99). */
  digits: DigitCount;
}

export const DEFAULT_USERNAME_OPTIONS: UsernameOptions = {
  universes: ['marvel', 'dc'],
  letterCase: 'lower',
  spacing: 'joined',
  digits: 0,
};

/** The heroes of the ticked universes, in a fixed order whatever order they were ticked in. */
export function heroesFor(universes: readonly Universe[]): readonly string[] {
  return UNIVERSES.filter((u) => universes.includes(u.id)).flatMap((u) => u.heroes);
}

/** How many different endings `digits` allows: 1 (none), 10 or 100. */
export function endingCount(digits: DigitCount): number {
  return 10 ** digits;
}

/** Every username the options can produce — heroes × endings. */
export function usernameSpace(opts: UsernameOptions): number {
  return heroesFor(opts.universes).length * endingCount(opts.digits);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * One hero written out. `hero` is its words separated by single spaces, as
 * the wordlist stores them; `ending` is the digits, or empty.
 *
 * In spaced mode the digits are a word of their own — `Spider Man 42` rather
 * than `Spider Man42` — so the spacing reads the same all the way along.
 */
export function formatUsername(
  hero: string,
  ending: string,
  opts: Pick<UsernameOptions, 'letterCase' | 'spacing'>,
): string {
  const words = hero
    .split(' ')
    .map((w) => (opts.letterCase === 'capital' ? capitalize(w) : w.toLowerCase()));
  if (ending) words.push(ending);
  return words.join(opts.spacing === 'spaced' ? ' ' : '');
}

export function validateUsernameOptions(opts: UsernameOptions): string | null {
  if (heroesFor(opts.universes).length === 0) return 'Pick Marvel, DC or both.';
  if (!DIGIT_COUNTS.includes(opts.digits)) return 'Digits at the end must be none, one or two.';
  return null;
}

/**
 * `count` usernames, no two alike. A request for more than the options can
 * produce returns every one of them, shuffled, rather than repeating any.
 */
export function generateUsernames(opts: UsernameOptions, count: number): string[] {
  const problem = validateUsernameOptions(opts);
  if (problem) throw new Error(problem);

  const heroes = heroesFor(opts.universes);
  const endings = endingCount(opts.digits);
  const size = heroes.length * endings;
  const wanted = Math.min(size, Math.max(0, Math.floor(count)));

  return distinctIndices(size, wanted).map((index) => {
    const hero = heroes[Math.floor(index / endings)]!;
    const ending = opts.digits === 0 ? '' : String(index % endings).padStart(opts.digits, '0');
    return formatUsername(hero, ending, opts);
  });
}

export function generateUsername(opts: UsernameOptions): string {
  return generateUsernames(opts, 1)[0]!;
}
