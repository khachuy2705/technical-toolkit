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

export type WordlistId = 'bip39-en' | 'superhero' | 'eff-large' | 'eff-short';

/**
 * Wordlists load on demand: the large list is ~60 KB of source, and the
 * password generator should not pay for it.
 */
export const WORDLISTS: readonly Wordlist[] = [
  {
    id: 'bip39-en',
    label: 'BIP39 English',
    size: 2048,
    note: 'exactly 11 bits per word; every word is unique in its first four letters',
    load: async () => (await import('./wordlists/bip39-en')).BIP39_EN,
  },
  {
    id: 'superhero',
    label: 'Superheroes',
    size: 101,
    note: 'short and memorable, so it needs roughly twice as many words',
    load: async () => (await import('./wordlists/superhero')).SUPERHERO,
  },
  {
    id: 'eff-large',
    label: 'EFF Large',
    size: 7776,
    note: 'the standard diceware list',
    load: async () => (await import('./wordlists/eff-large')).EFF_LARGE,
  },
  {
    id: 'eff-short',
    label: 'EFF Short',
    size: 1296,
    note: 'shorter EFF list, easier to type',
    load: async () => (await import('./wordlists/eff-short')).EFF_SHORT,
  },
] as const;

export function wordlistById(id: WordlistId): Wordlist {
  const found = WORDLISTS.find((w) => w.id === id);
  if (!found) throw new Error(`Unknown wordlist: ${id}`);
  return found;
}

/**
 * The combined draw pool for a set of lists, with duplicates removed.
 *
 * Deduplication is not tidiness, it is correctness. The lists overlap heavily —
 * 870 words are in both BIP39 and the EFF large list — and a plain concatenation
 * would do two wrong things at once: report `log2(total)` bits for a pool that
 * does not have that many distinct words, and make every shared word twice as
 * likely to be drawn as an unshared one.
 *
 * Insertion order is preserved so the pool is stable across calls, which keeps
 * anything derived from an index reproducible.
 */
export function mergeWordlists(lists: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const word of list) seen.add(word);
  }
  return [...seen];
}

/** Loads every selected list and merges them into one pool. */
export async function loadWordlists(ids: readonly WordlistId[]): Promise<readonly string[]> {
  const loaded = await Promise.all(ids.map((id) => wordlistById(id).load()));
  return mergeWordlists(loaded);
}

export type SeparatorId =
  | 'dash'
  | 'dot'
  | 'underscore'
  | 'space'
  | 'none'
  | 'digit'
  | 'symbol'
  | 'custom';
export type Capitalization = 'lowercase' | 'title' | 'uppercase' | 'random-word';

interface SeparatorSpec {
  readonly id: SeparatorId;
  readonly label: string;
  /**
   * `fixed` uses `value`; `random` draws a fresh character per gap and is the
   * only kind that contributes entropy; `custom` reads `opts.customSeparator`.
   */
  readonly kind: 'fixed' | 'random' | 'custom';
  readonly value?: string;
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
  { id: 'dash', label: 'Hyphen  -', kind: 'fixed', value: '-' },
  { id: 'dot', label: 'Dot  .', kind: 'fixed', value: '.' },
  { id: 'underscore', label: 'Underscore  _', kind: 'fixed', value: '_' },
  { id: 'space', label: 'Space', kind: 'fixed', value: ' ' },
  { id: 'none', label: 'None', kind: 'fixed', value: '' },
  { id: 'digit', label: 'Random digit', kind: 'random' },
  { id: 'symbol', label: 'Random symbol', kind: 'random' },
  { id: 'custom', label: 'Custom…', kind: 'custom' },
];

export function separatorById(id: SeparatorId): SeparatorSpec {
  const found = SEPARATORS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown separator: ${id}`);
  return found;
}

/** A custom separator longer than this is almost certainly a mistake. */
export const CUSTOM_SEPARATOR_MAX = 8;

export interface PassphraseOptions {
  wordCount: number;
  /** One or more lists, merged and deduplicated into a single draw pool. */
  wordlistIds: readonly WordlistId[];
  separator: SeparatorId;
  /** Used only when `separator` is `'custom'`. May be empty. */
  customSeparator: string;
  capitalization: Capitalization;
  /** Append a random digit to one random word. */
  includeNumber: boolean;
  /** Append a random symbol to one random word. */
  includeSymbol: boolean;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  wordCount: WORD_COUNT_DEFAULT,
  wordlistIds: ['bip39-en', 'superhero'],
  separator: 'dash',
  customSeparator: '-',
  capitalization: 'lowercase',
  includeNumber: true,
  includeSymbol: false,
};

function drawSeparator(opts: PassphraseOptions): string {
  const spec = separatorById(opts.separator);
  if (spec.kind === 'fixed') return spec.value ?? '';
  if (spec.kind === 'custom') return opts.customSeparator.slice(0, CUSTOM_SEPARATOR_MAX);
  return opts.separator === 'digit' ? String(randomInt(10)) : pick([...SEPARATOR_SYMBOLS]);
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
  if (opts.wordlistIds.length === 0) return 'Select at least one wordlist.';
  if (!Number.isInteger(opts.wordCount) || opts.wordCount < WORD_COUNT_MIN) {
    return `Use at least ${WORD_COUNT_MIN} words.`;
  }
  if (opts.wordCount > WORD_COUNT_MAX) return `Use at most ${WORD_COUNT_MAX} words.`;
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

  return parts.reduce((acc, word, i) => (i === 0 ? word : acc + drawSeparator(opts) + word), '');
}

export function generatePassphrases(
  words: readonly string[],
  opts: PassphraseOptions,
  count: number,
): string[] {
  return Array.from({ length: count }, () => generatePassphrase(words, opts));
}
