/**
 * Data sizes and transfer rates, converted exactly. Every quantity is a
 * fraction of two BigInts counted in bits (or bits per second, or seconds), so
 * 5 TB at 1 Gbps comes out at exactly 40,000 seconds and 1 TiB at exactly
 * 1,099.511627776 GB; rounding happens once, when a number is printed.
 *
 * Units follow the standards: k, M, G, T, P, E are powers of 1000 (SI), Ki,
 * Mi, Gi… powers of 1024 (IEC); b is a bit and B a byte. Text typed by people
 * does not always follow them, so the reader is forgiving — `mbps` is
 * megabits per second, `500gb` five hundred gigabytes — and says so.
 */

import type { Both, Lang } from "../data/i18n";
import { parseTimespanExact } from "./timespan";

const both = (en: string, vi: string): Both => ({ en, vi });

/* ----------------------------------------------------------------- fractions */

/** n / d, reduced, with d > 0. */
export interface Ratio {
  readonly n: bigint;
  readonly d: bigint;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function ratio(n: bigint, d = 1n): Ratio {
  if (d === 0n) throw new RangeError("division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

export const mul = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.n, a.d * b.d);
export const div = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.d, a.d * b.n);
export const add = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.d + b.n * a.d, a.d * b.d);
export const compare = (a: Ratio, b: Ratio): number => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
};
export const isZero = (a: Ratio): boolean => a.n === 0n;
export const toNumber = (a: Ratio): number => Number(a.n) / Number(a.d);

const TEN = 10n;
const digitsOf = (x: bigint): number => abs(x).toString().length;

/**
 * The value in decimal, at most `significant` significant digits, rounded
 * half up, trailing zeros dropped — and whether that is exact. Plain digits:
 * "." before the fraction, no grouping.
 */
export function toDecimal(value: Ratio, significant = 12): { text: string; exact: boolean } {
  if (value.n === 0n) return { text: "0", exact: true };
  const negative = value.n < 0n;
  const n = abs(value.n);
  const d = value.d;
  // e: how many digits stand before the decimal point (0 or less for 0.0…).
  let e: number;
  if (n >= d) e = digitsOf(n / d);
  else {
    let j = 1;
    while (n * TEN ** BigInt(j) < d) j += 1;
    e = 1 - j;
  }
  const scale = (k: number): { q: bigint; exact: boolean } => {
    if (k >= 0) {
      const top = n * TEN ** BigInt(k);
      return { q: (top * 2n + d) / (2n * d), exact: top % d === 0n };
    }
    const bottom = d * TEN ** BigInt(-k);
    return { q: (n * 2n + bottom) / (2n * bottom), exact: n % bottom === 0n };
  };
  let { q, exact } = scale(significant - e);
  if (digitsOf(q) > significant) {
    // 9.99… rounded up a digit: one more before the point.
    e += 1;
    ({ q, exact } = scale(significant - e));
  }
  const digits = q.toString();
  let text: string;
  if (e <= 0) text = `0.${"0".repeat(-e)}${digits}`;
  else if (e >= digits.length) text = digits + "0".repeat(e - digits.length);
  else text = `${digits.slice(0, e)}.${digits.slice(e)}`;
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return { text: negative ? `-${text}` : text, exact };
}

/** Thousands grouped and the decimal mark placed as each language writes them: 1,234.5 or 1.234,5. */
export function groupDigits(plain: string, lang: Lang): string {
  const [whole = "", fraction] = plain.replace(/^-/, "").split(".");
  const separator = lang === "vi" ? "." : ",";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  const sign = plain.startsWith("-") ? "-" : "";
  return fraction === undefined ? sign + grouped : `${sign}${grouped}${lang === "vi" ? "," : "."}${fraction}`;
}

