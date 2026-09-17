/**
 * Unix time: parsing what the user pasted, and rendering it back in every form
 * an operator needs.
 *
 * Two decisions shape the whole file.
 *
 * The internal representation is **nanoseconds as a bigint**, not a JavaScript
 * number. A 19-digit nanosecond timestamp is larger than `Number.MAX_SAFE_INTEGER`,
 * so reading one through a double silently rounds it — by roughly 256 ns at
 * today's magnitudes. A tool whose whole job is to echo a number back cannot
 * afford to change it on the way through.
 *
 * Calendar arithmetic is done with `daysFromCivil`/`civilFromDays` rather than
 * the `Date` object. `Date` has a two-digit-year trap (`Date.UTC(99, 0, 1)` is
 * 1999, not year 99) and does its month arithmetic by mutation. The civil-days
 * pair is pure, exact for every proleptic Gregorian year, and testable without
 * a clock.
 */

export type EpochUnit = "seconds" | "milliseconds" | "microseconds" | "nanoseconds";
export type UnitChoice = EpochUnit | "auto";

export const EPOCH_UNITS: readonly EpochUnit[] = [
  "seconds",
  "milliseconds",
  "microseconds",
  "nanoseconds",
];

/** How many decimal digits separate one unit from a nanosecond. */
const NS_DIGITS: Record<EpochUnit, number> = {
  seconds: 9,
  milliseconds: 6,
  microseconds: 3,
  nanoseconds: 0,
};

const NS_PER_MS = 1_000_000n;

/** `new Date` accepts ±8.64e15 ms — 273,790 years either side of 1970. */
export const MAX_MS = 8.64e15;

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?\d+\.\d+$/;

/** Floor division. BigInt `/` truncates toward zero, which is wrong below 1970. */
function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

/** Remainder that is always in `[0, m)`, unlike JavaScript's `%`. */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Which unit a bare integer is in, guessed from its digit count.
 *
 * The boundaries are where "now" sits in each unit: a current timestamp is 10
 * digits in seconds, 13 in milliseconds, 16 in microseconds and 19 in
 * nanoseconds. Anything between two of those is read as the coarser unit,
 * because that is the reading that lands in a plausible year — 11 digits of
 * milliseconds is 1973, while 11 digits of seconds is the year 5138.
 *
 * It is a guess, which is why the page lets you override it.
 */
export function detectUnit(digits: number): EpochUnit {
  if (digits <= 10) return "seconds";
  if (digits <= 13) return "milliseconds";
  if (digits <= 16) return "microseconds";
  return "nanoseconds";
}

/**
 * Exact conversion of a decimal string in `unit` to nanoseconds.
 *
 * The decimal point is shifted by string concatenation rather than by
 * multiplying a float: `1699999999.123456 * 1e9` is not an integer in binary
 * floating point, but `"1699999999" + "123456000"` is exact by construction.
 */
function toNanos(text: string, unit: EpochUnit): { nanos: bigint; truncated: boolean } {
  const negative = text.startsWith("-");
  const body = text.replace(/^[+-]/, "");
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot + 1);

  const scale = NS_DIGITS[unit];
  const padded = (fraction + "0".repeat(scale)).slice(0, scale);
  const magnitude = BigInt(whole + padded);

  return {
    nanos: negative ? -magnitude : magnitude,
    truncated: fraction.length > scale,
  };
}

export interface Moment {
  /** Exact time as nanoseconds since 1970-01-01T00:00:00Z. */
  nanos: bigint;
  /** Whole milliseconds, floored — safe to hand to `new Date`. */
  ms: number;
  /** The unit the input was read in, or null when a date string was parsed. */
  unit: EpochUnit | null;
  /** One line explaining how the text was read, shown next to the input. */
  how: string;
}

/** `2026-09-17`, which the ECMAScript spec reads as midnight UTC. */
const DATE_ONLY = /^[+-]?\d{4,6}-\d{2}-\d{2}$/;
/** A trailing `Z` or `+07:00`, meaning the text names its own offset. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
/** `2026-09-17 14:03:22` — what SQL consoles and half the log formats print. */
const SQL_SHAPED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
/** The ISO calendar-date opening, which the ECMAScript spec defines exactly. */
const ISO_SHAPED = /^[+-]?\d{4,6}-\d{2}-\d{2}/;

