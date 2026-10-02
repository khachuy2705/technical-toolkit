/**
 * systemd calendar events — the value of a timer's OnCalendar= line — read
 * the way systemd reads them, written back in the normalised form
 * `systemd-analyze calendar` prints, said in English or Vietnamese, and
 * walked forward to the times they next elapse.
 *
 * The grammar is systemd.time(7), and the parser follows systemd's own
 * (src/shared/calendarspec.c, v259) rule for rule, because the behaviour
 * worth explaining is all in the details:
 *
 * 1. **A weekday and a date must both match.** `Fri *-*-13` is Friday the
 *    13th, where cron's `0 0 13 * 5` runs on every 13th and every Friday.
 * 2. **Lists are normalised before anything else.** A range is cut to the last
 *    value its step reaches (`08..18/3` becomes `08..17/3`), a step that can
 *    never fire twice is dropped, and the items are sorted and de-duplicated.
 *    The normalised form is what systemd stores and shows back.
 * 3. **Daylight saving is walked on the wall clock.** A time the clocks skip
 *    does not elapse at all that day, and a time that happens twice elapses
 *    once, at the first chance after the previous elapse. That is what
 *    systemd's search over `struct tm` amounts to, and it was pinned against
 *    `systemd-analyze calendar --base-time` around real transitions.
 *
 * systemd itself answers every mistake with "Invalid argument". Each refusal
 * here is a `CalendarError` that says what was wrong, in English and
 * Vietnamese, because the page that shows it is written in both.
 */

import type { Both, Lang } from "../data/i18n";
import type { CronField, CronTimes } from "./cron";
import { civilFromDays, daysFromCivil, daysInMonth, wallTimeAt, wallTimeToMs, zoneOffsetMs, zonedParts } from "./epoch";

/** An expression systemd would refuse. `text` says why, in both languages. */
export class CalendarError extends Error {
  override name = "CalendarError";
  constructor(
    readonly text: Both,
    /** Set when the input is a crontab schedule rather than a calendar event. */
    readonly cron = false,
  ) {
    super(text.en);
  }
}

function fail(en: string, vi: string, cron = false): never {
  throw new CalendarError({ en, vi }, cron);
}

/* --------------------------------------------------------------- the model */

/**
 * One comma-separated item of a field: `5`, `5..10`, `5..10/2` or `5/2`.
 * Seconds are counted in microseconds, which is how systemd stores them.
 */
export interface CalendarComponent {
  readonly start: number;
  /** -1 when the item has no end of its own. */
  readonly stop: number;
  /** 0 when the item does not repeat. */
  readonly repeat: number;
}

/** A whole field. `null` is `*`: every value. */
export type CalendarChain = readonly CalendarComponent[] | null;

export type CalendarField = "year" | "month" | "day" | "hour" | "minute" | "second";

export const CALENDAR_FIELDS: readonly CalendarField[] = ["year", "month", "day", "hour", "minute", "second"];

/** Microseconds in a second, and the last microsecond of a minute. */
const SEC = 1_000_000;
const LAST_US = 60 * SEC - 1;

export const MIN_YEAR = 1970;
export const MAX_YEAR = 2199;
/** systemd's CALENDARSPEC_COMPONENTS_MAX: the list items after the first. */
const MAX_ITEMS = 241;
const INT_MAX = 2_147_483_647;
/** Every weekday, Monday as bit 0. */
const ALL_DAYS = 127;

const RANGES: Readonly<Record<CalendarField, readonly [number, number]>> = {
  year: [MIN_YEAR, MAX_YEAR],
  month: [1, 12],
  day: [1, 31],
  hour: [0, 23],
  minute: [0, 59],
  second: [0, LAST_US],
};

/** Something reading the expression changed, which a note should mention. */
export type CalendarAdjustment =
  | { readonly kind: "year"; readonly written: number; readonly read: number }
  | { readonly kind: "cut"; readonly field: CalendarField; readonly written: string; readonly read: string }
  | { readonly kind: "single"; readonly field: CalendarField; readonly written: string; readonly read: string }
  | { readonly kind: "sorted"; readonly field: CalendarField };

export interface CalendarSpec {
  /** The expression as read, trimmed. */
  readonly text: string;
  /** `daily`, `weekly` and the rest, lower-cased, when the expression is one. */
  readonly shorthand: string | null;
  /** Seconds since the epoch, for the `@1767225600` form. */
  readonly epoch: number | null;
  /** Monday is bit 0 and Sunday bit 6. 0 means any day. */
  readonly weekdays: number;
  readonly year: CalendarChain;
  readonly month: CalendarChain;
  readonly day: CalendarChain;
  /** `~` before the day: days count back from the end of the month. */
  readonly endOfMonth: boolean;
  readonly hour: CalendarChain;
  readonly minute: CalendarChain;
  readonly second: CalendarChain;
  readonly utc: boolean;
  /** A time-zone name written at the end, which wins over the server's zone. */
  readonly zone: string | null;
  /** No time was written, so it is 00:00:00. */
  readonly timeOmitted: boolean;
  readonly adjustments: readonly CalendarAdjustment[];
  /** Exactly what `systemd-analyze calendar` prints as the normalized form. */
  readonly normalized: string;
}

/* ------------------------------------------------------------ zone names */

export type ZoneCheck =
  | { readonly status: "ok" }
  /** Valid, but an old name that some distributions no longer ship. */
  | { readonly status: "alias"; readonly current: string }
  /** The right zone in the wrong case — the server's lookup is case-sensitive. */
  | { readonly status: "case"; readonly suggestion: string | null }
  | { readonly status: "unknown" };

/**
 * IANA's backward links that people still write, with the name each points
 * to. Intl cannot answer this: browsers canonicalise to CLDR's identifiers,
 * which keep the old names — V8 resolves Asia/Ho_Chi_Minh *to* Asia/Saigon.
 */
export const ZONE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["Asia/Saigon", "Asia/Ho_Chi_Minh"],
  ["Asia/Calcutta", "Asia/Kolkata"],
  ["Asia/Katmandu", "Asia/Kathmandu"],
  ["Asia/Rangoon", "Asia/Yangon"],
  ["Asia/Dacca", "Asia/Dhaka"],
  ["Asia/Ujung_Pandang", "Asia/Makassar"],
  ["Europe/Kiev", "Europe/Kyiv"],
  ["US/Eastern", "America/New_York"],
  ["US/Central", "America/Chicago"],
  ["US/Mountain", "America/Denver"],
  ["US/Pacific", "America/Los_Angeles"],
  ["US/Alaska", "America/Anchorage"],
  ["US/Hawaii", "Pacific/Honolulu"],
  ["GB", "Europe/London"],
  ["Japan", "Asia/Tokyo"],
  ["PRC", "Asia/Shanghai"],
  ["ROK", "Asia/Seoul"],
  ["Singapore", "Asia/Singapore"],
  ["Hongkong", "Asia/Hong_Kong"],
  ["EST", "America/Panama"],
  ["MST", "America/Phoenix"],
  ["HST", "Pacific/Honolulu"],
  ["CET", "Europe/Brussels"],
  ["EET", "Europe/Athens"],
  ["MET", "Europe/Brussels"],
  ["WET", "Europe/Lisbon"],
  ["EST5EDT", "America/New_York"],
  ["CST6CDT", "America/Chicago"],
  ["MST7MDT", "America/Denver"],
  ["PST8PDT", "America/Los_Angeles"],
  ["GMT", "Etc/GMT"],
  ["UCT", "Etc/UTC"],
  ["Universal", "Etc/UTC"],
  ["Zulu", "Etc/UTC"],
]);

let knownZones: Map<string, string> | null = null;

/** Every correctly cased zone name we know of, keyed by its lower-case form. */
function knownZoneNames(): Map<string, string> {
  if (!knownZones) {
    knownZones = new Map();
    let listed: string[] = [];
    try {
      listed = Intl.supportedValuesOf("timeZone");
    } catch {
      listed = [];
    }
    for (const name of [...listed, ...ZONE_ALIASES.keys(), ...ZONE_ALIASES.values(), "UTC", "Etc/UTC"]) {
      knownZones.set(name.toLowerCase(), name);
    }
  }
  return knownZones;
}

/**
 * What the browser's zone database says about a name written in an
 * expression. The server looks the name up as a file under
 * /usr/share/zoneinfo, so case matters there even where Intl forgives it.
 */
export function checkZone(name: string): ZoneCheck {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
  } catch {
    return { status: "unknown" };
  }
  // Every segment of an IANA name starts with a capital: Asia/Ho_Chi_Minh, Etc/GMT-7, EST5EDT.
  if (name.split("/").some((part) => !/^[A-Z]/.test(part))) {
    const suggestion = knownZoneNames().get(name.toLowerCase()) ?? null;
    return { status: "case", suggestion: suggestion !== name ? suggestion : null };
  }
  const current = ZONE_ALIASES.get(name);
  return current === undefined ? { status: "ok" } : { status: "alias", current };
}

/* ------------------------------------------------------------ the reader */

interface Cursor {
  readonly s: string;
  i: number;
}

const at = (c: Cursor, k = 0): string => c.s[c.i + k] ?? "";
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

const DAY_NAMES: readonly (readonly [string, number])[] = [
  ["Monday", 0], ["Mon", 0], ["Tuesday", 1], ["Tue", 1], ["Wednesday", 2], ["Wed", 2],
  ["Thursday", 3], ["Thu", 3], ["Friday", 4], ["Fri", 4], ["Saturday", 5], ["Sat", 5],
  ["Sunday", 6], ["Sun", 6],
];

const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The day name at the cursor, case-insensitively, longest spelling first as systemd tries them. */
function dayNameAt(c: Cursor): readonly [string, number] | null {
  const rest = c.s.slice(c.i).toLowerCase();
  return DAY_NAMES.find(([name]) => rest.startsWith(name.toLowerCase())) ?? null;
}

function parseWeekdays(c: Cursor): number {
  let bits = 0;
  let rangeFrom = -1;
  let first = true;

  for (;;) {
    const found = dayNameAt(c);
    if (!found) {
      if (first) return 0;
      fail(
        `A day name must follow “${c.s.slice(0, c.i)}”. Weekdays are joined by commas with no spaces, as in Mon,Wed, and a space ends them.`,
        `Sau “${c.s.slice(0, c.i)}” phải là tên một thứ. Các thứ nối với nhau bằng dấu phẩy, không có dấu cách (như Mon,Wed), và một dấu cách kết thúc phần thứ.`,
      );
    }

    const [name, nr] = found;
    const after = at(c, name.length);
    if (!["", "-", ".", ",", " "].includes(after)) {
      const word = /^[A-Za-z]+/.exec(c.s.slice(c.i))?.[0] ?? name;
      fail(
        `“${word}” is not a day name. systemd takes the English names written in full or as three letters: ${SHORT_DAYS[nr]} or ${DAY_NAMES[nr * 2]![0]}.`,
        `“${word}” không phải tên thứ. systemd nhận tên tiếng Anh viết đủ hoặc ba chữ cái: ${SHORT_DAYS[nr]} hoặc ${DAY_NAMES[nr * 2]![0]}.`,
      );
    }

    bits |= 1 << nr;
    if (rangeFrom >= 0) {
      if (rangeFrom > nr) {
        const from = SHORT_DAYS[rangeFrom]!;
        const to = SHORT_DAYS[nr]!;
        const fix = nr === 0 ? `${from}..Sun,Mon` : `${from}..Sun,Mon..${to}`;
        fail(
          `“${from}..${to}” runs backwards: weekday ranges do not wrap round the end of the week. Write ${fix}.`,
          `“${from}..${to}” bị ngược: khoảng thứ không quay vòng qua cuối tuần. Hãy viết ${fix}.`,
        );
      }
      for (let d = rangeFrom + 1; d < nr; d += 1) bits |= 1 << d;
    }
    c.i += name.length;

    const sep = at(c);
    if (sep === "") return bits;
    if (sep === " ") {
      while (at(c) === " ") c.i += 1;
      const next = dayNameAt(c);
      if (next && ["", "-", ".", ",", " "].includes(at(c, next[0].length))) {
        fail(
          "Weekdays are listed with commas and no spaces, as in Mon,Tue. After a space, systemd expects the date or the time.",
          "Các thứ được liệt kê bằng dấu phẩy và không có dấu cách, như Mon,Tue. Sau dấu cách, systemd chờ phần ngày hoặc giờ.",
        );
      }
      return bits;
    }
    if (sep === ".") {
      if (at(c, 1) !== ".") {
        fail("A range is written with two dots: Mon..Fri.", "Khoảng được viết bằng hai dấu chấm: Mon..Fri.");
      }
      if (rangeFrom >= 0) {
        fail("A weekday range has one start and one end, as in Mon..Fri.", "Một khoảng thứ chỉ có một điểm đầu và một điểm cuối, như Mon..Fri.");
      }
      rangeFrom = nr;
      c.i += 2;
    } else if (sep === "-") {
      if (rangeFrom >= 0) {
        fail("A weekday range has one start and one end, as in Mon..Fri.", "Một khoảng thứ chỉ có một điểm đầu và một điểm cuối, như Mon..Fri.");
      }
      rangeFrom = nr;
      c.i += 1;
    } else if (sep === ",") {
      rangeFrom = -1;
      c.i += 1;
    }

    // A trailing comma is accepted; a range left open is not.
    if (at(c) === "" || at(c) === " ") {
      if (rangeFrom >= 0) {
        fail(
          `The range “${c.s.slice(0, c.i).trim()}” has no end. Write it as Mon..Fri.`,
          `Khoảng “${c.s.slice(0, c.i).trim()}” không có điểm cuối. Hãy viết như Mon..Fri.`,
        );
      }
      while (at(c) === " ") c.i += 1;
      if (dayNameAt(c)) {
        fail(
          "Weekdays are listed with commas and no spaces, as in Mon,Tue. After a space, systemd expects the date or the time.",
          "Các thứ được liệt kê bằng dấu phẩy và không có dấu cách, như Mon,Tue. Sau dấu cách, systemd chờ phần ngày hoặc giờ.",
        );
      }
      return bits;
    }
    first = false;
  }
}