/** A number for the page: grouped, rounded to `significant` digits, with ≈ when it was rounded. */
export function formatNumber(value: Ratio, lang: Lang, significant = 9): string {
  const { text, exact } = toDecimal(value, significant);
  return `${exact ? "" : "≈ "}${groupDigits(text, lang)}`;
}

/* --------------------------------------------------------------------- units */

export type Family = "decimal" | "binary" | "bit";

export interface DataUnit {
  /** As the page writes it: GB, GiB, Gb. */
  readonly symbol: string;
  /** One of it, in bits. */
  readonly bits: bigint;
  readonly family: Family;
  readonly name: Both;
}

const K = 1000n;
const KI = 1024n;

export const SIZE_UNITS: readonly DataUnit[] = [
  { symbol: "B", bits: 8n, family: "decimal", name: both("byte", "byte") },
  { symbol: "kB", bits: 8n * K, family: "decimal", name: both("kilobyte", "kilobyte") },
  { symbol: "MB", bits: 8n * K ** 2n, family: "decimal", name: both("megabyte", "megabyte") },
  { symbol: "GB", bits: 8n * K ** 3n, family: "decimal", name: both("gigabyte", "gigabyte") },
  { symbol: "TB", bits: 8n * K ** 4n, family: "decimal", name: both("terabyte", "terabyte") },
  { symbol: "PB", bits: 8n * K ** 5n, family: "decimal", name: both("petabyte", "petabyte") },
  { symbol: "EB", bits: 8n * K ** 6n, family: "decimal", name: both("exabyte", "exabyte") },
  { symbol: "KiB", bits: 8n * KI, family: "binary", name: both("kibibyte", "kibibyte") },
  { symbol: "MiB", bits: 8n * KI ** 2n, family: "binary", name: both("mebibyte", "mebibyte") },
  { symbol: "GiB", bits: 8n * KI ** 3n, family: "binary", name: both("gibibyte", "gibibyte") },
  { symbol: "TiB", bits: 8n * KI ** 4n, family: "binary", name: both("tebibyte", "tebibyte") },
  { symbol: "PiB", bits: 8n * KI ** 5n, family: "binary", name: both("pebibyte", "pebibyte") },
  { symbol: "EiB", bits: 8n * KI ** 6n, family: "binary", name: both("exbibyte", "exbibyte") },
  { symbol: "bit", bits: 1n, family: "bit", name: both("bit", "bit") },
  { symbol: "kbit", bits: K, family: "bit", name: both("kilobit", "kilobit") },
  { symbol: "Mbit", bits: K ** 2n, family: "bit", name: both("megabit", "megabit") },
  { symbol: "Gbit", bits: K ** 3n, family: "bit", name: both("gigabit", "gigabit") },
  { symbol: "Tbit", bits: K ** 4n, family: "bit", name: both("terabit", "terabit") },
  { symbol: "Pbit", bits: K ** 5n, family: "bit", name: both("petabit", "petabit") },
];

export const RATE_UNITS: readonly DataUnit[] = [
  { symbol: "bit/s", bits: 1n, family: "bit", name: both("bit per second", "bit mỗi giây") },
  { symbol: "kbit/s", bits: K, family: "bit", name: both("kilobit per second", "kilobit mỗi giây") },
  { symbol: "Mbit/s", bits: K ** 2n, family: "bit", name: both("megabit per second", "megabit mỗi giây") },
  { symbol: "Gbit/s", bits: K ** 3n, family: "bit", name: both("gigabit per second", "gigabit mỗi giây") },
  { symbol: "Tbit/s", bits: K ** 4n, family: "bit", name: both("terabit per second", "terabit mỗi giây") },
  { symbol: "B/s", bits: 8n, family: "decimal", name: both("byte per second", "byte mỗi giây") },
  { symbol: "kB/s", bits: 8n * K, family: "decimal", name: both("kilobyte per second", "kilobyte mỗi giây") },
  { symbol: "MB/s", bits: 8n * K ** 2n, family: "decimal", name: both("megabyte per second", "megabyte mỗi giây") },
  { symbol: "GB/s", bits: 8n * K ** 3n, family: "decimal", name: both("gigabyte per second", "gigabyte mỗi giây") },
  { symbol: "TB/s", bits: 8n * K ** 4n, family: "decimal", name: both("terabyte per second", "terabyte mỗi giây") },
  { symbol: "KiB/s", bits: 8n * KI, family: "binary", name: both("kibibyte per second", "kibibyte mỗi giây") },
  { symbol: "MiB/s", bits: 8n * KI ** 2n, family: "binary", name: both("mebibyte per second", "mebibyte mỗi giây") },
  { symbol: "GiB/s", bits: 8n * KI ** 3n, family: "binary", name: both("gibibyte per second", "gibibyte mỗi giây") },
  { symbol: "TiB/s", bits: 8n * KI ** 4n, family: "binary", name: both("tebibyte per second", "tebibyte mỗi giây") },
];

