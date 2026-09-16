/** Character classes offered by the password generator. */

export type CharClassId = 'lowercase' | 'uppercase' | 'digits' | 'symbols';

export interface CharClass {
  readonly id: CharClassId;
  readonly label: string;
  readonly chars: string;
  /** Short sample shown next to the toggle. */
  readonly sample: string;
}

export const CHAR_CLASSES: readonly CharClass[] = [
  { id: 'lowercase', label: 'Lowercase', chars: 'abcdefghijklmnopqrstuvwxyz', sample: 'a-z' },
  { id: 'uppercase', label: 'Uppercase', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', sample: 'A-Z' },
  { id: 'digits', label: 'Digits', chars: '0123456789', sample: '0-9' },
  { id: 'symbols', label: 'Symbols', chars: '!@#$%^&*()-_=+[]{};:,.<>?/~|', sample: '!@#$%' },
] as const;

/**
 * Glyphs that are easy to confuse when a password is read aloud, copied off a
 * screen, or typed from a printout. Excluding them costs a little entropy but
 * saves a lot of failed logins.
 */
export const AMBIGUOUS_CHARS = "Il1|O0o`'\";:,.<>()[]{}/\\";

const AMBIGUOUS_SET = new Set(AMBIGUOUS_CHARS);

export function stripAmbiguous(chars: string): string {
  return [...chars].filter((c) => !AMBIGUOUS_SET.has(c)).join('');
}

export function classById(id: CharClassId): CharClass {
  const found = CHAR_CLASSES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown character class: ${id}`);
  return found;
}