interface RawComponent {
  start: number;
  stop: number;
  repeat: number;
  text: string;
}

/** `null` stands for `*`. */
type RawChain = RawComponent[] | null;

const MONTH_WORDS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function notANumber(c: Cursor): never {
  const word = /^[^\s,:\-~./]+/.exec(c.s.slice(c.i))?.[0] ?? at(c);
  if (word === "") {
    fail(
      `The expression ends where a number was expected, after “${c.s}”.`,
      `Biểu thức kết thúc ở chỗ đáng lẽ phải có một con số, sau “${c.s}”.`,
    );
  }
  const month = MONTH_WORDS.indexOf(word.slice(0, 3).toLowerCase());
  if (month >= 0 && /^[a-z]+$/i.test(word)) {
    const n = String(month + 1).padStart(2, "0");
    fail(`Months are numbers in systemd: write ${n}, not ${word}.`, `systemd ghi tháng bằng số: hãy viết ${n}, không phải ${word}.`);
  }
  fail(
    `systemd cannot read “${word}” here. A calendar event is weekdays, then year-month-day, then hour:minute:second — for example Mon..Fri *-*-* 08:30:00.`,
    `systemd không đọc được “${word}” ở vị trí này. Biểu thức lịch gồm: thứ, rồi năm-tháng-ngày, rồi giờ:phút:giây — ví dụ Mon..Fri *-*-* 08:30:00.`,
  );
}

/** A decimal number; for seconds, microseconds, with up to six decimal places rounded at the seventh. */
function readNumber(c: Cursor, usec: boolean): number {
  if (!isDigit(at(c))) notANumber(c);
  const from = c.i;
  while (isDigit(at(c))) c.i += 1;
  const digits = c.s.slice(from, c.i);
  let value = Number(digits);

  if (usec) {
    value *= SEC;
    if (at(c) === "." && at(c, 1) !== ".") {
      c.i += 1;
      let count = 0;
      let fraction = 0;
      while (count < 6 && isDigit(at(c))) {
        fraction = fraction * 10 + Number(at(c));
        c.i += 1;
        count += 1;
      }
      if (count === 0) {
        fail(`“${digits}.” needs digits after the decimal point.`, `“${digits}.” cần có chữ số sau dấu thập phân.`);
      }
      for (; count < 6; count += 1) fraction *= 10;
      const seventh = at(c);
      if (seventh >= "5" && seventh <= "9") fraction += 1;
      while (isDigit(at(c))) c.i += 1;
      value += fraction;
    }
  }

  if (value > INT_MAX) fail(`${digits} is too large a number here.`, `${digits} là số quá lớn ở vị trí này.`);
  return value;
}

function readComponent(c: Cursor, usec: boolean): RawComponent {
  const from = c.i;
  const start = readNumber(c, usec);
  let stop = -1;
  let repeat = 0;

  if (at(c) === "." && at(c, 1) === ".") {
    c.i += 2;
    stop = readNumber(c, usec);
    repeat = usec ? SEC : 1;
  }

  if (at(c) === "/") {
    c.i += 1;
    repeat = readNumber(c, usec);
    if (repeat === 0) {
      const item = c.s.slice(from, c.i);
      fail(`“${item}” has a step of 0, which never moves on.`, `“${item}” có bước nhảy 0, nên không bao giờ tiến lên được.`);
    }
  } else if (usec && stop >= 0 && start + repeat > stop) {
    const item = c.s.slice(from, c.i);
    fail(
      `A range of seconds must span at least one whole second: “${item}”. To go finer, give it a step, as in 01..02/0.5.`,
      `Khoảng giây phải dài ít nhất một giây: “${item}”. Muốn chia nhỏ hơn thì ghi thêm bước nhảy, như 01..02/0.5.`,
    );
  }

  const next = at(c);
  if (!["", " ", ",", "-", "~", ":"].includes(next)) {
    const item = c.s.slice(from, c.i);
    if (next === "." && !usec) {
      fail(
        `Only seconds can have a fraction, as in 08:30:00.5 — “${item}.” is not a whole number.`,
        `Chỉ phần giây mới có số lẻ, như 08:30:00.5 — “${item}.” không phải số nguyên.`,
      );
    }
    if (next === "T" || next === "t") {
      fail(
        "Put a space between the date and the time: systemd does not read the T of ISO 8601.",
        "Hãy cách ngày và giờ bằng một dấu cách: systemd không đọc chữ T của ISO 8601.",
      );
    }
    fail(`“${next}” cannot follow “${item}” here.`, `Ký tự “${next}” không thể đứng sau “${item}” ở vị trí này.`);
  }
  return { start, stop, repeat, text: c.s.slice(from, c.i) };
}

function readChain(c: Cursor, usec: boolean): RawChain {
  if (at(c) === "*") {
    c.i += 1;
    return usec ? [{ start: 0, stop: -1, repeat: SEC, text: "*" }] : null;
  }
  const items = [readComponent(c, usec)];
  while (at(c) === ",") {
    if (items.length >= MAX_ITEMS) {
      fail(`A field can list at most ${MAX_ITEMS} items.`, `Mỗi trường chỉ liệt kê được tối đa ${MAX_ITEMS} mục.`);
    }
    c.i += 1;
    items.push(readComponent(c, usec));
  }
  return items;
}

const single = (value: number): RawComponent[] => [{ start: value, stop: -1, repeat: 0, text: String(value) }];

interface Draft {
  weekdays: number;
  year: RawChain;
  month: RawChain;
  day: RawChain;
  endOfMonth: boolean;
  hour: RawChain;
  minute: RawChain;
  second: RawChain;
  epoch: number | null;
  timeOmitted: boolean;
}

function emptyDraft(): Draft {
  return {
    weekdays: 0,
    year: null,
    month: null,
    day: null,
    endOfMonth: false,
    hour: null,
    minute: null,
    second: null,
    epoch: null,
    timeOmitted: false,
  };
}

function midnight(d: Draft): Draft {
  d.hour = single(0);
  d.minute = single(0);
  d.second = single(0);
  return d;
}

/** The named schedules, as systemd.time(7) lists them. */
export const SHORTHANDS: ReadonlyMap<string, () => Draft> = new Map<string, () => Draft>([
  ["minutely", () => ({ ...emptyDraft(), second: single(0) })],
  ["hourly", () => ({ ...emptyDraft(), minute: single(0), second: single(0) })],
  ["daily", () => midnight(emptyDraft())],
  ["weekly", () => ({ ...midnight(emptyDraft()), weekdays: 1 })],
  ["monthly", () => ({ ...midnight(emptyDraft()), day: single(1) })],
  ["quarterly", () => ({ ...midnight(emptyDraft()), month: [1, 4, 7, 10].flatMap(single), day: single(1) })],
  ["semiannually", () => ({ ...midnight(emptyDraft()), month: [1, 7].flatMap(single), day: single(1) })],
  ["yearly", () => ({ ...midnight(emptyDraft()), month: single(1), day: single(1) })],
]);

/** Other spellings systemd accepts for the same schedules. */
const SHORTHAND_ALIASES: ReadonlyMap<string, string> = new Map([
  ["annually", "yearly"],
  ["anually", "yearly"],
  ["biannually", "semiannually"],
  ["bi-annually", "semiannually"],
  ["semi-annually", "semiannually"],
]);

function parseDate(c: Cursor, d: Draft): boolean {
  if (at(c) === "") return false;

  if (at(c) === "@") {
    c.i += 1;
    const from = c.i;
    while (isDigit(at(c))) c.i += 1;
    if (c.i === from) {
      fail(
        "“@” must be followed by a Unix time in seconds, such as @1767225600.",
        "Sau “@” phải là một mốc Unix tính bằng giây, như @1767225600.",
      );
    }
    if (at(c) !== "") {
      fail(
        "A @timestamp names one whole moment, so nothing can follow it.",
        "Một @timestamp đã là một thời điểm trọn vẹn, nên không gì được đứng sau nó.",
      );
    }
    const seconds = Number(c.s.slice(from, c.i));
    if (!(seconds < daysFromCivil(MAX_YEAR + 1, 1, 1) * 86_400)) {
      fail(
        `@${c.s.slice(from, c.i)} is after ${MAX_YEAR}, the last year systemd's calendar reaches.`,
        `@${c.s.slice(from, c.i)} rơi vào sau năm ${MAX_YEAR}, năm cuối cùng lịch của systemd đi tới.`,
      );
    }
    const days = Math.floor(seconds / 86_400);
    const rest = seconds - days * 86_400;
    const civil = civilFromDays(days);
    d.epoch = seconds;
    d.year = single(civil.year);
    d.month = single(civil.month);
    d.day = single(civil.day);
    d.hour = single(Math.floor(rest / 3600));
    d.minute = single(Math.floor((rest % 3600) / 60));
    d.second = single((rest % 60) * SEC);
    return true;
  }

  const restart = c.i;
  const first = readChain(c, false);
  // Followed by ":" or nothing, the first chain was the hour of a time, not a date.
  if (at(c) === "" || at(c) === ":") {
    c.i = restart;
    return false;
  }

  if (at(c) === "~") d.endOfMonth = true;
  else if (at(c) !== "-") fail(`“${at(c)}” cannot follow the date here.`, `Ký tự “${at(c)}” không thể đứng sau phần ngày.`);
  c.i += 1;
  const second = readChain(c, false);

  if (at(c) === "" || at(c) === " ") {
    while (at(c) === " ") c.i += 1;
    d.month = first;
    d.day = second;
    return false;
  }
  if (d.endOfMonth) {
    fail(
      "“~” marks the day, so it comes last in the date: *-02~03, not *~02-03.",
      "“~” đánh dấu phần ngày nên phải đứng cuối: *-02~03, không phải *~02-03.",
    );
  }

  if (at(c) === "~") d.endOfMonth = true;
  else if (at(c) !== "-") {
    if (at(c) === ":") {
      fail(
        "Put a space between the date and the time, as in *-*-* 08:30.",
        "Hãy cách ngày và giờ bằng một dấu cách, như *-*-* 08:30.",
      );
    }
    fail(`“${at(c)}” cannot follow the date here.`, `Ký tự “${at(c)}” không thể đứng sau phần ngày.`);
  }
  c.i += 1;
  const third = readChain(c, false);

  if (at(c) !== "" && at(c) !== " ") {
    if (at(c) === "-" || at(c) === "~") {
      fail("A date has three parts at most: year-month-day.", "Phần ngày có tối đa ba thành phần: năm-tháng-ngày.");
    }
    fail(
      "Put a space between the date and the time, as in *-*-* 08:30.",
      "Hãy cách ngày và giờ bằng một dấu cách, như *-*-* 08:30.",
    );
  }
  while (at(c) === " ") c.i += 1;
  d.year = first;
  d.month = second;
  d.day = third;
  return false;
}

function parseTime(c: Cursor, d: Draft): void {
  if (at(c) === "") {
    midnight(d);
    d.timeOmitted = true;
    return;
  }

  const hour = readChain(c, false);
  if (at(c) !== ":") {
    if (at(c) === "") {
      fail(
        `A time needs hours and minutes at least: write ${c.s.slice(c.s.lastIndexOf(" ") + 1)}:00, not ${c.s.slice(c.s.lastIndexOf(" ") + 1)}.`,
        `Giờ phải có ít nhất giờ và phút: hãy viết ${c.s.slice(c.s.lastIndexOf(" ") + 1)}:00, không phải ${c.s.slice(c.s.lastIndexOf(" ") + 1)}.`,
      );
    }
    trailing(c);
  }
  c.i += 1;
  const minute = readChain(c, false);

  let second: RawChain;
  if (at(c) === "") {
    second = single(0);
  } else if (at(c) === ":") {
    c.i += 1;
    second = readChain(c, true);
    if (at(c) === ":") {
      fail("A time has three parts at most: hour:minute:second.", "Phần giờ có tối đa ba thành phần: giờ:phút:giây.");
    }
    if (at(c) !== "") trailing(c);
  } else {
    trailing(c);
  }

  d.hour = hour;
  d.minute = minute;
  d.second = second;
}

