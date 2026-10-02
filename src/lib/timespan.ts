/**
 * systemd time spans — `RestartSec=5s`, `TimeoutStartSec=1min 30s`,
 * `OnBootSec=15min` — read as systemd's parse_time() reads them, and written
 * back the way systemd prints them.
 *
 * The grammar is looser than it looks, and the looseness is systemd's, kept
 * on purpose: a bare number is seconds, numbers and units may run together
 * (`1h30min`), several terms add up (`10 20` is thirty seconds), and units
 * match by prefix in a fixed order — so `5Min` reads `M` as months and then
 * fails on `in`, while `5 minuts` reads `min` and then fails on `uts`.
 */

/** One unit's suffixes, in the order systemd tries them, and its length in microseconds. */
const US_UNITS: readonly (readonly [string, bigint])[] = [
  ["seconds", 1_000_000n],
  ["second", 1_000_000n],
  ["sec", 1_000_000n],
  ["s", 1_000_000n],
  ["minutes", 60_000_000n],
  ["minute", 60_000_000n],
  ["min", 60_000_000n],
  ["months", 2_629_800_000_000n],
  ["month", 2_629_800_000_000n],
  ["M", 2_629_800_000_000n],
  ["msec", 1000n],
  ["ms", 1000n],
  ["m", 60_000_000n],
  ["hours", 3_600_000_000n],
  ["hour", 3_600_000_000n],
  ["hr", 3_600_000_000n],
  ["h", 3_600_000_000n],
  ["days", 86_400_000_000n],
  ["day", 86_400_000_000n],
  ["d", 86_400_000_000n],
  ["weeks", 604_800_000_000n],
  ["week", 604_800_000_000n],
  ["w", 604_800_000_000n],
  ["years", 31_557_600_000_000n],
  ["year", 31_557_600_000_000n],
  ["y", 31_557_600_000_000n],
  ["usec", 1n],
  ["us", 1n],
  ["μs", 1n],
  ["µs", 1n],
];

/** parse_nsec()'s table: the same units in nanoseconds, with ns on top. */
const NS_UNITS: readonly (readonly [string, bigint])[] = [
  ...US_UNITS.filter(([suffix]) => !["usec", "us", "μs", "µs"].includes(suffix)).map(([suffix, us]) => [suffix, us * 1000n] as const),
  ["usec", 1000n],
  ["us", 1000n],
  ["μs", 1000n],
  ["µs", 1000n],
  ["nsec", 1n],
  ["ns", 1n],
];

const WHITESPACE = " \t\n\r";
const isSpace = (ch: string | undefined): boolean => ch !== undefined && WHITESPACE.includes(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/** USEC_INFINITY: 2^64 - 1. Reaching it is out of range. */
const INFINITY = 2n ** 64n - 1n;
/** strtoll() stops here with ERANGE. */
const LONG_MAX = 2n ** 63n - 1n;

/**
 * parse_time(), exactly: microseconds (nanoseconds for `ns`) as a bigint,
 * "infinity", or null where systemd refuses the text.
 */
export function parseTimespanExact(text: string, unit: "us" | "ns" = "us"): bigint | "infinity" | null {
  const table = unit === "ns" ? NS_UNITS : US_UNITS;
  const second = unit === "ns" ? 1_000_000_000n : 1_000_000n;
  let i = 0;
  while (isSpace(text[i])) i += 1;
  if (text.startsWith("infinity", i)) {
    return [...text.slice(i + "infinity".length)].every((ch) => isSpace(ch)) ? "infinity" : null;
  }

  let total = 0n;
  let something = false;
  for (;;) {
    while (isSpace(text[i])) i += 1;
    if (i >= text.length) return something ? total : null;
    if (text[i] === "-") return null;

    // strtoll(): an optional plus, then digits.
    let j = i;
    if (text[j] === "+") j += 1;
    const digitsStart = j;
    while (isDigit(text[j])) j += 1;
    const hasDigits = j > digitsStart;
    const whole = hasDigits ? BigInt(text.slice(digitsStart, j)) : 0n;
    if (whole > LONG_MAX) return null;
    const end = hasDigits ? j : i;

    let p: number;
    if (text[end] === ".") {
      p = end + 1;
      while (isDigit(text[p])) p += 1;
    } else if (!hasDigits) {
      return null;
    } else {
      p = end;
    }

    // The unit, after optional whitespace; with none, the default.
    let q = p;
    while (isSpace(text[q])) q += 1;
    let multiplier = second;
    let s = q;
    for (const [suffix, size] of table) {
      if (text.startsWith(suffix, q)) {
        multiplier = size;
        s = q + suffix.length;
        break;
      }
    }
    // "12.34.56" is refused, though "12.34 .56" and "12.34s.56" are not.
    if (s === p && s < text.length) return null;
    i = s;

    if (whole >= INFINITY / multiplier) return null;
    const k = whole * multiplier;
    if (k >= INFINITY - total) return null;
    total += k;
    something = true;

    if (text[end] === ".") {
      let m = multiplier / 10n;
      let b = end + 1;
      for (; isDigit(text[b]); b += 1, m /= 10n) {
        const part = BigInt(text[b]!) * m;
        if (part >= INFINITY - total) return null;
        total += part;
      }
      if (b === end + 1) return null;
    }
  }
}

/**
 * A time span in microseconds (`ns` for nanoseconds), `Infinity` for
 * "infinity", or null where systemd would refuse it. Past 2^53 µs, some 285
 * years, the number is the nearest a JavaScript number can hold.
 */
export function parseTimespan(text: string, unit: "us" | "ns" = "us"): number | null {
  const exact = parseTimespanExact(text, unit);
  return exact === null ? null : exact === "infinity" ? Number.POSITIVE_INFINITY : Number(exact);
}

const SPAN_UNITS: readonly (readonly [string, bigint])[] = [
  ["y", 31_557_600_000_000n],
  ["month", 2_629_800_000_000n],
  ["w", 604_800_000_000n],
  ["d", 86_400_000_000n],
  ["h", 3_600_000_000n],
  ["min", 60_000_000n],
  ["s", 1_000_000n],
  ["ms", 1000n],
  ["us", 1n],
];

/**
 * systemd's format_timespan(): `1h 30min`, `100ms`, `infinity`, `0` — and,
 * under a minute, a fraction in dot notation: `55.532000s`, `1.500ms`.
 * `accuracy` drops digits finer than it, as systemd does; 1 keeps them all.
 */
export function formatTimespan(us: number | bigint, accuracy = 1): string {
  if (us === Number.POSITIVE_INFINITY) return "infinity";
  let left = typeof us === "bigint" ? us : BigInt(Math.round(us));
  if (left >= INFINITY) return "infinity";
  if (left <= 0n) return "0";
  const fine = BigInt(accuracy);
  const parts: string[] = [];
  for (const [suffix, size] of SPAN_UNITS) {
    if (left <= 0n) break;
    if (left < fine && parts.length > 0) break;
    if (left < size) continue;
    const count = left / size;
    let rest = left % size;
    if (left < 60_000_000n && rest > 0n) {
      let digits = 0;
      for (let cc = size; cc > 1n; cc /= 10n) digits += 1;
      for (let cc = fine; cc > 1n; cc /= 10n) {
        rest /= 10n;
        digits -= 1;
      }
      if (digits > 0) {
        parts.push(`${count}.${String(rest).padStart(digits, "0")}${suffix}`);
        break;
      }
    }
    parts.push(`${count}${suffix}`);
    left = rest;
  }
  return parts.join(" ");
}