/**
 * Reads a bare epoch number, a decimal epoch, or a date string.
 *
 * `choice` forces a unit for the numeric forms; `"auto"` defers to
 * {@link detectUnit}. Throws with a sentence meant to be shown to the user.
 */
export function parseMoment(text: string, choice: UnitChoice = "auto"): Moment {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Enter a timestamp or a date.");

  if (INTEGER.test(trimmed) || DECIMAL.test(trimmed)) {
    const fractional = DECIMAL.test(trimmed);
    const digits = trimmed.replace(/^[+-]/, "").split(".")[0]!.length;
    // A fractional epoch is seconds by convention — it is what `time.time()`,
    // `date +%s.%N` and every log format that emits one mean.
    const unit = choice === "auto" ? (fractional ? "seconds" : detectUnit(digits)) : choice;
    const { nanos, truncated } = toNanos(trimmed, unit);
    const ms = Number(floorDiv(nanos, NS_PER_MS));

    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) {
      throw new Error(
        `Read as ${unit}, that lands outside the range a date can hold — about 273,790 years either side of 1970. Try another unit.`,
      );
    }

    const why = choice === "auto" ? ` — ${digits} digit${digits === 1 ? "" : "s"}` : "";
    const lost = truncated ? ", finer digits dropped" : "";
    return { nanos, ms, unit, how: `read as ${unit}${why}${lost}` };
  }

  // Not a number, so it is a date — but `Date.parse` is far more willing than
  // it looks. V8 reads "1.2.3" as 2 January 2003 and "09/17/2026" as a
  // September date that Europeans would have written the other way round. Both
  // are guesses about what the user meant, and other engines guess differently.
  //
  // So anything with no letters in it has to declare itself with the ISO
  // calendar shape the spec actually defines. A version string, a partial IP
  // address or a slash-separated date gets an error instead of a silent
  // reinterpretation. Strings with letters — "17 Sep 2026", the RFC 2822 form
  // in an Apache log — still go through, because there is nothing ambiguous
  // about a spelled-out month.
  if (!/[a-z]/i.test(trimmed) && !ISO_SHAPED.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not an epoch number, and it is too ambiguous to read as a date — 1.2.3 and 09/17/2026 mean different things to different browsers. Write it as ISO 8601: 2026-09-17T14:03:22Z.`,
    );
  }

  // The space-separated form is the one shape worth repairing: the spec only
  // defines the `T` form, and browsers that accept the space do so by private
  // extension.
  const candidate = SQL_SHAPED.test(trimmed) ? trimmed.replace(" ", "T") : trimmed;

  const ms = Date.parse(candidate);
  if (Number.isNaN(ms)) {
    throw new Error(
      `"${trimmed}" is neither an epoch number nor a date this browser can read. ISO 8601 — 2026-09-17T14:03:22Z — always works.`,
    );
  }

  let how: string;
  if (DATE_ONLY.test(trimmed)) {
    how = "date only — midnight UTC, as the ECMAScript spec requires";
  } else if (HAS_ZONE.test(candidate)) {
    how = "date string — the text carried its own offset";
  } else {
    how = "date string with no offset — read in your local time zone";
  }

  return { nanos: BigInt(ms) * NS_PER_MS, ms, unit: null, how };
}

/** Every unit, exact, as decimal strings. */
export function unitStrings(nanos: bigint): Record<EpochUnit, string> {
  return {
    seconds: String(floorDiv(nanos, 1_000_000_000n)),
    milliseconds: String(floorDiv(nanos, 1_000_000n)),
    microseconds: String(floorDiv(nanos, 1_000n)),
    nanoseconds: String(nanos),
  };
}

/* ------------------------------------------------------------------- calendar */

/**
 * Days since 1970-01-01 for a proleptic Gregorian date.
 *
 * Howard Hinnant's `days_from_civil`. The March-based shifted year it works in
 * is what removes every leap-year special case: February lands at the end of
 * the year, so the extra day never falls in the middle of the arithmetic.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: month <= 2 ? y + 1 : y, month, day };
}

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** Monday is 0. 1970-01-01 was a Thursday, which is the `+ 3` below. */
export function weekdayIndex(year: number, month: number, day: number): number {
  return mod(daysFromCivil(year, month, day) + 3, 7);
}

export function dayOfYear(year: number, month: number, day: number): number {
  return daysFromCivil(year, month, day) - daysFromCivil(year, 1, 1) + 1;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * ISO 8601 week number, with the week-numbering year that goes with it.
 *
 * A week belongs to the year that owns its Thursday, so the first days of
 * January can fall in week 52 or 53 of the *previous* year — 2027-01-01 is week
 * 53 of 2026. That is the case log queries and payroll exports get wrong, which
 * is why the year is returned alongside the number rather than assumed.
 */
export function isoWeek(year: number, month: number, day: number): { year: number; week: number } {
  const days = daysFromCivil(year, month, day);
  const thursday = days - mod(days + 3, 7) + 3;
  const isoYear = civilFromDays(thursday).year;
  const jan4 = daysFromCivil(isoYear, 1, 4);
  const firstThursday = jan4 - mod(jan4 + 3, 7) + 3;
  return { year: isoYear, week: (thursday - firstThursday) / 7 + 1 };
}

/* ------------------------------------------------------------------ time zones */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `+07:00`, or `+00:00` for UTC. */
  offset: string;
}

/** Formatters are expensive to build and pure, so they are kept. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // `hour12: false` still renders midnight as 24 in some ICU builds; h23 is
      // the cycle that actually means "00 through 23".
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    FORMATTERS.set(timeZone, found);
  }
  return found;
}

/** ICU emits both `GMT+07:00` and a bare `GMT`; normalise to `+07:00`. */
function normaliseOffset(raw: string): string {
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(raw);
  if (!match) return "+00:00";
  return `${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}`;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Map(
    partsFormatter(timeZone)
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );

  const eraYear = Number(parts.get("year") ?? "1970");
  // Intl reports a positive year plus an era. Year 1 BC is astronomical year 0.
  const year = parts.get("era") === "BC" ? 1 - eraYear : eraYear;

  return {
    year,
    month: Number(parts.get("month") ?? "1"),
    day: Number(parts.get("day") ?? "1"),
    hour: Number(parts.get("hour") ?? "0"),
    minute: Number(parts.get("minute") ?? "0"),
    second: Number(parts.get("second") ?? "0"),
    offset: normaliseOffset(parts.get("timeZoneName") ?? "GMT"),
  };
}

const pad = (value: number, width = 2): string =>
  (value < 0 ? "-" : "") + String(Math.abs(value)).padStart(width, "0");

/** `2026-09-17 14:03:22 +07:00` — sortable, unambiguous, and safe to paste. */
export function formatZoned(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${p.offset}`
  );
}