/** Something after the time — usually a word in the wrong place. */
function trailing(c: Cursor): never {
  const rest = c.s.slice(c.i).trim();
  if (dayNameAt({ s: rest, i: 0 })) {
    fail(
      `“${rest}” comes after the time. The order is weekdays, then the date, then the time, then an optional time zone.`,
      `“${rest}” đứng sau phần giờ. Thứ tự đúng là: thứ, ngày, giờ, rồi múi giờ (nếu có).`,
    );
  }
  if (rest.includes("/") || /^[A-Za-z_]+$/.test(rest)) {
    fail(
      `“${rest}” is not a time zone this browser knows. Use a name from the IANA database, such as Asia/Ho_Chi_Minh, or UTC.`,
      `Trình duyệt không biết múi giờ “${rest}”. Hãy dùng tên trong cơ sở dữ liệu IANA, như Asia/Ho_Chi_Minh, hoặc UTC.`,
    );
  }
  fail(`systemd cannot read “${rest}” after the time.`, `systemd không đọc được “${rest}” sau phần giờ.`);
}

/* --------------------------------------------------------- normalising */

function componentText(comp: CalendarComponent, field: CalendarField): string {
  return formatChain([comp], field, false);
}

const compare = (a: CalendarComponent, b: CalendarComponent): number =>
  a.start - b.start || a.stop - b.stop || a.repeat - b.repeat;

/** systemd's normalize_chain, recording what it changed. */
function normalizeChain(raw: RawChain, field: CalendarField, notes: CalendarAdjustment[]): CalendarChain {
  if (raw === null) return null;
  const items: CalendarComponent[] = raw.map((item) => {
    let { start, stop, repeat } = item;
    const before: CalendarComponent = { start, stop, repeat };
    if (stop > start && repeat > 0) stop -= (stop - start) % repeat;
    if ((stop > start && repeat > 0 && start + repeat > stop) || start === stop) {
      repeat = 0;
      stop = -1;
      if (before.stop !== before.start || before.repeat > (field === "second" ? SEC : 1)) {
        notes.push({ kind: "single", field, written: componentText(before, field), read: componentText({ start, stop, repeat }, field) });
      }
    } else if (stop !== before.stop) {
      notes.push({ kind: "cut", field, written: componentText(before, field), read: componentText({ start, stop, repeat }, field) });
    }
    return { start, stop, repeat };
  });

  if (items.length <= 1) return items;
  const sorted = [...items].sort(compare);
  const unique = sorted.filter((item, index) => index === 0 || compare(item, sorted[index - 1]!) !== 0);
  if (unique.length !== items.length || unique.some((item, index) => item !== items[index])) {
    notes.push({ kind: "sorted", field });
  }
  return unique;
}

/** Two-digit years: 00–69 are 2000–2069, 70–99 are 1970–1999. */
function fixYear(raw: RawChain, notes: CalendarAdjustment[]): RawChain {
  if (raw === null) return null;
  const fix = (v: number): number => (v >= 0 && v < 70 ? v + 2000 : v >= 70 && v < 100 ? v + 1900 : v);
  return raw.map((item) => {
    const start = fix(item.start);
    const stop = item.stop >= 0 ? fix(item.stop) : item.stop;
    if (start !== item.start) notes.push({ kind: "year", written: item.start, read: start });
    if (stop !== item.stop) notes.push({ kind: "year", written: item.stop, read: stop });
    return { ...item, start, stop };
  });
}

const FIELD_NAME: Readonly<Record<CalendarField, Both>> = {
  year: { en: "year", vi: "năm" },
  month: { en: "month", vi: "tháng" },
  day: { en: "day", vi: "ngày" },
  hour: { en: "hour", vi: "giờ" },
  minute: { en: "minute", vi: "phút" },
  second: { en: "second", vi: "giây" },
};

function rangeText(field: CalendarField): Both {
  switch (field) {
    case "year":
      return {
        en: `Years run ${MIN_YEAR}–${MAX_YEAR} in systemd; a two-digit year 00–69 is read as 2000–2069, and 70–99 as 1970–1999.`,
        vi: `Năm trong systemd chạy từ ${MIN_YEAR} đến ${MAX_YEAR}; năm hai chữ số 00–69 được hiểu là 2000–2069, còn 70–99 là 1970–1999.`,
      };
    case "month":
      return { en: "Months run 01–12.", vi: "Tháng chạy từ 01 đến 12." };
    case "day":
      return { en: "Days run 01–31.", vi: "Ngày chạy từ 01 đến 31." };
    case "hour":
      return { en: "Hours run 00–23, and midnight is 00:00.", vi: "Giờ chạy từ 00 đến 23, và nửa đêm là 00:00." };
    case "minute":
      return { en: "Minutes run 00–59.", vi: "Phút chạy từ 00 đến 59." };
    case "second":
      return {
        en: "Seconds run 00–59, with up to six decimal places; there is no leap second 60.",
        vi: "Giây chạy từ 00 đến 59, có thể có tối đa sáu chữ số thập phân; không có giây nhuận 60.",
      };
  }
}

const show = (value: number, field: CalendarField): string =>
  field === "second" ? formatSeconds(value) : String(value).padStart(field === "year" ? 4 : 2, "0");

