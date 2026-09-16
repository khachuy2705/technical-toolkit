import { pick, randomInt, sample } from './random';

export const WORD_COUNT_MIN = 3;
export const WORD_COUNT_MAX = 15;
export const WORD_COUNT_DEFAULT = 6;

export interface Wordlist {
  readonly id: WordlistId;
  readonly label: string;
  readonly size: number;
  readonly note: string;
  readonly load: () => Promise<readonly string[]>;
}

export type WordlistId = 'eff-large' | 'eff-short';

/**
 * Wordlists load on demand: the large list is ~60 KB of source, and the
 * password generator should not pay for it.
 */
export const WORDLISTS: readonly Wordlist[] = [
  {
    id: 'eff-large',
    label: 'EFF Large',
    size: 7776,
    note: '12.9 bits per word — the standard diceware list.',
    load: async () => (await import('./wordlists/eff-large')).EFF_LARGE,
  },
  {
    id: 'eff-short',
    label: 'EFF Short',
    size: 1296,
    note: '10.3 bits per word — shorter, easier to type and remember.',
    load: async () => (await import('./wordlists/eff-short')).EFF_SHORT,
  },
] as const;

export function wordlistById(id: WordlistId): Wordlist {
  const found = WORDLISTS.find((w) => w.id === id);
  if (!found) throw new Error(`Unknown wordlist: ${id}`);
  return found;
}

export type SeparatorId = 'dash' | 'dot' | 'underscore' | 'space' | 'none' | 'digit' | 'symbol';
export type Capitalization = 'lowercase' | 'title' | 'uppercase' | 'random-word';

interface SeparatorSpec {
  readonly id: SeparatorId;
  readonly label: string;
  /** Fixed text, or `null` when a fresh random character is drawn each time. */
  readonly value: string | null;
}

/** Drawn between words when the separator is set to "random symbol". */
export const SEPARATOR_SYMBOLS = '!@#$%^&*-_=+?';

/**
 * Drawn for the "append a symbol" extra.
 *
 * Deliberately excludes every character that can also act as a separator
 * (`- _ = ^`), so an appended symbol can never sit flush against a matching
 * separator and read as one token: `word--next` is confusing to type and to
 * dictate over the phone.
 */
export const SUFFIX_SYMBOLS = '!@#$%&*+?';

export const SEPARATORS: readonly SeparatorSpec[] = [
  { id: 'dash', label: 'Hyphen  -', value: '-' },
  { id: 'dot', label: 'Dot  .', value: '.' },
  { id: 'underscore', label: 'Underscore  _', value: '_' },
  { id: 'space', label: 'Space', value: ' ' },
  { id: 'none', label: 'None', value: '' },
  { id: 'digit', label: 'Random digit', value: null },
  { id: 'symbol', label: 'Random symbol', value: null },
];

export interface PassphraseOptions {
  wordCount: number;
  wordlistId: WordlistId;
  separator: SeparatorId;
  capitalization: Capitalization;
  /** Append a random digit to one random word. */
  includeNumber: boolean;
  /** Append a random symbol to one random word. */
  includeSymbol: boolean;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  wordCount: WORD_COUNT_DEFAULT,
  wordlistId: 'eff-large',
  separator: 'dash',
  capitalization: 'lowercase',
  includeNumber: false,
  includeSymbol: false,
};

/** How many separators sit between `wordCount` words. */
export function separatorCount(wordCount: number): number {
  return Math.max(0, wordCount - 1);
}

function drawSeparator(id: SeparatorId): string {
  const spec = SEPARATORS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown separator: ${id}`);
  if (spec.value !== null) return spec.value;
  return id === 'digit' ? String(randomInt(10)) : pick([...SEPARATOR_SYMBOLS]);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function applyCapitalization(words: string[], mode: Capitalization): string[] {
  switch (mode) {
    case 'title':
      return words.map(capitalize);
    case 'uppercase':
      return words.map((w) => w.toUpperCase());
    case 'random-word': {
      // Exactly one word is uppercased, chosen at random. Worth log2(n) bits.
      const target = randomInt(words.length);
      return words.map((w, i) => (i === target ? w.toUpperCase() : w));
    }
    case 'lowercase':
    default:
      return words;
  }
}

export function validatePassphraseOptions(opts: PassphraseOptions): string | null {
  if (!Number.isInteger(opts.wordCount) || opts.wordCount < WORD_COUNT_MIN) {
    return `Use at least ${WORD_COUNT_MIN} words.`;
  }
  if (opts.wordCount > WORD_COUNT_MAX) return `Use at most ${WORD_COUNT_MAX} words.`;
  if (opts.separator === 'none' && opts.capitalization === 'lowercase') {
    return null; // Legal, just harder to read — the UI warns separately.
  }
  return null;
}

export function generatePassphrase(words: readonly string[], opts: PassphraseOptions): string {
  const problem = validatePassphraseOptions(opts);
  if (problem) throw new Error(problem);

  let parts = applyCapitalization(sample(words, opts.wordCount), opts.capitalization);

  // A digit and a symbol are appended to two *different* words when both are
  // requested, so neither overwrites the other's position.
  const decorated = new Set<number>();
  const decorate = (suffix: string) => {
    const candidates = parts.map((_, i) => i).filter((i) => !decorated.has(i));
    const target = candidates.length > 0 ? pick(candidates) : randomInt(parts.length);
    decorated.add(target);
    parts = parts.map((w, i) => (i === target ? w + suffix : w));
  };
  if (opts.includeNumber) decorate(String(randomInt(10)));
  if (opts.includeSymbol) decorate(pick([...SUFFIX_SYMBOLS]));

  return parts.reduce((acc, word, i) => (i === 0 ? word : acc + drawSeparator(opts.separator) + word), '');
}

export function generatePassphrases(
  words: readonly string[],
  opts: PassphraseOptions,
  count: number,
): string[] {
  return Array.from({ length: count }, () => generatePassphrase(words, opts));
}
