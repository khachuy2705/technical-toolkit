/**
 * Entropy accounting and how to phrase it for a human.
 *
 * Entropy here measures the generator, not the string: it is the size of the
 * space this configuration draws from, which is the only number an attacker
 * who knows our settings actually faces. Pattern-matching scorers such as
 * zxcvbn answer a different question (how guessable is *this* text) and would
 * understate a genuinely random output.
 */

import {
  SEPARATOR_SYMBOLS,
  SUFFIX_SYMBOLS,
  separatorById,
  type PassphraseOptions,
} from './passphrase';

export function passwordEntropy(poolSize: number, length: number): number {
  if (poolSize < 2 || length < 1) return 0;
  return Math.log2(poolSize) * length;
}

/**
 * Bits for a passphrase configuration.
 *
 * Deliberately conservative: the random *position* of an appended digit or
 * symbol is real entropy, but we do not count it. Under-promising is the right
 * failure mode for a security tool.
 */
export function passphraseEntropy(opts: PassphraseOptions, listSize: number): number {
  if (listSize < 2 || opts.wordCount < 1) return 0;

  let bits = Math.log2(listSize) * opts.wordCount;

  // Only a freshly drawn separator adds anything. A fixed one — including a
  // custom string the user typed — is part of the scheme the attacker knows.
  const gaps = Math.max(0, opts.wordCount - 1);
  if (separatorById(opts.separator).kind === 'random') {
    bits += gaps * Math.log2(opts.separator === 'digit' ? 10 : SEPARATOR_SYMBOLS.length);
  }

  if (opts.capitalization === 'random-word') bits += Math.log2(opts.wordCount);
  if (opts.includeNumber) bits += Math.log2(10);
  if (opts.includeSymbol) bits += Math.log2(SUFFIX_SYMBOLS.length);

  return bits;
}

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export interface Strength {
  level: StrengthLevel;
  label: string;
}

const STRENGTH_TIERS: readonly { min: number; label: string }[] = [
  { min: 96, label: 'Excellent' },
  { min: 72, label: 'Strong' },
  { min: 56, label: 'Fair' },
  { min: 36, label: 'Weak' },
  { min: 0, label: 'Very weak' },
];

export function classifyStrength(bits: number): Strength {
  const index = STRENGTH_TIERS.findIndex((tier) => bits >= tier.min);
  const level = (STRENGTH_TIERS.length - 1 - index) as StrengthLevel;
  return { level, label: STRENGTH_TIERS[index]!.label };
}

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = DAY * 30.44;
const YEAR = DAY * 365.25;

const UNITS: readonly { limit: number; size: number; name: string }[] = [
  { limit: MINUTE, size: SECOND, name: 'second' },
  { limit: HOUR, size: MINUTE, name: 'minute' },
  { limit: DAY, size: HOUR, name: 'hour' },
  { limit: MONTH, size: DAY, name: 'day' },
  { limit: YEAR, size: MONTH, name: 'month' },
  { limit: Infinity, size: YEAR, name: 'year' },
];

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'longer than the universe has existed';
  if (seconds < 1) return 'instantly';

  const unit = UNITS.find((u) => seconds < u.limit)!;
  const amount = seconds / unit.size;

  if (amount >= 1e15) {
    const exponent = Math.floor(Math.log10(amount));
    return `10^${exponent} years`;
  }
  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded.toLocaleString('en-US')} ${unit.name}${rounded === 1 ? '' : 's'}`;
}

/**
 * Time to find the secret by brute force, on average (half the keyspace).
 *
 * The default rate models an offline attack against a fast hash on commodity
 * GPUs — pessimistic on purpose. An online attack against a rate-limited login
 * is many orders of magnitude slower.
 */
export function crackTime(bits: number, guessesPerSecond = 1e11): string {
  if (bits <= 0) return 'instantly';
  const seconds = Math.pow(2, bits - 1) / guessesPerSecond;
  return formatDuration(seconds);
}