/** systemd's chain_valid, one sentence per way of failing it. */
function validateChain(chain: CalendarChain, field: CalendarField, endOfMonth: boolean): void {
  if (chain === null) return;
  const [from, rangeTo] = RANGES[field];
  const eom = endOfMonth && field === "day";
  const to = eom ? rangeTo - 3 : rangeTo;
  const name = FIELD_NAME[field];

  for (const comp of chain) {
    const item = componentText(comp, field);
    const outside = (value: number) => {
      if (eom) {
        fail(
          `With “~”, the day counts back from the end of the month, at most 28 days: ~01 is the last day and ~28 the 28th-to-last, so ~${show(value, "day")} is out of reach.`,
          `Với “~”, ngày được đếm ngược từ cuối tháng, tối đa 28 ngày: ~01 là ngày cuối cùng và ~28 là ngày thứ 28 tính từ cuối, nên ~${show(value, "day")} nằm ngoài phạm vi.`,
        );
      }
      const range = rangeText(field);
      fail(
        `${capitalise(name.en)} ${show(value, field)} does not exist. ${range.en}`,
        `Không có ${name.vi} ${show(value, field)}. ${range.vi}`,
      );
    };
    if (comp.start < from || comp.start > to) outside(comp.start);
    if (comp.repeat > to - from) {
      fail(
        `The step in “${item}” is longer than the whole ${name.en} field.`,
        `Bước nhảy trong “${item}” dài hơn cả trường ${name.vi}.`,
      );
    }
    if (comp.stop >= 0) {
      if (comp.stop < from || comp.stop > to) outside(comp.stop);
      if (comp.start + comp.repeat > comp.stop) {
        if (eom) {
          fail(
            `With “~”, write the smaller number first: ~${show(comp.stop, "day")}..${show(comp.start, "day")} rather than “~${item}”.`,
            `Với “~”, hãy viết số nhỏ trước: ~${show(comp.stop, "day")}..${show(comp.start, "day")} thay vì “~${item}”.`,
          );
        }
        fail(
          `“${item}” runs backwards. Ranges in systemd do not wrap round: write ${show(comp.stop, field)}..${show(comp.start, field)}, or two pieces joined by a comma.`,
          `“${item}” bị ngược. Khoảng trong systemd không quay vòng: hãy viết ${show(comp.stop, field)}..${show(comp.start, field)}, hoặc hai đoạn nối bằng dấu phẩy.`,
        );
      }
    } else if (eom && comp.start - comp.repeat < from) {
      fail(
        `“~${item}” steps past the last day of the month. With “~”, a step runs forward towards the month's end, so it needs room: ~07/1 is the last seven days.`,
        `“~${item}” bước quá ngày cuối tháng. Với “~”, bước nhảy chạy về phía cuối tháng nên cần có chỗ: ~07/1 là bảy ngày cuối tháng.`,
      );
    } else if (!eom && comp.start + comp.repeat > to) {
      const step = field === "second" ? formatSeconds(comp.repeat).replace(/^0(?=\d)/, "") : String(comp.repeat);
      const last = field === "second" ? "59" : show(to, field);
      fail(
        `“${item}” never repeats: ${show(comp.start, field)} plus ${step} is past ${last}, the last ${name.en}. systemd refuses a step that cannot fire twice — write ${show(comp.start, field)} on its own, or start lower.`,
        `“${item}” không bao giờ lặp lại: ${show(comp.start, field)} cộng ${step} đã vượt quá ${last}, ${name.vi} cuối cùng. systemd từ chối bước nhảy không thể kích hoạt lần thứ hai — hãy chỉ viết ${show(comp.start, field)}, hoặc bắt đầu thấp hơn.`,
      );
    }
  }
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/* ------------------------------------------------------- normalised text */

function formatSeconds(us: number): string {
  const whole = String(Math.floor(us / SEC)).padStart(2, "0");
  const fraction = us % SEC;
  return fraction > 0 ? `${whole}.${String(fraction).padStart(6, "0")}` : whole;
}

/** True when a seconds chain covers every second, which systemd prints as `*`. */
function secondsAreStar(chain: CalendarChain): boolean {
  return chain === null || chain.some((comp) => comp.start === 0 && comp.stop < 0 && comp.repeat === SEC);
}

/** systemd's format_chain. */
export function formatChain(chain: CalendarChain, field: CalendarField, star = true): string {
  if (chain === null) return "*";
  const usec = field === "second";
  if (usec && star && secondsAreStar(chain)) return "*";
  const width = field === "year" ? 4 : 2;
  const d = usec ? SEC : 1;
  const num = (value: number) => String(Math.floor(value / d)).padStart(width, "0");
  const frac = (value: number) => (value % d > 0 ? `.${String(value % d).padStart(6, "0")}` : "");

  return chain
    .map((comp) => {
      let text = num(comp.start) + frac(comp.start);
      if (comp.stop > 0) text += `..${num(comp.stop)}${frac(comp.stop)}`;
      if (comp.repeat > 0 && !(comp.stop > 0 && comp.repeat === d)) {
        text += `/${Math.floor(comp.repeat / d)}${frac(comp.repeat)}`;
      }
      return text;
    })
    .join(",");
}

/** `Mon..Wed,Fri` — runs of three or more days collapse, as systemd prints them. */
export function formatWeekdays(bits: number): string {
  const parts: string[] = [];
  let runStart = -1;
  for (let x = 0; x <= 7; x += 1) {
    const set = x < 7 && (bits & (1 << x)) !== 0;
    if (set && runStart < 0) runStart = x;
    if (!set && runStart >= 0) {
      const runEnd = x - 1;
      if (runEnd === runStart) parts.push(SHORT_DAYS[runStart]!);
      else if (runEnd === runStart + 1) parts.push(SHORT_DAYS[runStart]!, SHORT_DAYS[runEnd]!);
      else parts.push(`${SHORT_DAYS[runStart]}..${SHORT_DAYS[runEnd]}`);
      runStart = -1;
    }
  }
  return parts.join(",");
}

function formatSpec(spec: Omit<CalendarSpec, "normalized" | "text" | "adjustments" | "timeOmitted">): string {
  let text = spec.weekdays > 0 ? `${formatWeekdays(spec.weekdays)} ` : "";
  text += `${formatChain(spec.year, "year")}-${formatChain(spec.month, "month")}${spec.endOfMonth ? "~" : "-"}${formatChain(spec.day, "day")}`;
  text += ` ${formatChain(spec.hour, "hour")}:${formatChain(spec.minute, "minute")}:${formatChain(spec.second, "second")}`;
  if (spec.utc) text += " UTC";
  else if (spec.zone) text += ` ${spec.zone}`;
  return text;
}

/* ------------------------------------------------------------ reading */

/**
 * Five or more words of crontab field syntax. A calendar event has four
 * words at most — weekdays, date, time, zone — so this cannot be one.
 */
function looksLikeCron(text: string): boolean {
  const words = text.split(/\s+/).slice(0, 5);
  return (
    words.length === 5 &&
    words.every((word) => /^[\d*/,?#LWHa-z-]+$/i.test(word) && !word.includes("..")) &&
    words.filter((word) => /[\d*]/.test(word)).length >= 3
  );
}

/**
 * Reads a calendar event as systemd does. Throws `CalendarError` with the
 * reason, where systemd would only say "Invalid argument".
 */
export function parseCalendar(input: string): CalendarSpec {
  const text = input.trim();
  if (text === "") {
    fail(
      "Enter a calendar expression, such as Mon..Fri *-*-* 08:30:00.",
      "Hãy nhập một biểu thức lịch, ví dụ Mon..Fri *-*-* 08:30:00.",
    );
  }
  if (looksLikeCron(text)) {
    fail(
      "This is a crontab schedule — five fields, minute first. OnCalendar= is written differently: weekdays, then year-month-day, then hour:minute:second.",
      "Đây là lịch crontab — năm trường, bắt đầu bằng phút. OnCalendar= viết theo kiểu khác: thứ, rồi năm-tháng-ngày, rồi giờ:phút:giây.",
      true,
    );
  }
  if (text.includes("*/")) {
    fail(
      "systemd has no */N: a step needs a value to start from. Write 0/N for hours, minutes and seconds — *:0/15 is every fifteen minutes — and 1/N for days and months.",
      "systemd không có cú pháp */N: bước nhảy cần một giá trị bắt đầu. Hãy viết 0/N cho giờ, phút, giây — *:0/15 là cứ mười lăm phút một lần — và 1/N cho ngày và tháng.",
    );
  }
  if (/\d-\d{1,2}[Tt]\d/.test(text)) {
    fail(
      "Put a space between the date and the time: systemd does not read the T of ISO 8601.",
      "Hãy cách ngày và giờ bằng một dấu cách: systemd không đọc chữ T của ISO 8601.",
    );
  }

  let body = text;
  let utc = false;
  let zone: string | null = null;
  if (/ utc$/i.test(body)) {
    utc = true;
    body = body.slice(0, -4);
  } else {
    const space = body.lastIndexOf(" ");
    const word = space >= 0 ? body.slice(space + 1) : "";
    const offset = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?\d{2})?$/i.exec(word);
    if (offset) {
      const sign = offset[1] === "-" ? "+" : "-";
      const hours = Number(offset[2]);
      fail(
        `systemd takes a zone name, not an offset. Write the place, such as Asia/Ho_Chi_Minh — or Etc/GMT${sign}${hours} for a fixed offset, where the Etc/ names flip the sign.`,
        `systemd nhận tên múi giờ, không nhận độ lệch. Hãy viết tên địa danh, như Asia/Ho_Chi_Minh — hoặc Etc/GMT${sign}${hours} cho độ lệch cố định, vì các tên Etc/ đảo ngược dấu.`,
      );
    }
    // A weekday at the end is a misplaced weekday, not a zone; the reader below says so.
    if (/^[A-Za-z]/.test(word) && !dayNameAt({ s: word, i: 0 })) {
      const check = checkZone(word);
      if (check.status === "ok" || check.status === "alias") {
        zone = word;
        body = body.slice(0, space);
      } else if (check.status === "case") {
        const fix = check.suggestion ?? "Asia/Ho_Chi_Minh";
        fail(
          `Time-zone names are case-sensitive on the server, which looks them up as files: ${check.suggestion ? `write ${fix}, not ${word}` : `check the capitals, as in ${fix}`}.`,
          `Tên múi giờ phân biệt chữ hoa chữ thường trên máy chủ, vì nó được tra như tên tệp: ${check.suggestion ? `hãy viết ${fix}, không phải ${word}` : `hãy kiểm tra chữ hoa, như ${fix}`}.`,
        );
      } else if (/^[A-Z]{3,5}$/.test(word)) {
        fail(
          `“${word}” is a time-zone abbreviation. systemd reads one only when it is the server's own — EST or EDT on a server set to America/New_York — so write the zone's name instead.`,
          `“${word}” là tên viết tắt của múi giờ. systemd chỉ đọc tên viết tắt của chính múi giờ máy chủ — EST hay EDT trên máy đặt America/New_York — nên hãy viết tên đầy đủ của múi giờ.`,
        );
      } else if (word.includes("/")) {
        fail(
          `“${word}” is not a time zone this browser knows. Use a name from the IANA database, such as Asia/Ho_Chi_Minh, or UTC.`,
          `Trình duyệt không biết múi giờ “${word}”. Hãy dùng tên trong cơ sở dữ liệu IANA, như Asia/Ho_Chi_Minh, hoặc UTC.`,
        );
      }
    }
  }
  if (body !== body.trimEnd()) {
    fail(
      "There is more than one space before the time zone; systemd reads the zone after exactly one.",
      "Có nhiều hơn một dấu cách trước múi giờ; systemd chỉ đọc múi giờ sau đúng một dấu cách.",
    );
  }
  if (body === "") fail("A time zone needs a schedule in front of it.", "Múi giờ phải đi sau một lịch.");

  const lower = body.toLowerCase();
  const shorthand = SHORTHANDS.has(lower) ? lower : (SHORTHAND_ALIASES.get(lower) ?? null);
  let draft: Draft;
  if (shorthand !== null) {
    draft = SHORTHANDS.get(shorthand)!();
  } else {
    draft = emptyDraft();
    const cursor: Cursor = { s: body, i: 0 };
    draft.weekdays = parseWeekdays(cursor);
    const finished = parseDate(cursor, draft);
    if (!finished) parseTime(cursor, draft);
    else if (at(cursor) !== "") trailing(cursor);
    if (draft.epoch !== null) utc = true;
  }

  const adjustments: CalendarAdjustment[] = [];
  const weekdays = draft.weekdays <= 0 || draft.weekdays >= ALL_DAYS ? 0 : draft.weekdays;
  const endOfMonth = draft.endOfMonth && draft.day !== null;
  const year = normalizeChain(fixYear(draft.year, adjustments), "year", adjustments);
  const parts = {
    year,
    month: normalizeChain(draft.month, "month", adjustments),
    day: normalizeChain(draft.day, "day", adjustments),
    hour: normalizeChain(draft.hour, "hour", adjustments),
    minute: normalizeChain(draft.minute, "minute", adjustments),
    second: normalizeChain(draft.second, "second", adjustments),
  };
  for (const field of CALENDAR_FIELDS) validateChain(parts[field], field, endOfMonth);

  const spec = {
    shorthand,
    epoch: draft.epoch,
    weekdays,
    ...parts,
    endOfMonth,
    utc,
    zone: utc ? null : zone,
  };
  return {
    ...spec,
    text,
    timeOmitted: draft.timeOmitted && shorthand === null,
    adjustments,
    normalized: formatSpec(spec),
  };
}

/* ------------------------------------------------------------- matching */

/** A wall-clock reading to the microsecond; `us` counts into the minute. */
export interface CalendarWall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly us: number;
}

/** The smallest value of `chain` at or after `value` and at most `max`. */
function nextInChain(chain: CalendarChain, value: number, max: number): number | null {
  if (chain === null) return value <= max ? value : null;
  let best: number | null = null;
  for (const comp of chain) {
    let candidate: number;
    if (comp.start >= value) candidate = comp.start;
    else if (comp.repeat > 0) candidate = comp.start + Math.ceil((value - comp.start) / comp.repeat) * comp.repeat;
    else continue;
    const limit = comp.stop >= 0 ? Math.min(comp.stop, max) : max;
    if (candidate <= limit && (best === null || candidate < best)) best = candidate;
  }
  return best;
}

/**
 * The day chain of one month. With `~`, systemd turns each count from the
 * end into a date of that month — ~01 is the last day — and swaps a range's
 * ends so it runs forwards.
 */
function dayChain(spec: CalendarSpec, year: number, month: number): CalendarChain {
  if (!spec.endOfMonth || spec.day === null) return spec.day;
  const last = daysInMonth(year, month);
  return spec.day.map((comp) => {
    let start = last + 1 - comp.start;
    let stop = comp.stop >= 0 ? last + 1 - comp.stop : -1;
    if (stop > 0) [start, stop] = [stop, start];
    return { start, stop, repeat: comp.repeat };
  });
}

/** Monday is 0. 1970-01-01 was a Thursday. */
const weekdayOf = (year: number, month: number, day: number): number => (((daysFromCivil(year, month, day) + 3) % 7) + 7) % 7;

function dayMatches(spec: CalendarSpec, year: number, month: number, day: number): boolean {
  return spec.weekdays === 0 || (spec.weekdays & (1 << weekdayOf(year, month, day))) !== 0;
}

/**
 * The first wall-clock reading at or after `from` that the expression
 * matches, ignoring time zones entirely. Each field is settled before the
 * next, as systemd's find_next does, so a mismatch rolls the field above it
 * over rather than trying every second.
 */
export function nextMatch(spec: CalendarSpec, from: CalendarWall, overflows?: Overflow[]): CalendarWall | null {
  let { year, month, day, hour, minute, us } = from;

  /**
   * Where a field ran out of values, systemd does not simply move on: an
   * item with a step and no end proposes its next step anyway — hour 28 —
   * and systemd normalises that into the next unit, then resets to the
   * unit's start. Recorded here so the caller can check the clock there.
   */
  const overflow = (field: Overflow["field"], chain: CalendarChain, value: number, requested: (k: number) => CalendarWall, next: CalendarWall) => {
    if (!overflows || chain === null) return;
    let best: { k: number; comp: CalendarComponent } | null = null;
    for (const comp of chain) {
      if (comp.stop >= 0 || comp.repeat === 0 || comp.start >= value) continue;
      const k = comp.start + Math.ceil((value - comp.start) / comp.repeat) * comp.repeat;
      if (best === null || k < best.k) best = { k, comp };
    }
    if (best !== null) overflows.push({ field, requested: requested(best.k), next, item: best.comp });
  };

  const nextYear = () => {
    year += 1;
    month = 1;
    day = 1;
    hour = minute = us = 0;
  };
  const nextMonth = () => {
    if (month === 12) nextYear();
    else {
      month += 1;
      day = 1;
      hour = minute = us = 0;
    }
  };
  const nextDay = () => {
    if (day >= daysInMonth(year, month)) nextMonth();
    else {
      day += 1;
      hour = minute = us = 0;
    }
  };
  const nextHour = () => {
    if (hour === 23) nextDay();
    else {
      hour += 1;
      minute = us = 0;
    }
  };
  const nextMinute = () => {
    if (minute === 59) nextHour();
    else {
      minute += 1;
      us = 0;
    }
  };

  for (;;) {
    if (year > MAX_YEAR) return null;
    const y = nextInChain(spec.year, year, MAX_YEAR);
    if (y === null) return null;
    if (y !== year) {
      year = y;
      month = day = 1;
      hour = minute = us = 0;
    }

    const m = nextInChain(spec.month, month, 12);
    if (m === null) {
      overflow("month", spec.month, month, (k) => ({ year, month: k, day: 1, hour: 0, minute: 0, us: 0 }), wallFrom(year + 1, 1, 1, 0, 0, 0));
      nextYear();
      continue;
    }
    if (m !== month) {
      month = m;
      day = 1;
      hour = minute = us = 0;
    }

    const days = dayChain(spec, year, month);
    const d = nextInChain(days, day, daysInMonth(year, month));
    if (d === null) {
      overflow("day", days, day, (k) => ({ year, month, day: k, hour: 0, minute: 0, us: 0 }), wallFrom(year, month + 1, 1, 0, 0, 0));
      nextMonth();
      continue;
    }
    if (d !== day) {
      day = d;
      hour = minute = us = 0;
    }
    if (!dayMatches(spec, year, month, day)) {
      nextDay();
      continue;
    }

    const h = nextInChain(spec.hour, hour, 23);
    if (h === null) {
      overflow("hour", spec.hour, hour, (k) => ({ year, month, day, hour: k, minute: 0, us: 0 }), wallFrom(year, month, day + 1, 0, 0, 0));
      nextDay();
      continue;
    }
    if (h !== hour) {
      hour = h;
      minute = us = 0;
    }

    const mi = nextInChain(spec.minute, minute, 59);
    if (mi === null) {
      overflow("minute", spec.minute, minute, (k) => ({ year, month, day, hour, minute: k, us: 0 }), wallFrom(year, month, day, hour + 1, 0, 0));
      nextHour();
      continue;
    }
    if (mi !== minute) {
      minute = mi;
      us = 0;
    }

    const s = nextInChain(spec.second, us, LAST_US);
    if (s === null) {
      overflow("second", spec.second, us, (k) => ({ year, month, day, hour, minute, us: k }), wallFrom(year, month, day, hour, minute + 1, 0));
      nextMinute();
      continue;
    }
    return { year, month, day, hour, minute, us: s };
  }
}

/**
 * An item with a step and no end running past its field — `00/7` proposing
 * hour 28. systemd hands the fields to mktime() as they are and works out
 * from the result where to carry on.
 */
export interface Overflow {
  readonly field: "month" | "day" | "hour" | "minute" | "second";
  /** The fields as systemd asks for them, the overflowed one out of range. */
  readonly requested: CalendarWall;
  /** Where a search without the bug carries on: the start of the next unit. */
  readonly next: CalendarWall;
  /** The item that overflowed. */
  readonly item: CalendarComponent;
}

/** A wall reading from fields that may run past their ranges, as mktime would normalise them. */
function wallFrom(year: number, month: number, day: number, hour: number, minute: number, us: number): CalendarWall {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  const naive = ((daysFromCivil(y, m, 1) + day - 1) * 1440 + hour * 60 + minute) * 60 * SEC + us;
  const days = Math.floor(naive / (86_400 * SEC));
  const civil = civilFromDays(days);
  const rest = naive - days * 86_400 * SEC;
  return {
    ...civil,
    hour: Math.floor(rest / (3600 * SEC)),
    minute: Math.floor((rest % (3600 * SEC)) / (60 * SEC)),
    us: rest % (60 * SEC),
  };
}

/** True when the expression matches this reading exactly. */
export function matchesWall(spec: CalendarSpec, wall: CalendarWall): boolean {
  const found = nextMatch(spec, wall);
  return found !== null && compareWall(found, wall) === 0;
}

export function compareWall(a: CalendarWall, b: CalendarWall): number {
  return a.year - b.year || a.month - b.month || a.day - b.day || a.hour - b.hour || a.minute - b.minute || a.us - b.us;
}

function addMicro(wall: CalendarWall): CalendarWall {
  if (wall.us < LAST_US) return { ...wall, us: wall.us + 1 };
  let { year, month, day, hour, minute } = wall;
  minute += 1;
  if (minute === 60) {
    minute = 0;
    hour += 1;
  }
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  if (day > daysInMonth(year, month)) {
    day = 1;
    month += 1;
  }
  if (month === 13) {
    month = 1;
    year += 1;
  }
  return { year, month, day, hour, minute, us: 0 };
}

/* ------------------------------------------------------------ elapsing */

/** The zone an expression is read in: its own, or the server's. */
export function scheduleZone(spec: CalendarSpec, serverZone: string): string {
  return spec.utc ? "UTC" : (spec.zone ?? serverZone);
}

const DAY_MS = 86_400_000;

/** The wall-clock reading of an instant, to the microsecond. */
export function wallOf(us: number, zone: string): CalendarWall {
  const ms = Math.floor(us / 1000);
  const p = zonedParts(ms, zone);
  const subSecond = us - Math.floor(us / SEC) * SEC;
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, us: p.second * SEC + subSecond };
}