/** The browser's own zone, or `UTC` where the runtime will not say. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const FALLBACK_ZONES: readonly string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Ho_Chi_Minh",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/**
 * The zones this runtime knows, always including UTC and the local one.
 * The list is read at runtime rather than baked at build time, because it is
 * the visitor's browser that has to be able to format them.
 */
export function availableZones(): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = [...FALLBACK_ZONES];
  return [...new Set(["UTC", localZone(), ...zones])].sort();
}

/* ------------------------------------------------------------ wall-clock time */

/** A reading off a wall clock: a date and a time, with no zone attached. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** `2026-09-17T14:03:22`, as a `datetime-local` input produces it; a space works too. */
const WALL = /^(\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a zone-less date and time. Every field is range-checked by name:
 * `2023-02-29` and `24:00` are refused rather than rolled over into the next
 * day, which is what `Date` would silently do with them.
 */
export function parseWallTime(text: string): WallTime {
  const match = WALL.exec(text.trim());
  if (!match) throw new Error("Enter a date and time as YYYY-MM-DD HH:MM:SS.");

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (month < 1 || month > 12) throw new Error(`There is no month ${month}.`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${pad(year, 4)}-${pad(month)} has no day ${day}.`);
  }
  if (hour > 23) throw new Error(`Hour ${hour} does not exist — the day ends at 23:59:59.`);
  if (minute > 59) throw new Error(`Minute ${minute} does not exist.`);
  // Unix time has no leap seconds (see the page), so :60 has nothing to map to.
  if (second > 59) throw new Error(`Second ${second} does not exist in Unix time.`);

  return { year, month, day, hour, minute, second };
}

/** `2026-09-17T14:03:22` — the exact shape a `datetime-local` input accepts. */
export function formatWallTime(wall: WallTime): string {
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
  );
}

/** What a wall clock in `timeZone` showed at `ms`. */
export function wallTimeAt(ms: number, timeZone: string): WallTime {
  const { year, month, day, hour, minute, second } = zonedParts(ms, timeZone);
  return { year, month, day, hour, minute, second };
}

/** The wall time read as if it were UTC — the "naive" instant. */
function naiveMs(wall: WallTime): number {
  return (
    daysFromCivil(wall.year, wall.month, wall.day) * 86_400_000 +
    wall.hour * 3_600_000 +
    wall.minute * 60_000 +
    wall.second * 1000
  );
}

/**
 * The zone's offset from UTC at `ms`, in milliseconds.
 *
 * Derived from the wall clock rather than by parsing ICU's `GMT+07:00` label,
 * because pre-standard local mean time carries seconds — Saigon was
 * +07:06:30 until 1906 — and the label rounds them away.
 */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const whole = ms - mod(ms, 1000);
  return naiveMs(wallTimeAt(whole, timeZone)) - whole;
}

/**
 * - `exact`: the wall time happens once.
 * - `gap`: clocks jumped forward over it, so it never happened.
 * - `overlap`: clocks went back over it, so it happened twice.
 */
export type WallResolution = "exact" | "gap" | "overlap";

export interface ZonedInstant {
  ms: number;
  resolution: WallResolution;
  /** For an overlap, the later of the two instants. Otherwise null. */
  later: number | null;
}

const DAY_MS = 86_400_000;

/**
 * The instant a wall clock in `timeZone` showed `wall`.
 *
 * The offsets a day either side are the only two a transition near this time
 * can be switching between, so each is tried and kept only if the zone
 * agrees it was in force at the resulting instant. One survivor is the normal
 * case; two means the hour repeated; none means it was skipped.
 *
 * Ambiguity is resolved the way Temporal's default `"compatible"` mode does
 * it — the earlier instant for a repeat, and a skipped time pushed forward by
 * the length of the gap — and the resolution is returned rather than hidden,
 * so the page can say which case it hit.
 */
export function wallTimeToMs(wall: WallTime, timeZone: string): ZonedInstant {
  const naive = naiveMs(wall);
  if (Math.abs(naive) > MAX_MS - 2 * DAY_MS) {
    throw new Error("That date is outside the range a date can hold.");
  }

  const before = zoneOffsetMs(naive - DAY_MS, timeZone);
  const after = zoneOffsetMs(naive + DAY_MS, timeZone);

  const valid = [...new Set([before, after])]
    .filter((offset) => zoneOffsetMs(naive - offset, timeZone) === offset)
    .map((offset) => naive - offset)
    .sort((a, b) => a - b);

  if (valid.length === 1) return { ms: valid[0]!, resolution: "exact", later: null };
  if (valid.length > 1) return { ms: valid[0]!, resolution: "overlap", later: valid[valid.length - 1]! };
  return { ms: naive - before, resolution: "gap", later: null };
}

/** True for text the epoch-to-date box should accept: a plain or fractional number. */
export function isEpochText(text: string): boolean {
  const trimmed = text.trim();
  return INTEGER.test(trimmed) || DECIMAL.test(trimmed);
}

/* ------------------------------------------------------------------- durations */

const RELATIVE_STEPS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 31_556_952_000],
  ["month", 2_629_746_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

export function relativeToNow(ms: number, now: number): string {
  const diff = ms - now;
  if (Math.abs(diff) < 1000) return "right now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= size) return format.format(Math.trunc(diff / size), unit);
  }
  return format.format(Math.trunc(diff / 1000), "second");
}

const SPAN_UNITS: readonly (readonly [string, number])[] = [
  ["year", 31_536_000],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** `90061` becomes `1 day 1 hour`. Two terms at most — it is a sanity check, not a stopwatch. */
export function formatSpan(seconds: number): string {
  if (seconds === 0) return "0 seconds";
  let left = Math.abs(Math.trunc(seconds));
  const terms: string[] = [];
  for (const [name, size] of SPAN_UNITS) {
    if (left < size || terms.length === 2) continue;
    const count = Math.floor(left / size);
    left -= count * size;
    terms.push(`${count} ${name}${count === 1 ? "" : "s"}`);
  }
  return (seconds < 0 ? "−" : "") + terms.join(" ");
}