export const sizeUnit = (symbol: string): DataUnit => SIZE_UNITS.find((unit) => unit.symbol === symbol)!;
export const rateUnit = (symbol: string): DataUnit => RATE_UNITS.find((unit) => unit.symbol === symbol)!;

/** A unit's name for a count of it, in English plural where the count is not 1: 5 terabytes, 1 gigabit per second. */
export function unitName(unit: DataUnit, count: Ratio, lang: Lang): string {
  const name = unit.name[lang];
  if (lang === "vi" || (count.n === count.d)) return name;
  const space = name.indexOf(" ");
  return space < 0 ? `${name}s` : `${name.slice(0, space)}s${name.slice(space)}`;
}

/** How many of `unit` make `bits`. */
export const inUnit = (bits: Ratio, unit: DataUnit): Ratio => div(bits, ratio(unit.bits));

/** The largest unit of a family that still gives at least 1, for a readable size. */
export function bestUnit(bits: Ratio, family: Family, units: readonly DataUnit[] = SIZE_UNITS): DataUnit {
  const candidates = units.filter((unit) => unit.family === family);
  let best = candidates[0]!;
  for (const unit of candidates) if (compare(inUnit(bits, unit), ratio(1n)) >= 0) best = unit;
  return best;
}

/** "1.5 TB": a size in its best unit of a family. */
export function formatAmount(bits: Ratio, family: Family, lang: Lang, units: readonly DataUnit[] = SIZE_UNITS, significant = 4): string {
  const unit = bestUnit(bits, family, units);
  return `${formatNumber(inUnit(bits, unit), lang, significant)} ${unit.symbol}`;
}

/* ------------------------------------------------------------------- numbers */

/**
 * A number as people type it: 5, 1.5, 1,5, 1 000, 1,000.5, 1.000,5, 2.5e3.
 * One "." or "," followed by exactly three digits is a thousands separator in
 * the page's language — 1,000 in English, 1.000 in Vietnamese — and a decimal
 * mark otherwise.
 */