type Resolved =
  | { readonly kind: "exact"; readonly us: number }
  | { readonly kind: "overlap"; readonly us: number; readonly later: number }
  | { readonly kind: "gap"; readonly end: CalendarWall; readonly jump: number };

/** The instant a wall time names in `zone`: one, two around a repeat, or none in a gap. */
function resolve(wall: CalendarWall, zone: string): Resolved {
  const second = Math.floor(wall.us / SEC);
  const sub = wall.us % SEC;
  const civil = { year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second };
  const found = wallTimeToMs(civil, zone);
  if (found.resolution === "exact") return { kind: "exact", us: found.ms * 1000 + sub };
  if (found.resolution === "overlap") return { kind: "overlap", us: found.ms * 1000 + sub, later: found.later! * 1000 + sub };

  // In a gap: find the moment the clocks jumped, and the first wall time after it.
  const naive = daysFromCivil(wall.year, wall.month, wall.day) * DAY_MS + wall.hour * 3_600_000 + wall.minute * 60_000 + second * 1000;
  const before = zoneOffsetMs(naive - DAY_MS, zone);
  const after = zoneOffsetMs(naive + DAY_MS, zone);
  let lo = Math.floor((naive - after) / 1000);
  let hi = Math.ceil((naive - before) / 1000);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(mid * 1000, zone) === after) hi = mid;
    else lo = mid + 1;
  }
  const jump = lo * 1000;
  const end = wallTimeAt(jump, zone);
  return {
    kind: "gap",
    jump: jump * 1000,
    end: { year: end.year, month: end.month, day: end.day, hour: end.hour, minute: end.minute, us: end.second * SEC },
  };
}

export interface Elapse {
  /** Microseconds since the epoch. */
  readonly us: number;
  /** The wall-clock reading the expression matched. */
  readonly wall: CalendarWall;
  /**
   * The clocks went back over this reading, so it happened twice; systemd
   * elapses once. `first` is the usual case. `second` happens only when the
   * search starts inside the repeated hour, after the first pass.
   */
  readonly repeated: "first" | "second" | null;
}

export interface SkippedElapse {
  /** The first matching wall time the clocks skipped. */
  readonly wall: CalendarWall;
  /** The first reading after the jump. */
  readonly resume: CalendarWall;
  /** More matching wall times fell into the same gap. */
  readonly more: boolean;
  /** When the clocks jumped, in microseconds. */
  readonly jump: number;
}

/** An overflow that sends systemd 259 wrong, with where it went. */
export interface StuckOverflow extends Overflow {
  /** Where mktime() put the overflowed fields. */
  readonly landing: CalendarWall;
  /** The time systemd went back to before the daylight-saving flag misled it. */
  readonly reset: CalendarWall;
}

/** An overflow after which systemd 259 resumes too late and misses an elapse. */
export interface MissedOverflow extends StuckOverflow {
  /** Where systemd resumes the search. */
  readonly resume: CalendarWall;
  /** The first matching time it passes over. */
  readonly lost: CalendarWall;
  /**
   * `carry`: only the field below the one that changed was reset, so the
   * hour or minute it landed on survived — `*:0/7` resumes at 00:07, not
   * 00:00. `clock`: a clock change between the two misread the reset.
   */
  readonly cause: "carry" | "clock";
}

export interface ElapseSearch {
  readonly elapses: readonly Elapse[];
  /** Matching wall times skipped by a clock change, up to the last elapse listed. */
  readonly skipped: readonly SkippedElapse[];
  /** Nothing elapses after the starting point, ever. */
  readonly never: boolean;
  /**
   * systemd 259 cannot work out the elapse after the last one listed: it
   * gives up with "Infinite loop in calendar calculation" and the timer
   * stops. See `overflowOutcome`.
   */
  readonly stuck: StuckOverflow | null;
  /** Overflows after which systemd 259 resumes late and misses an elapse. */
  readonly missed: readonly MissedOverflow[];
}

/**
 * What an overflow does to systemd 259's search.
 *
 * After normalising the overflowed value, systemd resets the field below the
 * first one that changed — usually the start of the unit it landed in — but
 * keeps the daylight-saving flag of where it landed.
 * When a clock change lies between the two, the next mktime() reads the reset
 * time with the wrong flag:
 *
 * - landing in summer time, reset in winter time (clocks went forward in
 *   between): the reset time is read an hour early, in the unit before, the
 *   same overflow happens again, and systemd gives up after 1,000 rounds;
 * - landing in winter time, reset in summer time (clocks went back): the
 *   reset time is read an hour late, and the search resumes there.
 *
 * Pinned against `systemd-analyze calendar` around real clock changes; an
 * item with an end — `00..21/7` rather than `00/7` — never overflows.
 */
export type OverflowOutcome =
  /** systemd carries on from the start of the next unit, as a correct search would. */
  | { readonly kind: "none" }
  /** systemd gives up: "Infinite loop in calendar calculation". */
  | { readonly kind: "stuck"; readonly landing: CalendarWall; readonly reset: CalendarWall }
  /**
   * systemd carries on from `resume` instead. `late` is the daylight-saving
   * case worth telling the reader about; otherwise mktime() merely carried
   * the landing over a gap.
   */
  | { readonly kind: "resume"; readonly resume: CalendarWall; readonly late: boolean; readonly landing: CalendarWall; readonly reset: CalendarWall };

const FIELD_ORDER = ["year", "month", "day", "hour", "minute", "us"] as const;

/**
 * mktime() with no daylight-saving hint: the instant of a wall time, a time
 * inside a gap moved forward past the jump, a repeated one at its first.
 */
function mktimeUs(wall: CalendarWall, zone: string): number {
  const found = resolve(wall, zone);
  if (found.kind !== "gap") return found.us;
  const naive = (daysFromCivil(wall.year, wall.month, wall.day) * 1440 + wall.hour * 60 + wall.minute) * 60 * SEC + wall.us;
  return naive - zoneOffsetMs(found.jump / 1000 - 1000, zone) * 1000;
}

/** A wall time as mktime() leaves it: unchanged, or moved forward out of a gap. */
const forward = (wall: CalendarWall, zone: string): CalendarWall => wallOf(mktimeUs(wall, zone), zone);

export function overflowOutcome(spec: CalendarSpec, event: Overflow, zone: string): OverflowOutcome {
  const r = event.requested;
  const landingUs = mktimeUs(wallFrom(r.year, r.month, r.day, r.hour, r.minute, r.us), zone);
  const landing = wallOf(landingUs, zone);
  const landingOffset = zoneOffsetMs(Math.floor(landingUs / 1000), zone);

  // tm_within_bounds(): the first field that changed keeps its new value, and
  // only the one below it goes back to its start — so a step past 23:00 on
  // the last of the month resumes at 04:00 on the 1st, not at midnight. A new
  // year resets the day as well as the month: that much was fixed in 259.5.
  const asked = { ...r, us: Math.floor(r.us / SEC) * SEC };
  const shown = { ...landing, us: Math.floor(landing.us / SEC) * SEC };
  const changed = FIELD_ORDER.findIndex((field) => shown[field] !== asked[field]);
  const below = FIELD_ORDER[changed + 1];
  let reset: CalendarWall = below === undefined ? landing : { ...landing, [below]: below === "month" || below === "day" ? 1 : 0 };
  if (below === "month") reset = { ...reset, day: 1 };

  // That reset is read with the landing's daylight-saving flag. Inside a gap,
  // read as summer time, it goes back by the gap, before the jump.
  const at = resolve(reset, zone);
  const resetOffset =
    at.kind === "gap"
      ? zoneOffsetMs(at.jump / 1000 - 1000, zone)
      : at.kind === "overlap"
        ? landingOffset
        : zoneOffsetMs(Math.floor(at.us / 1000), zone);
  if (resetOffset !== landingOffset) {
    // Read with the other offset, the reset moves by the difference: back
    // when it landed in summer time, forward when it landed in winter time.
    const shift = (resetOffset - landingOffset) * 1000;
    const resume = wallFrom(reset.year, reset.month, reset.day, reset.hour, reset.minute, reset.us + shift);
    if (shift < 0) {
      const unit = FIELD_ORDER.slice(changed + 1).reduce<CalendarWall>(
        (wall, field) => ({ ...wall, [field]: field === "month" || field === "day" ? 1 : 0 }),
        reset,
      );
      if (compareWall(resume, unit) < 0) {
        // Back in the unit before. If the search finds a match there, it lies
        // before where the search began, and find_next() notices: it steps an
        // hour on and carries on from there. With no match, the same overflow
        // comes round again, for ever, until systemd gives up.
        const before = nextMatch(spec, resume);
        if (before === null || compareWall(before, unit) >= 0) return { kind: "stuck", landing, reset };
        const onward = forward(wallFrom(before.year, before.month, before.day, before.hour + 1, before.minute, before.us), zone);
        return { kind: "resume", resume: onward, late: true, landing, reset };
      }
    }
    return { kind: "resume", resume, late: shift > 0, landing, reset };
  }
  return compareWall(reset, event.next) === 0 ? { kind: "none" } : { kind: "resume", resume: reset, late: false, landing, reset };
}

/**
 * The next `count` elapses strictly after `afterUs`, in `zone` (pass
 * `scheduleZone` so an expression's own zone wins).
 *
 * The search runs on the wall clock, as systemd's does: after each elapse it
 * looks for the next matching reading, then asks the zone what instant that
 * is. A reading the clocks skip is passed over; a reading that happens twice
 * becomes the first of its two instants that is still in the future. That is
 * what makes a daily 02:30 job miss the spring-forward day and an hourly :30
 * job fire once, not twice, in the hour that repeats.
 */
export function nextElapses(spec: CalendarSpec, zone: string, afterUs: number, count: number): ElapseSearch {
  const elapses: Elapse[] = [];
  const skipped: SkippedElapse[] = [];
  const missed: MissedOverflow[] = [];
  if (count <= 0) return { elapses, skipped, never: false, stuck: null, missed };

  if (spec.epoch !== null) {
    const us = spec.epoch * SEC;
    const wall = wallOf(us, "UTC");
    // `Mon @…` is legal, and only elapses if that moment falls on a Monday.
    if (us <= afterUs || !dayMatches(spec, wall.year, wall.month, wall.day)) return { elapses, skipped, never: true, stuck: null, missed };
    return { elapses: [{ us, wall, repeated: null }], skipped, never: false, stuck: null, missed };
  }

  let base = afterUs;
  let cursor = wallOf(afterUs + 1, zone);
  let stuck: StuckOverflow | null = null;
  search: while (elapses.length < count) {
    const overflows: Overflow[] = [];
    const wall = nextMatch(spec, cursor, overflows);
    for (const event of overflows) {
      const outcome = overflowOutcome(spec, event, zone);
      if (outcome.kind === "stuck") {
        stuck = { ...event, landing: outcome.landing, reset: outcome.reset };
        break search;
      }
      if (outcome.kind === "resume") {
        const passed = nextMatch(spec, event.next);
        if (passed !== null && compareWall(passed, outcome.resume) < 0) {
          const { landing, reset, resume } = outcome;
          missed.push({ ...event, landing, reset, resume, lost: passed, cause: outcome.late ? "clock" : "carry" });
        }
        cursor = outcome.resume;
        continue search;
      }
    }
    if (wall === null) break;
    const found = resolve(wall, zone);

    if (found.kind === "gap") {
      const again = nextMatch(spec, addMicro(wall));
      skipped.push({ wall, resume: found.end, more: again !== null && compareWall(again, found.end) < 0, jump: found.jump });
      cursor = compareWall(found.end, wall) > 0 ? found.end : addMicro(wall);
      continue;
    }

    const us = found.us > base ? found.us : found.kind === "overlap" && found.later > base ? found.later : null;
    if (us !== null) {
      const repeated = found.kind !== "overlap" ? null : us === found.us ? "first" : "second";
      elapses.push({ us, wall, repeated });
      base = us;
    }
    cursor = addMicro(wall);
  }

  const last = elapses.length > 0 ? elapses[elapses.length - 1]!.us : Number.POSITIVE_INFINITY;
  return {
    elapses,
    skipped: skipped.filter((skip) => skip.jump <= last),
    never: elapses.length === 0 && stuck === null,
    stuck,
    missed: missed.filter((miss) => elapses.length === 0 || compareWall(miss.lost, elapses[elapses.length - 1]!.wall) <= 0),
  };
}

/* ------------------------------------------------------- clock changes */

export interface ClockChange {
  /** When the change happens, in milliseconds. */
  readonly ms: number;
  /** Offsets before and after, in milliseconds. */
  readonly before: number;
  readonly after: number;
  /** The wall time the clocks jump from, and the one they land on. */
  readonly from: CalendarWall;
  readonly to: CalendarWall;
}

