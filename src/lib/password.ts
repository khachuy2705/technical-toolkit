import { CHAR_CLASSES, classById, stripAmbiguous, type CharClassId } from './charsets';
import { pick, shuffle } from './random';

export const PASSWORD_LENGTH_MIN = 6;
export const PASSWORD_LENGTH_MAX = 128;
export const PASSWORD_LENGTH_DEFAULT = 20;

export interface PasswordOptions {
  length: number;
  /** Character classes to draw from. At least one is required. */
  classes: readonly CharClassId[];
  /** Drop glyphs that are easy to misread (see AMBIGUOUS_CHARS). */
  excludeAmbiguous: boolean;
  /** Use every character at most once. Caps the length at the pool size. */
  noRepeats: boolean;
  /** Guarantee at least one character from each selected class. */
  requireEachClass: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: PASSWORD_LENGTH_DEFAULT,
  classes: ['lowercase', 'uppercase', 'digits', 'symbols'],
  excludeAmbiguous: false,
  noRepeats: false,
  requireEachClass: true,
};

/** The usable characters of one class under the current filters. */
function poolForClass(id: CharClassId, excludeAmbiguous: boolean): string[] {
  const { chars } = classById(id);
  return [...(excludeAmbiguous ? stripAmbiguous(chars) : chars)];
}

/** Every character the generator may draw, deduplicated. */
export function buildPool(opts: PasswordOptions): string[] {
  const seen = new Set<string>();
  for (const id of CHAR_CLASSES.map((c) => c.id)) {
    if (!opts.classes.includes(id)) continue;
    for (const c of poolForClass(id, opts.excludeAmbiguous)) seen.add(c);
  }
  return [...seen];
}

/**
 * Human-readable reason the options cannot produce a password, or `null` when
 * they can. The UI calls this before generating so it can explain the problem
 * instead of showing a thrown error.
 */
export function validatePasswordOptions(opts: PasswordOptions): string | null {
  if (opts.classes.length === 0) return 'Select at least one character type.';

  const pool = buildPool(opts);
  if (pool.length === 0) return 'No characters left after excluding ambiguous ones.';

  if (opts.noRepeats && opts.length > pool.length) {
    return `Without repeats the pool of ${pool.length} characters caps the length at ${pool.length}.`;
  }
  if (opts.requireEachClass && opts.length < opts.classes.length) {
    return `Length must be at least ${opts.classes.length} to fit one of each selected type.`;
  }
  return null;
}

/**
 * One password.
 *
 * With `requireEachClass` the result is drawn in two stages — one mandatory
 * character per class, then free filler — and shuffled at the end so the class
 * layout carries no information about position.
 */
export function generatePassword(opts: PasswordOptions): string {
  const problem = validatePasswordOptions(opts);
  if (problem) throw new Error(problem);

  const used = new Set<string>();
  const draw = (from: readonly string[]): string => {
    const available = opts.noRepeats ? from.filter((c) => !used.has(c)) : from;
    if (available.length === 0) {
      throw new Error('Ran out of unique characters. Lower the length or allow repeats.');
    }
    const chosen = pick(available);
    if (opts.noRepeats) used.add(chosen);
    return chosen;
  };

  const chars: string[] = [];
  if (opts.requireEachClass) {
    for (const id of opts.classes) chars.push(draw(poolForClass(id, opts.excludeAmbiguous)));
  }

  const pool = buildPool(opts);
  while (chars.length < opts.length) chars.push(draw(pool));

  return shuffle(chars).join('');
}

export function generatePasswords(opts: PasswordOptions, count: number): string[] {
  return Array.from({ length: count }, () => generatePassword(opts));
}