export function parseNumber(text: string, lang: Lang): Ratio | null {
  let t = text.trim().replace(/[\s_  ']/g, "");
  if (t === "") return null;
  const exponentMatch = /[eE]([+-]?\d+)$/.exec(t);
  let exponent = 0;
  if (exponentMatch) {
    exponent = Number(exponentMatch[1]);
    if (Math.abs(exponent) > 60) return null;
    t = t.slice(0, exponentMatch.index);
  }
  if (!/^[+]?[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  t = t.replace(/^\+/, "");
  const dots = (t.match(/\./g) ?? []).length;
  const commas = (t.match(/,/g) ?? []).length;
  let decimalMark: "." | "," | null = null;
  if (dots > 0 && commas > 0) decimalMark = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
  else if (dots + commas === 1) {
    const mark = dots === 1 ? "." : ",";
    const [whole = "", fraction = ""] = t.split(mark);
    const thousands = fraction.length === 3 && whole.length >= 1 && whole.length <= 3 && !/^0/.test(whole) && mark === (lang === "vi" ? "." : ",");
    decimalMark = thousands ? null : mark;
  } else if (dots > 1 && commas === 0) decimalMark = null;
  else if (commas > 1 && dots === 0) decimalMark = null;
  const thousandsMark = decimalMark === "." ? "," : decimalMark === "," ? "." : dots > 0 ? "." : ",";
  // Thousands separators must sit between groups of three.
  const [whole = "", fraction = ""] = decimalMark === null ? [t, ""] : [t.slice(0, t.lastIndexOf(decimalMark)), t.slice(t.lastIndexOf(decimalMark) + 1)];
  if (whole.includes(thousandsMark) && !new RegExp(`^\\d{1,3}(\\${thousandsMark}\\d{3})+$`).test(whole)) return null;
  if (/[.,]/.test(fraction)) return null;
  const digits = whole.split(thousandsMark).join("");
  if (digits === "" && fraction === "") return null;
  let value = ratio(BigInt(`${digits || "0"}${fraction}`), TEN ** BigInt(fraction.length));
  if (exponent > 0) value = mul(value, ratio(TEN ** BigInt(exponent)));
  if (exponent < 0) value = div(value, ratio(TEN ** BigInt(-exponent)));
  return value;
}

/* ---------------------------------------------------------------- quantities */

export type Kind = "size" | "rate" | "time";

export interface Quantity {
  readonly kind: Kind;
  /** Bits, bits per second, or seconds. */
  readonly value: Ratio;
  /** The unit it was written in; null for a time. */
  readonly unit: DataUnit | null;
  /** The text it was read from. */
  readonly source: string;
  /** How an ambiguous unit was read, when it was. */
  readonly note: Both | null;
}

const PREFIXES: Readonly<Record<string, { power: number; binary: boolean }>> = {
  "": { power: 0, binary: false },
  k: { power: 1, binary: false },
  m: { power: 2, binary: false },
  g: { power: 3, binary: false },
  t: { power: 4, binary: false },
  p: { power: 5, binary: false },
  e: { power: 6, binary: false },
  ki: { power: 1, binary: true },
  mi: { power: 2, binary: true },
  gi: { power: 3, binary: true },
  ti: { power: 4, binary: true },
  pi: { power: 5, binary: true },
  ei: { power: 6, binary: true },
};

const PREFIX_NAME = ["", "kilo", "mega", "giga", "tera", "peta", "exa"];
const BINARY_NAME = ["", "kibi", "mebi", "gibi", "tebi", "pebi", "exbi"];

/**
 * A data unit as people write it — GB, GiB, Gb, Gbit, gigabytes, Mbps, MB/s,
 * MBps, mbps — as its size in bits and whether it is a rate. Null if it is
 * not one.
 */
export function parseUnit(text: string): { bits: bigint; rate: boolean; bytes: boolean; note: Both | null; symbol: string } | null {
  let t = text.trim().replace(/\s+/g, " ");
  if (t === "") return null;
  // The rate part: /s, /sec, ps, per second, /giây, mỗi giây.
  let rate = false;
  const perSecond = /(?:\s*\/\s*(?:s|sec|second|giây)|\s+per\s+(?:s|sec|second)|\s+mỗi\s+giây|\s*\/\s*giay)$/i.exec(t);
  if (perSecond) {
    rate = true;
    t = t.slice(0, perSecond.index);
  } else if (/ps$/i.test(t) && t.length > 2) {
    rate = true;
    t = t.slice(0, -2);
  }
  t = t.trim();
  // Spelled out: gigabytes, megabits, bytes, bits.
  const word = /^(kilo|mega|giga|tera|peta|exa|kibi|mebi|gibi|tebi|pebi|exbi)?(bytes?|bits?)$/i.exec(t);
  let prefix: string;
  let bytes: boolean;
  let note: Both | null = null;
  if (word) {
    const spelled = (word[1] ?? "").toLowerCase();
    const index = PREFIX_NAME.indexOf(spelled) >= 0 ? PREFIX_NAME.indexOf(spelled) : BINARY_NAME.indexOf(spelled);
    prefix = spelled === "" ? "" : BINARY_NAME.includes(spelled) ? `${"kmgtpe"[index - 1]}i` : "kmgtpe"[index - 1]!;
    bytes = /^byte/i.test(word[2]!);
  } else {
    const symbol = /^([kKmMgGtTpPeE]i?)?(bit|Bit|b|B|o)$/.exec(t);
    if (!symbol) return null;
    prefix = (symbol[1] ?? "").toLowerCase();
    const letter = symbol[2]!;
    if (letter === "bit" || letter === "Bit") bytes = false;
    else if (letter === "B" || letter === "o") {
      bytes = true;
      if (symbol[1] === "K") {
        note = both(
          `${t} is read as 1000 bytes, the SI kilobyte (kB). Windows and RAM sizes often use KB for 1024 bytes — write KiB for that.`,
          `${t} được hiểu là 1000 byte, kilobyte theo SI (kB). Windows và dung lượng RAM thường dùng KB cho 1024 byte — khi đó hãy viết KiB.`,
        );
      }
    }
    else {
      // A lone lowercase b. By the standard it is a bit; in an all-lowercase
      // size people nearly always mean bytes (500gb), and in a rate bits (mbps).
      const lowercase = symbol[1] === undefined || symbol[1] === symbol[1].toLowerCase();
      if (!rate && lowercase && prefix !== "") {
        bytes = true;
        const info = PREFIXES[prefix]!;
        const name = (info.binary ? BINARY_NAME : PREFIX_NAME)[info.power]!;
        const head = info.binary ? `${prefix[0]!.toUpperCase()}i` : prefix === "k" ? "k" : prefix.toUpperCase();
        note = both(
          `${t} is read as ${name}bytes. By the standard b is a bit and B a byte: ${head}B for ${name}bytes, ${head}b for ${name}bits.`,
          `${t} được hiểu là ${name}byte. Theo chuẩn, b là bit và B là byte: ${head}B là ${name}byte, ${head}b là ${name}bit.`,
        );
      } else {
        bytes = false;
      }
    }
  }
  const info = PREFIXES[prefix];
  if (!info) return null;
  const base = info.binary ? KI : K;
  const bits = base ** BigInt(info.power) * (bytes ? 8n : 1n);
  const canonical = info.binary
    ? `${prefix[0]!.toUpperCase()}i${bytes ? "B" : "bit"}`
    : `${prefix === "k" ? "k" : prefix.toUpperCase()}${bytes ? "B" : "bit"}`;
  return { bits, rate, bytes, note, symbol: rate ? `${canonical}/s` : canonical };
}

const TIME_WORDS: readonly [RegExp, string][] = [
  [/giờ|gio\b|tiếng/gi, "h"],
  [/phút|phut\b/gi, "min"],
  [/giây|giay\b/gi, "s"],
  [/ngày|ngay\b/gi, "d"],
  [/tuần|tuan\b/gi, "w"],
  [/tháng|thang\b/gi, "month"],
  [/năm|nam\b/gi, "y"],
  [/\bhrs?\b/gi, "h"],
  [/\bmins?\b/gi, "min"],
  [/\bsecs?\b/gi, "s"],
];

/** A duration, read as systemd reads time spans — 2h, 1h 30min, 90 min, 3 days — or in Vietnamese words. Seconds, or null. */
export function parseDuration(text: string): Ratio | null {
  let t = text.trim();
  if (t === "" || !/\d/.test(t)) return null;
  for (const [pattern, unit] of TIME_WORDS) t = t.replace(pattern, unit);
  t = t.replace(/(\d),(\d)/g, "$1.$2");
  // A bare clock-like 1:30:00.
  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(t);
  if (clock) return ratio(BigInt(clock[1]!) * 3600n + BigInt(clock[2]!) * 60n + BigInt(clock[3] ?? 0));
  if (!/[a-z]/i.test(t)) return null;
  const us = parseTimespanExact(t);
  if (us === null || us === "infinity" || us === 0n) return null;
  return ratio(us, 1_000_000n);
}

/**
 * One quantity: a number and a unit, `5 TB`, `1Gbps`, `100 MiB/s`, or a
 * duration, `2h 30min`, `3 ngày`.
 */
export function parseQuantity(text: string, lang: Lang): Quantity | null {
  const source = text.trim();
  const match = /^([+]?[\d.,\s_' ]*\d(?:[eE][+-]?\d+)?)\s*([^\d\s].*)$/.exec(source);
  if (match) {
    const number = parseNumber(match[1]!, lang);
    const unit = parseUnit(match[2]!);
    if (number !== null && unit !== null) {
      const known = (unit.rate ? RATE_UNITS : SIZE_UNITS).find((candidate) => candidate.symbol === unit.symbol) ?? null;
      return { kind: unit.rate ? "rate" : "size", value: mul(number, ratio(unit.bits)), unit: known, source, note: unit.note };
    }
  }
  const duration = parseDuration(source);
  return duration === null ? null : { kind: "time", value: duration, unit: null, source, note: null };
}

/* ---------------------------------------------------------------- transfers */

/** How much of a link's rate carries data. */
export interface Efficiency {
  readonly id: string;
  readonly share: Ratio;
  readonly name: Both;
}

/**
 * TCP over Ethernet with a 1500-byte MTU: each frame spends 38 bytes on the
 * wire (preamble, header, checksum, gap) and 52 on IPv4 and TCP with
 * timestamps, as Linux sends them, so 1448 of every 1538 bytes are data.
 */
export const EFFICIENCIES: readonly Efficiency[] = [
  { id: "line", share: ratio(1n), name: both("Line rate — every bit is data", "Tốc độ đường truyền — mọi bit đều là dữ liệu") },
  { id: "tcp", share: ratio(1448n, 1538n), name: both("TCP over Ethernet, MTU 1500 — 94.1%", "TCP qua Ethernet, MTU 1500 — 94,1%") },
  { id: "90", share: ratio(9n, 10n), name: both("90% — a busy or long-distance link", "90% — đường truyền đông hoặc ở xa") },
  { id: "80", share: ratio(4n, 5n), name: both("80% — Wi-Fi or a shared line", "80% — Wi-Fi hoặc đường truyền dùng chung") },
];

/** Seconds to move `bits` at `bitsPerSecond`, of which `share` carries data. */
export const transferTime = (bits: Ratio, bitsPerSecond: Ratio, share: Ratio = ratio(1n)): Ratio => div(bits, mul(bitsPerSecond, share));
/** The line rate that moves `bits` in `seconds`. */
export const rateFor = (bits: Ratio, seconds: Ratio, share: Ratio = ratio(1n)): Ratio => div(bits, mul(seconds, share));
/** Bits moved in `seconds` at `bitsPerSecond`. */
export const sizeFor = (bitsPerSecond: Ratio, seconds: Ratio, share: Ratio = ratio(1n)): Ratio => mul(mul(bitsPerSecond, seconds), share);

/* ----------------------------------------------------------------- durations */

const SECOND_UNITS: readonly { seconds: bigint; en: string; vi: string; long: Both }[] = [
  { seconds: 86_400n, en: "d", vi: "ngày", long: both("days", "ngày") },
  { seconds: 3600n, en: "h", vi: "giờ", long: both("hours", "giờ") },
  { seconds: 60n, en: "min", vi: "phút", long: both("minutes", "phút") },
  { seconds: 1n, en: "s", vi: "giây", long: both("seconds", "giây") },
];

/**
 * 40,000 seconds as "11 h 6 min 40 s" — to the second, or to the millisecond
 * under a minute.
 */
export function formatDuration(seconds: Ratio, lang: Lang): string {
  if (isZero(seconds)) return lang === "vi" ? "0 giây" : "0 s";
  if (compare(seconds, ratio(1n, 1000n)) < 0) return `${formatNumber(mul(seconds, ratio(1_000_000n)), lang, 3)} µs`;
  if (compare(seconds, ratio(1n)) < 0) return `${formatNumber(mul(seconds, ratio(1000n)), lang, 3)} ms`;
  if (compare(seconds, ratio(60n)) < 0) {
    const ms = (seconds.n * 1000n * 2n + seconds.d) / (2n * seconds.d);
    const whole = ms / 1000n;
    const rest = ms % 1000n;
    const unit = lang === "vi" ? "giây" : "s";
    if (rest === 0n) return `${whole} ${unit}`;
    return `${whole}${lang === "vi" ? "," : "."}${rest.toString().padStart(3, "0").replace(/0+$/, "")} ${unit}`;
  }
  let left = (seconds.n * 2n + seconds.d) / (2n * seconds.d);
  const parts: string[] = [];
  for (const unit of SECOND_UNITS) {
    const count = left / unit.seconds;
    left -= count * unit.seconds;
    if (count > 0n) parts.push(`${groupDigits(count.toString(), lang)} ${lang === "vi" ? unit.vi : unit.en}`);
  }
  return parts.join(" ");
}

/** "≈ 11.1 hours": the duration in its largest whole unit, to three significant digits. */
export function approximateDuration(seconds: Ratio, lang: Lang): string {
  const unit = SECOND_UNITS.find((candidate) => compare(seconds, ratio(candidate.seconds)) >= 0) ?? SECOND_UNITS[SECOND_UNITS.length - 1]!;
  if (compare(seconds, ratio(1n)) < 0) return `${formatNumber(mul(seconds, ratio(1000n)), lang, 3)} ms`;
  const value = div(seconds, ratio(unit.seconds));
  const { text, exact } = toDecimal(value, 3);
  return `${exact ? "" : "≈ "}${groupDigits(text, lang)} ${unit.long[lang]}`;
}

/* ------------------------------------------------------------- one-line asks */

export type QuickAnswer =
  | { readonly kind: "size"; readonly size: Quantity; readonly target: DataUnit | null }
  | { readonly kind: "rate"; readonly rate: Quantity; readonly target: DataUnit | null }
  | { readonly kind: "time"; readonly size: Quantity; readonly rate: Quantity }
  | { readonly kind: "rate-needed"; readonly size: Quantity; readonly time: Quantity }
  | { readonly kind: "size-moved"; readonly rate: Quantity; readonly time: Quantity };

/** Words and marks between the parts of a question: 5 TB @ 1 Gbps, 1 TB in 2 h, 10 Gbps for a day, 5 TB to GiB. */
const JOINERS =
  /\s*(?:@|→|->|=>|=)\s*|\s+\/\s+|,\s+|\s+(?:at|over|with|via|in|into|for|to|takes?|qua|với|trong|sang|thành|ra|bằng|ở|để|cần|mất|là|tốc\s+độ|in\s+about)\s+/giu;

/**
 * A question in one line: a size and a speed give the time, a size and a
 * time the speed needed, a speed and a time what it moves, and a size or a
 * speed with a unit after it is converted to that unit. English or
 * Vietnamese joining words both work.
 */
export function parseQuick(text: string, lang: Lang): QuickAnswer | { readonly error: Both } {
  const cleaned = text.trim().replace(/[?？]+$/, "").trim();
  if (cleaned === "") return { error: both("Type a size, a speed, or both.", "Hãy nhập một dung lượng, một tốc độ, hoặc cả hai.") };
  const pieces = cleaned.split(JOINERS).map((piece) => piece.trim()).filter((piece) => piece !== "");
  const quantities: Quantity[] = [];
  let target: { unit: DataUnit; rate: boolean } | null = null;
  for (const piece of pieces) {
    const quantity = parseQuantity(piece, lang);
    if (quantity) {
      quantities.push(quantity);
      continue;
    }
    const unit = parseUnit(piece);
    const known = unit ? ((unit.rate ? RATE_UNITS : SIZE_UNITS).find((candidate) => candidate.symbol === unit.symbol) ?? null) : null;
    if (known && target === null) {
      target = { unit: known, rate: unit!.rate };
      continue;
    }
    return {
      error: both(
        `“${piece}” is not a size, a speed or a time this page can read. Write a number with its unit — 5 TB, 1 Gbps, 100 MB/s, 2 h.`,
        `Trang không đọc được “${piece}” là dung lượng, tốc độ hay thời gian. Hãy viết một số kèm đơn vị — 5 TB, 1 Gbps, 100 MB/s, 2 giờ.`,
      ),
    };
  }
  const of = (kind: Kind) => quantities.filter((quantity) => quantity.kind === kind);
  const sizes = of("size");
  const rates = of("rate");
  const times = of("time");
  if (quantities.length === 1 && sizes.length === 1 && (target === null || !target.rate)) return { kind: "size", size: sizes[0]!, target: target?.unit ?? null };
  if (quantities.length === 1 && rates.length === 1 && (target === null || target.rate)) return { kind: "rate", rate: rates[0]!, target: target?.unit ?? null };
  if (quantities.length === 2 && target === null) {
    if (sizes.length === 1 && rates.length === 1) return { kind: "time", size: sizes[0]!, rate: rates[0]! };
    if (sizes.length === 1 && times.length === 1) return { kind: "rate-needed", size: sizes[0]!, time: times[0]! };
    if (rates.length === 1 && times.length === 1) return { kind: "size-moved", rate: rates[0]!, time: times[0]! };
  }
  if (target !== null && quantities.length === 1) {
    return {
      error: target.rate
        ? both(`${target.unit.symbol} is a speed, and ${quantities[0]!.source} is not: only speeds convert to it.`, `${target.unit.symbol} là đơn vị tốc độ, còn ${quantities[0]!.source} thì không: chỉ tốc độ mới đổi sang được.`)
        : both(`${target.unit.symbol} is a size, and ${quantities[0]!.source} is not: only sizes convert to it.`, `${target.unit.symbol} là đơn vị dung lượng, còn ${quantities[0]!.source} thì không: chỉ dung lượng mới đổi sang được.`),
    };
  }
  return {
    error: both(
      "Give one or two of a size, a speed and a time: 5 TB @ 1 Gbps, 1 TB in 2 h, 100 Mbps for 1 day, or 5 TB to GiB.",
      "Hãy cho một hoặc hai trong ba thứ: dung lượng, tốc độ và thời gian: 5 TB @ 1 Gbps, 1 TB trong 2 giờ, 100 Mbps trong 1 ngày, hoặc 5 TB sang GiB.",
    ),
  };
}

/** What a speed moves in an hour, a day and a 30-day month, in bits. */
export function volumes(bitsPerSecond: Ratio): readonly { readonly label: Both; readonly bits: Ratio }[] {
  return [
    { label: both("per minute", "mỗi phút"), bits: mul(bitsPerSecond, ratio(60n)) },
    { label: both("per hour", "mỗi giờ"), bits: mul(bitsPerSecond, ratio(3600n)) },
    { label: both("per day", "mỗi ngày"), bits: mul(bitsPerSecond, ratio(86_400n)) },
    { label: both("per 30 days", "mỗi 30 ngày"), bits: mul(bitsPerSecond, ratio(2_592_000n)) },
  ];
}