/** Every offset change in `zone` within `days` days after `fromMs`, found by daily samples and bisection. */
export function clockChanges(zone: string, fromMs: number, days = 400): ClockChange[] {
  if (zone === "UTC") return [];
  const changes: ClockChange[] = [];
  let previous = zoneOffsetMs(fromMs, zone);
  for (let k = 1; k <= days; k += 1) {
    const t = fromMs + k * DAY_MS;
    const offset = zoneOffsetMs(t, zone);
    if (offset === previous) continue;
    let lo = Math.floor((t - DAY_MS) / 1000);
    let hi = Math.ceil(t / 1000);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (zoneOffsetMs(mid * 1000, zone) === offset) hi = mid;
      else lo = mid + 1;
    }
    const ms = lo * 1000;
    const wall = (instant: number, by: number): CalendarWall => {
      const p = wallTimeAt(instant + by, "UTC");
      return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, us: p.second * SEC };
    };
    changes.push({ ms, before: previous, after: offset, from: wall(ms, previous), to: wall(ms, offset) });
    previous = offset;
  }
  return changes;
}

/* ------------------------------------------------------------- describing */

const EN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const VI_DAYS = ["thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy", "Chủ nhật"] as const;
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const two = (n: number): string => String(n).padStart(2, "0");

function joinWith(items: readonly string[], word: string): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

const joinAnd = (items: readonly string[], lang: Lang): string => joinWith(items, lang === "vi" ? "và" : "and");
const joinOr = (items: readonly string[], lang: Lang): string => joinWith(items, lang === "vi" ? "hoặc" : "or");

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** Every value a chain matches, for fields small enough to list. */
export function chainValues(chain: CalendarChain, field: Exclude<CalendarField, "second">, max?: number): number[] {
  const [from, to] = RANGES[field];
  const top = max ?? to;
  const values: number[] = [];
  for (let v = nextInChain(chain, from, top); v !== null; v = v + 1 <= top ? nextInChain(chain, v + 1, top) : null) {
    values.push(v);
  }
  return values;
}

/** True when a chain is one plain value. */
const isSingle = (chain: CalendarChain): chain is readonly [CalendarComponent] =>
  chain !== null && chain.length === 1 && chain[0]!.repeat === 0;

/** True when every item is a plain value — no ranges, no steps. */
const isPlain = (chain: CalendarChain): chain is readonly CalendarComponent[] =>
  chain !== null && chain.every((comp) => comp.repeat === 0);

/** One repeating item and nothing else: `0/15`, `08..18/2`, `09..17`. */
const isStepped = (chain: CalendarChain): chain is readonly [CalendarComponent] =>
  chain !== null && chain.length === 1 && chain[0]!.repeat > 0;

/** The last value a repeating item reaches at or below `max`. */
const lastOf = (comp: CalendarComponent, max: number): number =>
  comp.stop >= 0 ? comp.stop : comp.start + Math.floor((max - comp.start) / comp.repeat) * comp.repeat;

const UNITS: Readonly<Record<CalendarField, Both>> = {
  year: { en: "years", vi: "năm" },
  month: { en: "months", vi: "tháng" },
  day: { en: "days", vi: "ngày" },
  hour: { en: "hours", vi: "giờ" },
  minute: { en: "minutes", vi: "phút" },
  second: { en: "seconds", vi: "giây" },
};

/** One item, in words: "08", "08 through 18", "every 2 hours from 08 to 18", "every 15 minutes from 05". */
function itemWords(comp: CalendarComponent, label: (v: number) => string, lang: Lang, unit: Both, max: number): string {
  const vi = lang === "vi";
  if (comp.repeat === 0) return label(comp.start);
  const step = unit === UNITS.second ? secondsStep(comp.repeat) : comp.repeat;
  if (comp.stop >= 0 && comp.repeat === (unit === UNITS.second ? SEC : 1)) {
    return vi ? `từ ${label(comp.start)} đến ${label(comp.stop)}` : `${label(comp.start)} through ${label(comp.stop)}`;
  }
  const last = label(lastOf(comp, max));
  return vi
    ? `cứ ${step} ${unit.vi} một lần từ ${label(comp.start)} đến ${last}`
    : `every ${step} ${unit.en} from ${label(comp.start)} to ${last}`;
}

function chainWords(chain: readonly CalendarComponent[], label: (v: number) => string, lang: Lang, unit: Both, max: number): string {
  return joinAnd(chain.map((comp) => itemWords(comp, label, lang, unit, max)), lang);
}

const clockOf = (hour: number, minute: number): string => `${two(hour)}:${two(minute)}`;

/** Seconds for a sentence: `30`, `00.5` — the normalized form's six decimals trimmed. */
function secondWords(us: number): string {
  const text = formatSeconds(us);
  return text.includes(".") ? text.replace(/0+$/, "") : text;
}

/** A length of seconds: `15`, `0.5`. */
const secondsStep = (us: number): string => secondWords(us).replace(/^0(?=\d)/, "");

/** The time of day, as the opening of the sentence. `clock` means it names clock times. */
function describeTime(spec: CalendarSpec, lang: Lang): { text: string; clock: boolean } {
  const vi = lang === "vi";
  const { hour, minute, second } = spec;
  const everySecond = secondsAreStar(second);
  const secondZero = isSingle(second) && second[0].start === 0;

  // A handful of fixed times: "At 08:30:00 and 17:30:00".
  if (isPlain(hour) && isPlain(minute) && isPlain(second) && hour.length * minute.length * second.length <= 6) {
    const times = hour.flatMap((h) => minute.flatMap((m) => second.map((s) => `${clockOf(h.start, m.start)}:${formatSeconds(s.start)}`)));
    return { text: `${vi ? "Lúc" : "At"} ${joinAnd(times, lang)}`, clock: true };
  }

  if (hour === null && minute === null) {
    if (everySecond) return { text: vi ? "Mỗi giây" : "Every second", clock: false };
    if (secondZero) return { text: vi ? "Mỗi phút, vào giây 00" : "Every minute, on the minute", clock: false };
    if (isStepped(second)) {
      const comp = second[0];
      const n = secondsStep(comp.repeat);
      const every = comp.repeat === SEC ? (vi ? "Mỗi giây" : "Every second") : vi ? `Cứ ${n} giây một lần` : `Every ${n} seconds`;
      if (comp.stop < 0 && comp.start === 0) return { text: every, clock: false };
      const span = vi
        ? `từ giây ${secondWords(comp.start)} đến giây ${secondWords(lastOf(comp, LAST_US))} của mỗi phút`
        : `from second ${secondWords(comp.start)} to ${secondWords(lastOf(comp, LAST_US))} of each minute`;
      return { text: `${every}, ${span}`, clock: false };
    }
  }

  // What happens within a minute, as a tail: ", at second 30".
  const secondTail = (): string => {
    if (secondZero) return "";
    if (everySecond) return vi ? ", mỗi giây" : ", every second";
    const words = chainWords(second!, secondWords, lang, UNITS.second, LAST_US);
    return vi ? `, vào giây ${words}` : `, at second${isSingle(second) ? "" : "s"} ${words}`;
  };

  // A few fixed minutes read as marks on a clock face: ":15 and :45".
  if (isPlain(minute) && minute.length <= 4) {
    const marks = minute.map((m) => (vi ? two(m.start) : `:${two(m.start)}`));
    const onTheHour = minute.length === 1 && minute[0]!.start === 0 && secondZero;
    if (hour === null) {
      if (vi) return { text: `Mỗi giờ, vào phút ${joinAnd(marks, lang)}${secondTail()}`, clock: false };
      return { text: onTheHour ? "Every hour, on the hour" : `Every hour at ${joinAnd(marks, lang)}${secondTail()}`, clock: false };
    }
    if (isStepped(hour)) {
      const comp = hour[0];
      const firstMinute = minute[0]!.start;
      const lastMinute = minute[minute.length - 1]!.start;
      const span = vi
        ? `từ ${clockOf(comp.start, firstMinute)} đến ${clockOf(lastOf(comp, 23), lastMinute)}`
        : `from ${clockOf(comp.start, firstMinute)} to ${clockOf(lastOf(comp, 23), lastMinute)}`;
      if (comp.repeat === 1) {
        if (vi) return { text: `Mỗi giờ vào phút ${joinAnd(marks, lang)}${secondTail()}, ${span}`, clock: false };
        return { text: `Every hour${onTheHour ? "" : ` at ${joinAnd(marks, lang)}`}${secondTail()} ${span}`, clock: false };
      }
      if (vi) return { text: `Cứ ${comp.repeat} giờ một lần vào phút ${joinAnd(marks, lang)}${secondTail()}, ${span}`, clock: false };
      return {
        text: `Every ${comp.repeat} hours${onTheHour ? ", on the hour," : ` at ${joinAnd(marks, lang)}${secondTail()},`} ${span}`,
        clock: false,
      };
    }
    const hours = chainWords(hour!, two, lang, UNITS.hour, 23);
    if (vi) return { text: `Vào phút ${joinAnd(marks, lang)}${secondTail()} của các giờ ${hours}`, clock: false };
    return { text: `At ${joinAnd(marks, lang)}${secondTail()} past hour${isSingle(hour) ? "" : "s"} ${hours}`, clock: false };
  }

  // Everything else: a minute clause, then the hours it applies in.
  let text: string;
  if (minute === null) {
    text = vi ? "Mỗi phút" : "Every minute";
  } else if (isStepped(minute)) {
    const comp = minute[0];
    const range = comp.stop >= 0 || comp.start !== 0;
    if (comp.repeat === 1) {
      text = vi
        ? `Mỗi phút từ phút ${two(comp.start)} đến phút ${two(lastOf(comp, 59))}`
        : `Every minute from :${two(comp.start)} to :${two(lastOf(comp, 59))}`;
    } else if (!range) {
      text = vi ? `Cứ ${comp.repeat} phút một lần` : `Every ${comp.repeat} minutes`;
    } else {
      text = vi
        ? `Cứ ${comp.repeat} phút một lần, từ phút ${two(comp.start)} đến phút ${two(lastOf(comp, 59))}`
        : `Every ${comp.repeat} minutes from :${two(comp.start)} to :${two(lastOf(comp, 59))}`;
    }
  } else {
    const words = chainWords(minute, two, lang, UNITS.minute, 59);
    text = vi ? `Vào các phút ${words}` : `At minutes ${words}`;
  }
  text += secondTail();
  if (hour === null) return { text, clock: false };

  let hours: string;
  if (isStepped(hour) && hour[0].repeat === 1) {
    hours = vi
      ? `từ ${clockOf(hour[0].start, 0)} đến ${clockOf(lastOf(hour[0], 23), 59)}`
      : `between ${clockOf(hour[0].start, 0)} and ${clockOf(lastOf(hour[0], 23), 59)}`;
  } else if (isStepped(hour)) {
    hours = vi
      ? `cứ ${hour[0].repeat} giờ một lần, từ ${clockOf(hour[0].start, 0)} đến ${clockOf(lastOf(hour[0], 23), 59)}`
      : `every ${ordinal(hour[0].repeat)} hour from ${clockOf(hour[0].start, 0)} to ${clockOf(lastOf(hour[0], 23), 59)}`;
  } else if (isSingle(hour)) {
    hours = vi
      ? `từ ${clockOf(hour[0].start, 0)} đến ${clockOf(hour[0].start, 59)}`
      : `between ${clockOf(hour[0].start, 0)} and ${clockOf(hour[0].start, 59)}`;
  } else {
    hours = `${vi ? "trong các giờ" : "during hours"} ${chainWords(hour, two, lang, UNITS.hour, 23)}`;
  }
  return { text: `${text}, ${hours}`, clock: false };
}

interface WeekdayWords {
  readonly text: string;
  readonly days: readonly string[];
  readonly single: boolean;
  readonly oneRange: boolean;
}

function weekdayWords(bits: number, lang: Lang): WeekdayWords {
  const names = lang === "vi" ? VI_DAYS : EN_DAYS;
  const days: number[] = [];
  for (let d = 0; d < 7; d += 1) if (bits & (1 << d)) days.push(d);
  const runs: [number, number][] = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  const items: string[] = [];
  for (const [a, b] of runs) {
    if (b - a >= 2) items.push(lang === "vi" ? `từ ${names[a]} đến ${names[b]}` : `${names[a]} through ${names[b]}`);
    else for (let d = a; d <= b; d += 1) items.push(names[d]!);
  }
  return {
    text: joinAnd(items, lang),
    days: days.map((d) => names[d]!),
    single: days.length === 1,
    oneRange: runs.length === 1 && days.length >= 3,
  };
}

const NTH_EN = ["first", "second", "third", "fourth"] as const;
const NTH_VI = ["đầu tiên", "thứ hai", "thứ ba", "thứ tư"] as const;

