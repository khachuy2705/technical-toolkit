/**
 * Cryptographically secure randomness.
 *
 * Every random value on this site comes from `crypto.getRandomValues()`.
 * `Math.random()` is never used: it is a fast non-cryptographic PRNG whose
 * internal state can be recovered from a handful of outputs, which would make
 * any secret derived from it predictable.
 */

/** Number of distinct values a Uint32 can hold. */
const UINT32_RANGE = 0x1_0000_0000;

/**
 * A uniformly distributed integer in the half-open interval `[0, max)`.
 *
 * The naive `getRandomValues() % max` is biased whenever `max` does not divide
 * 2^32 evenly, because the leftovers of the final partial block make small
 * results marginally more likely. We discard draws that land in that partial
 * block and try again, which costs less than one extra draw on average.
 */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`randomInt: max must be a positive integer, got ${max}`);
  }
  if (max === 1) return 0;

  const limit = Math.floor(UINT32_RANGE / max) * max;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);

  return value % max;
}

/** One element drawn uniformly at random. Throws on an empty input. */
export function pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick: cannot draw from an empty list');
  return items[randomInt(items.length)]!;
}

/** `count` independent draws, with replacement. */
export function sample<T>(items: readonly T[], count: number): T[] {
  const out: T[] = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = pick(items);
  return out;
}

/**
 * Fisher-Yates shuffle, in place, driven by the CSPRNG.
 *
 * Used to hide positional structure: without it, a password built as
 * "one required char per class, then filler" would always start with a
 * lowercase letter, handing an attacker free information.
 */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