/** `Mon *-*-01..07` is the first Monday of the month; `Mon *-*~07/1` and `Mon *-*~01..07` the last. */
function nthWeekday(spec: CalendarSpec): { weekday: number; nth: number | "last" } | null {
  const bits = spec.weekdays;
  if (bits === 0 || (bits & (bits - 1)) !== 0 || !isStepped(spec.day)) return null;
  const comp = spec.day[0];
  const weekday = Math.log2(bits);
  if (spec.endOfMonth) {
    const lastWeek =
      comp.repeat === 1 && ((comp.start === 7 && comp.stop < 0) || (comp.start === 1 && comp.stop === 7));
    return lastWeek ? { weekday, nth: "last" } : null;
  }
  if (comp.repeat === 1 && comp.stop === comp.start + 6 && (comp.start - 1) % 7 === 0 && comp.start <= 22) {
    return { weekday, nth: (comp.start - 1) / 7 };
  }
  return null;
}

function monthWords(chain: readonly CalendarComponent[], lang: Lang): string {
  const label = (m: number) => (lang === "vi" ? String(m) : EN_MONTHS[m - 1]!);
  return chainWords(chain, label, lang, UNITS.month, 12);
}

/** "the 1st", "the last day", "the last 3 days" — the day field in words. */
function dayWords(spec: CalendarSpec, lang: Lang): string {
  const vi = lang === "vi";
  const chain = spec.day!;
  if (spec.endOfMonth) {
    const fromEnd = (n: number) => (n === 1 ? (vi ? "ngày cuối cùng" : "the last day") : vi ? `ngày thứ ${n} tính từ cuối` : `the ${ordinal(n)}-to-last day`);
    return joinAnd(
      chain.map((comp) => {
        if (comp.repeat === 0) return fromEnd(comp.start);
        const nearest = comp.stop >= 0 ? comp.start : 1;
        const farthest = comp.stop >= 0 ? comp.stop : comp.start;
        if (comp.repeat === 1 && nearest === 1) return vi ? `${farthest} ngày cuối` : `the last ${farthest} days`;
        if (comp.repeat === 1) {
          return vi
            ? `các ngày từ ngày thứ ${farthest} đến ngày thứ ${nearest} tính từ cuối`
            : `the ${ordinal(farthest)}-to-last through the ${ordinal(nearest)}-to-last day`;
        }
        return vi
          ? `cứ ${comp.repeat} ngày một lần, từ ngày thứ ${farthest} tính từ cuối`
          : `every ${ordinal(comp.repeat)} day from the ${ordinal(farthest)}-to-last`;
      }),
      lang,
    );
  }
  if (isSingle(chain)) return vi ? `ngày ${chain[0].start}` : `the ${ordinal(chain[0].start)}`;
  const label = (d: number) => (vi ? String(d) : ordinal(d));
  if (isStepped(chain) && chain[0].repeat > 1) {
    const comp = chain[0];
    return vi
      ? `cứ ${comp.repeat} ngày một lần từ ngày ${comp.start}${comp.stop >= 0 ? ` đến ngày ${comp.stop}` : ""}`
      : `every ${ordinal(comp.repeat)} day from the ${ordinal(comp.start)}${comp.stop >= 0 ? ` to the ${ordinal(comp.stop)}` : ""}`;
  }
  return vi ? `các ngày ${chainWords(chain, label, lang, UNITS.day, 31)}` : `the ${chainWords(chain, label, lang, UNITS.day, 31)}`;
}

/** ", but only if that day is a Friday" — the weekday as a condition on a date. */
function weekdayCondition(weekdays: WeekdayWords, lang: Lang): string {
  if (lang === "vi") {
    if (weekdays.oneRange) return `, nhưng chỉ khi ngày đó rơi vào ${weekdays.text}`;
    return `, nhưng chỉ khi ngày đó là ${joinOr(weekdays.days, lang)}`;
  }
  if (weekdays.oneRange) return `, but only if that day falls ${weekdays.text}`;
  return `, but only if that day is a ${joinOr(weekdays.days, lang)}`;
}

/** The days it fires on, joined to the time phrase before it. */
function describeDays(spec: CalendarSpec, lang: Lang, clock: boolean): string {
  const vi = lang === "vi";
  const months = spec.month === null ? null : monthWords(spec.month, lang);
  const oneMonth = isSingle(spec.month);
  const inMonths = months === null ? "" : vi ? ` ${oneMonth ? "tháng" : "các tháng"} ${months}` : ` ${months}`;
  const weekdays = spec.weekdays === 0 ? null : weekdayWords(spec.weekdays, lang);

  const nth = nthWeekday(spec);
  if (nth !== null) {
    const day = (vi ? VI_DAYS : EN_DAYS)[nth.weekday]!;
    const which = nth.nth === "last" ? (vi ? "cuối cùng" : "last") : (vi ? NTH_VI : NTH_EN)[nth.nth]!;
    if (vi) return ` vào ${day} ${which} của${months === null ? " mỗi tháng" : inMonths}`;
    return ` on the ${which} ${day} of ${months === null ? "every month" : months}`;
  }

  if (spec.day === null) {
    if (weekdays === null) {
      if (months === null) return clock ? (vi ? " hằng ngày" : " every day") : "";
      return vi ? ` mỗi ngày trong${inMonths}` : ` every day in${inMonths}`;
    }
    const tail = months === null ? "" : vi ? ` trong${inMonths}` : ` in${inMonths}`;
    if (vi) {
      if (weekdays.single) return ` mỗi ${weekdays.text}${tail}`;
      if (weekdays.oneRange) return `, ${weekdays.text}${tail}`;
      return ` vào ${weekdays.text.startsWith("từ ") ? "các ngày " : ""}${weekdays.text}${tail}`;
    }
    if (weekdays.single) return ` every ${weekdays.text}${tail}`;
    if (weekdays.oneRange) return `, ${weekdays.text}${tail}`;
    return ` on ${weekdays.text}${tail}`;
  }

  // One day, one month and one year read as a date.
  let text: string;
  if (!spec.endOfMonth && isSingle(spec.day) && oneMonth && isSingle(spec.year)) {
    const d = spec.day[0].start;
    const m = spec.month![0]!.start;
    const y = spec.year[0].start;
    text = vi ? ` vào ngày ${d} tháng ${m} năm ${y}` : ` on ${d} ${EN_MONTHS[m - 1]} ${y}`;
  } else {
    const days = dayWords(spec, lang);
    if (vi) {
      // "ngày thứ 3 tính từ cuối tháng 2" needs no "của"; "ngày cuối cùng của tháng 2" does.
      const of = spec.endOfMonth && !days.endsWith("tính từ cuối") ? " của" : "";
      const whichMonths = months === null ? (spec.endOfMonth ? " mỗi tháng" : " hằng tháng") : inMonths;
      // "cứ 2 ngày một lần" already says when; "vào" in front of it would not read.
      text = ` ${days.startsWith("cứ") ? "" : "vào "}${days}${of}${whichMonths}`;
    } else {
      text = ` on ${days} of ${months === null ? "every month" : months}`;
    }
  }
  return weekdays === null ? text : text + weekdayCondition(weekdays, lang);
}

function describeYears(spec: CalendarSpec, lang: Lang): string {
  const year = spec.year;
  if (year === null) return "";
  if (!spec.endOfMonth && isSingle(spec.day) && isSingle(spec.month) && isSingle(year)) return "";
  const vi = lang === "vi";
  if (isSingle(year)) return vi ? `, năm ${year[0].start}` : `, in ${year[0].start}`;
  if (isStepped(year) && year[0].repeat === 1) {
    return vi ? `, từ năm ${year[0].start} đến năm ${year[0].stop}` : `, from ${year[0].start} through ${year[0].stop}`;
  }
  const words = chainWords(year, String, lang, UNITS.year, MAX_YEAR);
  return vi ? `, các năm ${words}` : `, in ${words}`;
}

/**
 * One sentence saying when an expression elapses. It is built from the items
 * as written — `0/15` reads as "every 15 minutes" — so it can stay short; the
 * field table beside it lists the values.
 */
export function describeCalendar(spec: CalendarSpec, lang: Lang): string {
  const vi = lang === "vi";
  if (spec.epoch !== null) {
    const date = new Date(spec.epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
    const day = spec.weekdays === 0 ? "" : weekdayCondition(weekdayWords(spec.weekdays, lang), lang);
    return vi ? `Một lần duy nhất, lúc ${date} UTC${day}.` : `Once, at ${date} UTC${day}.`;
  }
  const time = describeTime(spec, lang);
  let sentence = time.text + describeDays(spec, lang, time.clock) + describeYears(spec, lang);
  if (spec.utc) sentence += vi ? " (giờ UTC)" : " (UTC)";
  else if (spec.zone) sentence += vi ? ` (theo giờ ${spec.zone})` : ` (${spec.zone} time)`;
  return `${sentence}.`;
}

/** What one field matches, for the breakdown table. */
export function describeField(spec: CalendarSpec, field: CalendarField | "weekday", lang: Lang): string {
  const vi = lang === "vi";
  if (field === "weekday") {
    if (spec.weekdays === 0) return vi ? "mọi ngày trong tuần" : "every day of the week";
    return capitalise(weekdayWords(spec.weekdays, lang).text);
  }
  const chain = spec[field];
  if (chain === null || (field === "second" && secondsAreStar(chain))) {
    const every: Record<CalendarField, Both> = {
      year: { en: "every year", vi: "mọi năm" },
      month: { en: "every month", vi: "mọi tháng" },
      day: { en: "every day", vi: "mọi ngày" },
      hour: { en: "every hour", vi: "mọi giờ" },
      minute: { en: "every minute", vi: "mọi phút" },
      second: { en: "every second", vi: "mọi giây" },
    };
    return every[field][lang];
  }
  if (field === "second") return chainWords(chain, formatSeconds, lang, UNITS.second, LAST_US);
  if (field === "day" && spec.endOfMonth) return capitalise(dayWords(spec, lang).replace(/^the /, ""));
  if (field === "month") {
    const words = monthWords(chain, lang);
    return vi ? `tháng ${words}` : words;
  }
  const values = chainValues(chain, field);
  const label = field === "year" ? String : two;
  if (values.length <= 12) return joinAnd(values.map(label), lang);
  return `${values.slice(0, 6).map(label).join(", ")}, …, ${label(values[values.length - 1]!)} (${values.length} ${vi ? "giá trị" : "values"})`;
}

/* ------------------------------------------------------------- notes */

const SHORTHAND_NOTE: Readonly<Record<string, Both>> = {
  weekly: {
    en: "“weekly” is Monday at 00:00:00, not Sunday.",
    vi: "“weekly” là 00:00:00 thứ Hai, không phải Chủ nhật.",
  },
};

/**
 * Things worth knowing about an expression that do not stop it working. The
 * clock-change notes need the zone and a starting point; the rest follow from
 * the expression alone.
 */
export function calendarNotes(spec: CalendarSpec): Both[] {
  const notes: Both[] = [];

  if (spec.shorthand !== null) {
    // Both with the time zone taken off the end, where there is one.
    const zoned = spec.utc || spec.zone !== null;
    const written = zoned ? spec.text.slice(0, spec.text.lastIndexOf(" ")) : spec.text;
    const meaning = zoned ? spec.normalized.slice(0, spec.normalized.lastIndexOf(" ")) : spec.normalized;
    notes.push({
      en: `“${written}” is shorthand for ${meaning}.`,
      vi: `“${written}” là cách viết tắt của ${meaning}.`,
    });
    const extra = SHORTHAND_NOTE[spec.shorthand];
    if (extra) notes.push(extra);
  }

  if (spec.timeOmitted && spec.epoch === null) {
    notes.push({
      en: "No time was written, so it fires at midnight, 00:00:00.",
      vi: "Không ghi giờ nên lịch chạy lúc nửa đêm, 00:00:00.",
    });
  }

  for (const change of spec.adjustments) {
    if (change.kind === "year") {
      notes.push({
        en: `The year ${change.written} is read as ${change.read}: two-digit years 00–69 are 2000–2069, and 70–99 are 1970–1999.`,
        vi: `Năm ${change.written} được hiểu là ${change.read}: năm hai chữ số 00–69 là 2000–2069, còn 70–99 là 1970–1999.`,
      });
    } else if (change.kind === "cut") {
      notes.push({
        en: `systemd reads ${change.written} as ${change.read}: a range ends at the last value its step reaches.`,
        vi: `systemd hiểu ${change.written} thành ${change.read}: khoảng kết thúc ở giá trị cuối cùng mà bước nhảy chạm tới.`,
      });
    } else if (change.kind === "single") {
      notes.push({
        en: `${change.written} can only ever match ${change.read}, so systemd stores it as ${change.read}.`,
        vi: `${change.written} chỉ có thể khớp với ${change.read}, nên systemd lưu nó thành ${change.read}.`,
      });
    }
  }
  if (spec.adjustments.some((change) => change.kind === "sorted")) {
    notes.push({
      en: "systemd sorts each list and drops repeated items, which is why the normalized form can differ from what was written.",
      vi: "systemd sắp xếp từng danh sách và bỏ các mục trùng, vì vậy dạng chuẩn hoá có thể khác với cách đã viết.",
    });
  }

  if (spec.weekdays !== 0 && spec.day !== null) {
    notes.push({
      en: "Both the weekday and the date must match. Cron joins its two day fields with OR; systemd always requires both.",
      vi: "Cả thứ lẫn ngày đều phải khớp. Cron nối hai trường ngày bằng OR; systemd luôn đòi cả hai.",
    });
  }

  if (spec.epoch !== null) {
    notes.push({
      en: "A @timestamp is one fixed moment in UTC, so the timer can elapse at most once.",
      vi: "Một @timestamp là một thời điểm cố định theo UTC, nên timer chỉ kích hoạt tối đa một lần.",
    });
  } else if (spec.day !== null && !spec.endOfMonth) {
    const days = chainValues(spec.day, "day");
    const months = spec.month === null ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : chainValues(spec.month, "month");
    const longest = (m: number) => (m === 2 ? 29 : daysInMonth(2001, m));
    const real = months.flatMap((m) => days.filter((d) => d <= longest(m)).map((d) => [m, d] as const));
    if (real.length === 0) {
      notes.push({
        en: "None of the chosen months has that date, so this never elapses.",
        vi: "Không tháng nào được chọn có ngày đó, nên lịch này không bao giờ chạy.",
      });
    } else if (real.every(([m, d]) => m === 2 && d === 29)) {
      notes.push({
        en: "29 February exists only in leap years, so this fires once every four years at most.",
        vi: "Ngày 29 tháng 2 chỉ có trong năm nhuận, nên lịch này chạy nhiều nhất bốn năm một lần.",
      });
    } else {
      // Days some chosen months lack, in a common year.
      const missing = { en: [] as string[], vi: [] as string[] };
      for (const d of days.filter((day) => day >= 29)) {
        const short = months.filter((m) => d > (m === 2 ? 28 : daysInMonth(2001, m)));
        if (short.length === 0) continue;
        const leapDay = d === 29 && short.length === 1 && short[0] === 2;
        missing.en.push(leapDay ? "29 February outside leap years" : `the ${ordinal(d)} in ${joinAnd(short.map((m) => EN_MONTHS[m - 1]!), "en")}`);
        missing.vi.push(leapDay ? "ngày 29 tháng 2 của năm không nhuận" : `ngày ${d} ${short.length === 1 ? "tháng" : "các tháng"} ${joinAnd(short.map(String), "vi")}`);
      }
      if (missing.en.length > 0) {
        const tip = days.every((d) => d >= 28);
        notes.push({
          en: `A date a month does not have is skipped, not moved: there is no elapse on ${joinAnd(missing.en, "en")}.${tip ? " For the last day of every month, write *-*~01." : ""}`,
          vi: `Ngày không có trong tháng sẽ bị bỏ qua chứ không dời đi: không có lần chạy nào vào ${joinAnd(missing.vi, "vi")}.${tip ? " Muốn chạy ngày cuối mỗi tháng, hãy viết *-*~01." : ""}`,
        });
      }
    }
  }

  if (spec.endOfMonth) {
    notes.push({
      en: "“~” counts days back from the end of the month: ~01 is the last day, ~02 the day before it.",
      vi: "“~” đếm ngày ngược từ cuối tháng: ~01 là ngày cuối cùng, ~02 là ngày liền trước.",
    });
  }

  if (spec.epoch === null && firesWithinAMinute(spec)) {
    notes.push({
      en: "A timer's AccuracySec= defaults to one minute, so systemd may delay each elapse by up to a minute and merge ones that fall close together. Set AccuracySec=1s, or lower, in the [Timer] section for a schedule this frequent.",
      vi: "AccuracySec= của timer mặc định là một phút, nên systemd có thể trễ mỗi lần chạy tới một phút và gộp các lần sát nhau. Với lịch dày như thế này, hãy đặt AccuracySec=1s hoặc nhỏ hơn trong mục [Timer].",
    });
  }

  if (spec.zone !== null) {
    const check = checkZone(spec.zone);
    if (check.status === "alias") {
      notes.push({
        en: `${spec.zone} is an old name for ${check.current}. Some distributions — Ubuntu 23.04 and later without the tzdata-legacy package — no longer ship it, and systemd then refuses the whole line. ${check.current} works everywhere.`,
        vi: `${spec.zone} là tên cũ của ${check.current}. Một số bản phân phối — Ubuntu 23.04 trở đi khi không cài gói tzdata-legacy — không còn tên này, và khi đó systemd từ chối cả dòng. ${check.current} thì dùng được ở mọi nơi.`,
      });
    }
    notes.push({
      en: `The times are read in ${spec.zone}, whatever zone the server is set to.`,
      vi: `Giờ được tính theo múi ${spec.zone}, bất kể máy chủ đặt múi giờ nào.`,
    });
  } else if (spec.utc) {
    notes.push({
      en: "The times are read in UTC, whatever zone the server is set to.",
      vi: "Giờ được tính theo UTC, bất kể máy chủ đặt múi giờ nào.",
    });
  }
  return notes;
}

/** True when the expression can elapse more than once in some minute. */
function firesWithinAMinute(spec: CalendarSpec): boolean {
  const second = spec.second;
  if (second === null) return true;
  return second.length > 1 || second.some((comp) => comp.repeat > 0);
}

const clockText = (wall: CalendarWall): string => `${two(wall.hour)}:${two(wall.minute)}`;

function dateText(wall: CalendarWall, lang: Lang): string {
  if (lang === "vi") return `${wall.day}/${wall.month}/${wall.year}`;
  return `${wall.day} ${EN_MONTHS[wall.month - 1]} ${wall.year}`;
}

const OPEN_FIELDS = ["month", "day", "hour", "minute", "second"] as const;
const FIELD_MAX: Readonly<Record<(typeof OPEN_FIELDS)[number], number>> = { month: 12, day: 31, hour: 23, minute: 59, second: LAST_US };

/**
 * Items with a step and no end that run past their field unevenly — `00/7`
 * stops at 21 and next proposes 28 — which is what systemd 259 mishandles.
 * `00/15` minutes lands exactly on the next hour and is left alone.
 */
export function unevenSteps(spec: CalendarSpec): { field: (typeof OPEN_FIELDS)[number]; item: CalendarComponent }[] {
  const found: { field: (typeof OPEN_FIELDS)[number]; item: CalendarComponent }[] = [];
  for (const field of OPEN_FIELDS) {
    const chain = spec[field];
    if (chain === null || (field === "day" && spec.endOfMonth)) continue;
    for (const item of chain) {
      if (item.stop >= 0 || item.repeat === 0) continue;
      // Days never land evenly: the months are not the same length.
      const max = FIELD_MAX[field];
      const even = field !== "day" && lastOf(item, max) + item.repeat === max + 1;
      if (!even) found.push({ field, item });
    }
  }
  return found;
}

/**
 * The same expression with every uneven step given its end — `00/7` written
 * `00..21/7` — or null when there is none. It matches exactly the same times,
 * and systemd stops at the end instead of overflowing past it.
 */
export function boundedForm(spec: CalendarSpec): string | null {
  const uneven = unevenSteps(spec);
  if (uneven.length === 0) return null;
  const bound = (field: (typeof OPEN_FIELDS)[number]): CalendarChain => {
    const chain = spec[field];
    const fixes = uneven.filter((u) => u.field === field).map((u) => u.item);
    if (chain === null || fixes.length === 0) return chain;
    return chain.map((item) => (fixes.includes(item) ? { start: item.start, stop: lastOf(item, FIELD_MAX[field]), repeat: item.repeat } : item));
  };
  return formatSpec({ ...spec, month: bound("month"), day: bound("day"), hour: bound("hour"), minute: bound("minute"), second: bound("second") });
}

/**
 * A warning about uneven open steps, when the expression has one. For hours,
 * minutes and seconds systemd 259 misreads them on ordinary days too; for days
 * and months only around a clock change, so those are named only for a zone
 * that has one.
 */
export function stepNotes(spec: CalendarSpec, zone: string, fromMs: number): Both[] {
  const fixed = boundedForm(spec);
  if (fixed === null) return [];
  const uneven = unevenSteps(spec);
  const daily = uneven.some((u) => u.field === "hour" || u.field === "minute" || u.field === "second");
  if (!daily && clockChanges(zone, fromMs, 400).length === 0) return [];
  const items = uneven.map((u) => formatChain([u.item], u.field, false));
  const list = (lang: Lang) => joinAnd(items, lang);
  return [
    {
      en: `${list("en")} ${items.length === 1 ? "is a step" : "are steps"} with no end. systemd 259 mishandles such a step when it runs past the end of its field: ${daily ? "crossing midnight, a new month or a new hour it resumes in the wrong place and skips runs, and " : ""}across a clock change it can give up altogether, after which the timer stops until restarted. Written ${fixed}, the expression means exactly the same times and systemd reads it correctly.`,
      vi: `${list("vi")} là bước nhảy không có điểm cuối. systemd 259 xử lý sai loại bước nhảy này khi nó vượt quá cuối trường: ${daily ? "khi sang ngày, sang tháng hay sang giờ mới, nó tiếp tục ở sai chỗ và bỏ sót lần chạy, còn " : ""}qua lúc đổi giờ nó có thể bỏ cuộc hẳn, và timer dừng cho tới khi được khởi động lại. Viết thành ${fixed} thì biểu thức vẫn đúng những thời điểm đó và systemd đọc đúng.`,
    },
  ];
}

/**
 * The clock changes in the coming year that touch this expression: a matching
 * time the clocks skip, or one that happens twice.
 */
export function clockChangeNotes(spec: CalendarSpec, zone: string, fromMs: number): Both[] {
  if (spec.epoch !== null) return [];
  const notes: Both[] = [];
  for (const change of clockChanges(zone, fromMs, 370)) {
    const minutes = Math.abs(change.after - change.before) / 60_000;
    const length = minutes % 60 === 0 ? { en: `${minutes / 60} hour${minutes === 60 ? "" : "s"}`, vi: `${minutes / 60} giờ` } : { en: `${minutes} minutes`, vi: `${minutes} phút` };
    if (change.after > change.before) {
      // Clocks jump forward: readings from `from` up to `to` do not exist.
      const hit = nextMatch(spec, change.from);
      if (hit === null || compareWall(hit, change.to) >= 0) continue;
      notes.push({
        en: `On ${dateText(change.from, "en")} the clocks in ${zone} jump forward ${length.en}, from ${clockText(change.from)} to ${clockText(change.to)}. ${clockText(hit)} does not exist that day, and systemd skips it — there is no catch-up run.`,
        vi: `Ngày ${dateText(change.from, "vi")}, đồng hồ ở ${zone} nhảy tới ${length.vi}, từ ${clockText(change.from)} lên ${clockText(change.to)}. Hôm đó không có ${clockText(hit)}, và systemd bỏ qua lần chạy này — không chạy bù.`,
      });
    } else {
      // Clocks go back: readings from `to` up to `from` happen twice.
      const hit = nextMatch(spec, change.to);
      if (hit === null || compareWall(hit, change.from) >= 0) continue;
      notes.push({
        en: `On ${dateText(change.to, "en")} the clocks in ${zone} go back ${length.en}, so ${clockText(change.to)}–${clockText(change.from)} happens twice. systemd fires ${clockText(hit)} once, the first time, and fires nothing during the repeat.`,
        vi: `Ngày ${dateText(change.to, "vi")}, đồng hồ ở ${zone} lùi lại ${length.vi}, nên khoảng ${clockText(change.to)}–${clockText(change.from)} diễn ra hai lần. systemd chạy ${clockText(hit)} một lần, ở lượt đầu, và không chạy gì trong lượt lặp lại.`,
      });
    }
  }
  return notes;
}

/* ------------------------------------------------------- from crontab */

/**
 * One crontab field as a calendar chain, item by item as it was written, so
 * `*∕15` stays a step and `1,4,7,10` stays a list. A step keeps the open form
 * `00/15` only when it lands exactly on the next hour, day or year; otherwise
 * it is given its last value — `00..21/7` — because systemd 259 mishandles an
 * open step that runs past its field's end across a clock change.
 */
function chainFromField(field: CronField, max: number): string {
  if (field.full) return "*";
  const pad = (v: number) => String(v).padStart(2, "0");
  const items = field.parts.flatMap((part) => {
    const last = part.from + Math.floor((Math.min(part.to, max) - part.from) / part.step) * part.step;
    if (last === part.from) return [pad(part.from)];
    if (part.step === 1) return [`${pad(part.from)}..${pad(last)}`];
    if (last + part.step === max + 1 && field.id !== "dom") return [`${pad(part.from)}/${part.step}`];
    return [`${pad(part.from)}..${pad(last)}/${part.step}`];
  });
  return [...new Set(items)].join(",");
}

/**
 * The OnCalendar= lines that elapse exactly when a crontab schedule runs.
 * Usually one line; two when cron joins its day fields with OR, which one
 * calendar event cannot say, since systemd requires a weekday and a date to
 * match together.
 */
export function fromCron(schedule: CronTimes): string[] {
  const { minute, hour, dom, month, dow } = schedule.fields;
  const time = `${chainFromField(hour, 23)}:${chainFromField(minute, 59)}:00`;
  const months = chainFromField(month, 12);
  const days = chainFromField(dom, 31);
  let bits = 0;
  for (const value of dow.values) bits |= 1 << ((value + 6) % 7);
  const weekdays = formatWeekdays(bits === ALL_DAYS ? 0 : bits);

  if (schedule.dayRule === "or") {
    if (dom.full || dow.full) return [`*-${months}-* ${time}`];
    return [`*-${months}-${days} ${time}`, `${weekdays} *-${months}-* ${time}`];
  }
  return [`${weekdays === "" ? "" : `${weekdays} `}*-${months}-${days} ${time}`];
}
