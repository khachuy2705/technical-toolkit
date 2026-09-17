/**
 * The Vietnamese lunisolar calendar (âm lịch), converted to and from the
 * Gregorian one.
 *
 * The astronomy follows Hồ Ngọc Đức's published algorithm
 * (https://www.xemamlich.uhm.vn/calrules.html): new moons and the sun's
 * longitude from truncated series, evaluated on the 105°E meridian (UTC+7).
 * The rules are the calendar's own:
 *
 * - a month starts on the day that contains the new moon (ngày Sóc);
 * - the winter solstice always falls in month 11;
 * - a year with 13 months between two month-11s has a leap month, and it is the
 *   first month after the solstice that contains no major solar term
 *   (trung khí). It takes the number of the month before it.
 *
 * Deliberate departures from the article's sample code, each of which that
 * code gets wrong:
 *
 * - `lunarToSolar` checks the day against the month's real length. The sample
 *   turns "day 30" of a 29-day month into the first day of the next month.
 * - A leap flag on a year or month that has no leap month is an error rather
 *   than being silently ignored.
 * - A leap month right after month 12 is numbered 12. The sample computes
 *   `leapOff - 2` and only wraps negatives, so it would call that month 0.
 * - The month search brackets the date instead of trusting a one-step
 *   estimate, which in the sample yields "day 0" near some month boundaries.
 * - Lunar years before 1968 are computed for UTC+8, as the calendar in use
 *   then was — see `eraOffset`.
 *
 * Error messages are Vietnamese: this module exists for the Vietnamese-language
 * lunar calendar page, and they are shown there verbatim.
 *
 * Dates are proleptic Gregorian throughout, via `daysFromCivil`. The article
 * switches to the Julian calendar before 1582, which is irrelevant inside the
 * supported range below and would only be a trap outside it.
 */

import { civilFromDays, daysFromCivil } from "./epoch";

/**
 * A date or month that does not exist. The message is Vietnamese and meant to
 * be shown to the user as it is; anything else thrown from here is a bug.
 */
export class LunarError extends Error {
  override name = "LunarError";
}

/** Hanoi, 105°E. The Chinese calendar computes the same things at UTC+8. */
export const VIETNAM_UTC_OFFSET = 7;

/**
 * The years this page will convert. The series are truncated, so their error
 * grows away from the present; this span is where the results have been
 * checked day by day against a full-precision reference (see design.md).
 */
export const LUNAR_MIN_YEAR = 1900;
export const LUNAR_MAX_YEAR = 2199;

/** Julian day number of 1970-01-01, which `daysFromCivil` counts from. */
const JD_UNIX = 2440588;

const INT = Math.floor;
const DR = Math.PI / 180;

/** The mean synodic month, as the article uses it for month counting. */
const SYNODIC = 29.530588853;
/** Julian day of the new moon the article counts from (1900-01-01). */
const NEW_MOON_EPOCH = 2415021.076998695;

export interface SolarDate {
  day: number;
  month: number;
  year: number;
}

export interface LunarDate {
  day: number;
  month: number;
  /** The lunar year, which runs from Tết to Tết and so straddles two solar years. */
  year: number;
  leap: boolean;
}

export function jdFromSolar(date: SolarDate): number {
  return daysFromCivil(date.year, date.month, date.day) + JD_UNIX;
}

export function solarFromJd(jd: number): SolarDate {
  return civilFromDays(jd - JD_UNIX);
}

/**
 * Julian day number of the day (in the given zone) containing the k-th new
 * moon after the one on 1900-01-01.
 */
export function newMoonDay(k: number, utcOffset = VIETNAM_UTC_OFFSET): number {
  const T = k / 1236.85; // Julian centuries from 1900 January 0.5
  const T2 = T * T;
  const T3 = T2 * T;

  let jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * T2 - 0.000000155 * T3;
  jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * DR); // mean new moon

  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3; // sun's mean anomaly
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3; // moon's mean anomaly
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3; // moon's argument of latitude

  let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * DR) + 0.0021 * Math.sin(2 * DR * M);
  C1 = C1 - 0.4068 * Math.sin(Mpr * DR) + 0.0161 * Math.sin(DR * 2 * Mpr);
  C1 = C1 - 0.0004 * Math.sin(DR * 3 * Mpr);
  C1 = C1 + 0.0104 * Math.sin(DR * 2 * F) - 0.0051 * Math.sin(DR * (M + Mpr));
  C1 = C1 - 0.0074 * Math.sin(DR * (M - Mpr)) + 0.0004 * Math.sin(DR * (2 * F + M));
  C1 = C1 - 0.0004 * Math.sin(DR * (2 * F - M)) - 0.0006 * Math.sin(DR * (2 * F + Mpr));
  C1 = C1 + 0.001 * Math.sin(DR * (2 * F - Mpr)) + 0.0005 * Math.sin(DR * (2 * Mpr + M));

  // ΔT, the drift between the uniform time the series use and clock time.
  const deltaT =
    T < -11
      ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3
      : -0.000278 + 0.000265 * T + 0.000262 * T2;

  const jdNew = jd1 + C1 - deltaT;
  return INT(jdNew + 0.5 + utcOffset / 24);
}

/**
 * Which of the twelve 30° arcs of the ecliptic the sun is in at local midnight
 * starting day `jdn`: 0 from the March equinox (Xuân phân) to Cốc vũ, 1 to
 * Tiểu mãn, … 9 from the winter solstice (Đông chí). A month whose first day
 * and the next month's first day give the same arc contains no major term.
 */
export function sunArc(jdn: number, utcOffset = VIETNAM_UTC_OFFSET): number {
  const T = (jdn - 2451545.5 - utcOffset / 24) / 36525; // Julian centuries from J2000
  const T2 = T * T;
  const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2; // mean anomaly
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2; // mean longitude

  let DL = (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(DR * M);
  DL += (0.019993 - 0.000101 * T) * Math.sin(DR * 2 * M) + 0.00029 * Math.sin(DR * 3 * M);

  let L = (L0 + DL) * DR; // true longitude, radians
  L -= Math.PI * 2 * INT(L / (Math.PI * 2));
  return INT((L / Math.PI) * 6);
}

/** Julian day on which the lunar month 11 containing the winter solstice of `year` begins. */
export function month11Start(year: number, utcOffset = VIETNAM_UTC_OFFSET): number {
  const off = jdFromSolar({ day: 31, month: 12, year }) - 2415021;
  const k = INT(off / SYNODIC);
  const nm = newMoonDay(k, utcOffset);
  // The new moon before 31 December starts month 11 only if the solstice has
  // not already passed by then; otherwise month 11 began one lunation earlier.
  return sunArc(nm, utcOffset) >= 9 ? newMoonDay(k - 1, utcOffset) : nm;
}

/** The lunation index `k` of the month starting on `jd`. */
function lunationOf(jd: number): number {
  return INT((jd - NEW_MOON_EPOCH) / SYNODIC + 0.5);
}

/**
 * How many months after month 11 (starting `a11`) the leap month sits, in a
 * year known to have one: 1 means the month straight after month 11.
 */
function leapOffset(a11: number, utcOffset: number): number {
  const k = lunationOf(a11);
  let i = 1;
  let arc = sunArc(newMoonDay(k + i, utcOffset), utcOffset);
  let last: number;
  do {
    last = arc;
    i += 1;
    arc = sunArc(newMoonDay(k + i, utcOffset), utcOffset);
  } while (arc !== last && i < 14);
  return i - 1;
}

/** The month number a leap month takes: the number of the month before it. Exported for tests. */
export function leapMonthNumber(offset: number): number {
  // Offset 1 follows month 11, offset 2 follows month 12, offset 3 follows 1…
  return ((offset + 9) % 12) + 1;
}

interface LunarYearFrame {
  /** Start of month 11 of the previous solar year, where this lunar year's count begins. */
  a11: number;
  /** Start of the next month 11. */
  b11: number;
  /** Offset of the leap month after `a11`, or null in a common year. */
  leapOffset: number | null;
}

function frame(a11: number, b11: number, utcOffset: number): LunarYearFrame {
  return { a11, b11, leapOffset: b11 - a11 > 365 ? leapOffset(a11, utcOffset) : null };
}

/**
 * The meridian the calendar in use was computed for, by lunar year.
 *
 * North Vietnam adopted UTC+7 for the calendar from lunar year 1968 (Mậu
 * Thân); before that the calendar in use followed the Chinese one, computed
 * for UTC+8. That switch is why Tết 1968 fell on 29 January in Hanoi and on
 * 30 January in Beijing. Hồ Ngọc Đức's own reference tables encode the same
 * history, and a single meridian throughout would convert 1950s dates — the
 * birthdays people most often look up — against a calendar nobody printed.
 */
export const UTC7_FROM_YEAR = 1968;

export function eraOffset(lunarYear: number): number {
  return lunarYear < UTC7_FROM_YEAR ? 8 : VIETNAM_UTC_OFFSET;
}

function checkYear(year: number): void {
  if (!Number.isInteger(year) || year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) {
    throw new LunarError(
      `Chỉ hỗ trợ các năm từ ${LUNAR_MIN_YEAR} đến ${LUNAR_MAX_YEAR}; năm ${year} nằm ngoài khoảng này.`,
    );
  }
}

export function solarToLunar(date: SolarDate): LunarDate {
  checkYear(date.year);
  // The UTC+7 reading decides the era: its Tết 1968 is the earlier of the two,
  // so any date it places before lunar 1968 is before the switch in both.
  const modern = solarToLunarAt(date, VIETNAM_UTC_OFFSET);
  return modern.year >= UTC7_FROM_YEAR ? modern : solarToLunarAt(date, eraOffset(modern.year));
}

/** The article's conversion, at one fixed meridian. */
export function solarToLunarAt(date: SolarDate, utcOffset: number): LunarDate {
  const dayNumber = jdFromSolar(date);

  // The article estimates the lunation from the mean month and steps back at
  // most once. The true new moon wanders up to about 14 hours from the mean
  // one, so near a month boundary that estimate can be a whole lunation off,
  // and the sample then reports day 0 (it does for 7 May 2054). Walking until
  // the date is bracketed cannot be wrong.
  let k = INT((dayNumber - NEW_MOON_EPOCH) / SYNODIC) + 1;
  while (newMoonDay(k, utcOffset) > dayNumber) k -= 1;
  while (newMoonDay(k + 1, utcOffset) <= dayNumber) k += 1;
  const monthStart = newMoonDay(k, utcOffset);

  let a11 = month11Start(date.year, utcOffset);
  let b11 = a11;
  let year: number;
  if (a11 >= monthStart) {
    year = date.year;
    a11 = month11Start(date.year - 1, utcOffset);
  } else {
    year = date.year + 1;
    b11 = month11Start(date.year + 1, utcOffset);
  }

  const { leapOffset: leapAt } = frame(a11, b11, utcOffset);
  const diff = INT((monthStart - a11) / 29);

  let month = diff + 11;
  let leap = false;
  if (leapAt !== null && diff >= leapAt) {
    month = diff + 10;
    leap = diff === leapAt;
  }
  if (month > 12) month -= 12;
  // Months 11 and 12 near the start of the count belong to the lunar year
  // before the one that ends at `b11`.
  if (month >= 11 && diff < 4) year -= 1;

  return { day: dayNumber - monthStart + 1, month, year, leap };
}

/** The frame of months that holds `month` of `lunarYear`: 11 and 12 sit in the later one. */
function frameFor(month: number, lunarYear: number, utcOffset: number): LunarYearFrame {
  const opensIn = month < 11 ? lunarYear - 1 : lunarYear;
  return frame(month11Start(opensIn, utcOffset), month11Start(opensIn + 1, utcOffset), utcOffset);
}

/** The leap month of a lunar year (1–12), or null if it has none. */
export function leapMonthOf(lunarYear: number): number | null {
  checkYear(lunarYear);
  const tz = eraOffset(lunarYear);
  // A frame runs month 11 to month 10, so a leap month numbered 11 or 12
  // belongs to the lunar year before. Both frames that touch this year have
  // to be asked.
  const early = frameFor(1, lunarYear, tz).leapOffset;
  if (early !== null && leapMonthNumber(early) < 11) return leapMonthNumber(early);
  const late = frameFor(11, lunarYear, tz).leapOffset;
  if (late !== null && leapMonthNumber(late) >= 11) return leapMonthNumber(late);
  return null;
}

function monthNotFound(month: number, lunarYear: number): LunarError {
  const actual = leapMonthOf(lunarYear);
  return new LunarError(
    actual === null
      ? `Năm ${lunarYear} không có tháng nhuận.`
      : `Năm ${lunarYear} nhuận tháng ${actual}, không phải tháng ${month}.`,
  );
}

/** Julian day on which a lunar month begins, in its own era. */
function monthStartJd(month: number, lunarYear: number, leap: boolean): number {
  const tz = eraOffset(lunarYear);
  const f = frameFor(month, lunarYear, tz);

  let off = month - 11;
  if (off < 0) off += 12;

  if (f.leapOffset === null) {
    if (leap) throw monthNotFound(month, lunarYear);
  } else {
    // The frame's leap month can belong to the neighbouring lunar year; that
    // case also fails this comparison, because its number is 11 or 12 for a
    // month below 11 and the other way round.
    if (leap && month !== leapMonthNumber(f.leapOffset)) throw monthNotFound(month, lunarYear);
    if (leap || off >= f.leapOffset) off += 1;
  }

  return newMoonDay(lunationOf(f.a11) + off, tz);
}

export interface LunarMonthSpan {
  /** Julian day of day 1. */
  start: number;
  /** 29 (tháng thiếu) or 30 (tháng đủ). */
  length: number;
}

/**
 * Where a lunar month falls. Throws, naming the problem, for a month that does
 * not exist — including a leap flag on a month that is not the year's leap
 * month.
 */
export function lunarMonthSpan(month: number, lunarYear: number, leap: boolean): LunarMonthSpan {
  checkYear(lunarYear);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new LunarError(`Không có tháng ${month} âm lịch; tháng chỉ từ 1 đến 12.`);
  }

  const start = monthStartJd(month, lunarYear, leap);
  const isLast = month === 12 && (leap || leapMonthOf(lunarYear) !== 12);

  // The last month of a year ends where the next year's Tết begins, computed
  // in that year's own era. Everywhere but the 1967/1968 switch that is the
  // next new moon anyway; at the switch it is what stops the last month of
  // 1967 (UTC+8) running a day into Tết 1968 (UTC+7).
  const end =
    isLast && lunarYear < LUNAR_MAX_YEAR
      ? monthStartJd(1, lunarYear + 1, false)
      : newMoonDay(lunationOf(start) + 1, eraOffset(lunarYear));
  return { start, length: end - start };
}

export function lunarToSolar(date: LunarDate): SolarDate {
  const span = lunarMonthSpan(date.month, date.year, date.leap);
  if (!Number.isInteger(date.day) || date.day < 1 || date.day > span.length) {
    const name = `Tháng ${date.month}${date.leap ? " nhuận" : ""} năm ${date.year}`;
    throw new LunarError(
      span.length === 29
        ? `${name} chỉ có 29 ngày (tháng thiếu), không có ngày ${date.day}.`
        : `${name} có ${span.length} ngày, không có ngày ${date.day}.`,
    );
  }
  return solarFromJd(span.start + date.day - 1);
}

export interface LunarMonthRow {
  month: number;
  leap: boolean;
  start: SolarDate;
  length: number;
}

/** Every month of a lunar year in order, the leap month in its place. */
export function lunarYearMonths(lunarYear: number): LunarMonthRow[] {
  const leapMonth = leapMonthOf(lunarYear);
  const rows: LunarMonthRow[] = [];
  for (let month = 1; month <= 12; month += 1) {
    for (const leap of month === leapMonth ? [false, true] : [false]) {
      const span = lunarMonthSpan(month, lunarYear, leap);
      rows.push({ month, leap, start: solarFromJd(span.start), length: span.length });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------- Can Chi */

export const CAN = ["Giáp", "Ất", "Bính", "Đinh", "Mậu", "Kỷ", "Canh", "Tân", "Nhâm", "Quý"] as const;
export const CHI = ["Tý", "Sửu", "Dần", "Mão", "Thìn", "Tỵ", "Ngọ", "Mùi", "Thân", "Dậu", "Tuất", "Hợi"] as const;

export function yearCanChi(lunarYear: number): string {
  return `${CAN[(((lunarYear + 6) % 10) + 10) % 10]} ${CHI[(((lunarYear + 8) % 12) + 12) % 12]}`;
}

/** A leap month has no name of its own; it borrows its predecessor's, plus "nhuận". */
export function monthCanChi(month: number, lunarYear: number, leap = false): string {
  const can = CAN[(((lunarYear * 12 + month + 3) % 10) + 10) % 10];
  const chi = CHI[(month + 1) % 12];
  return `${can} ${chi}${leap ? " nhuận" : ""}`;
}

export function dayCanChi(jd: number): string {
  return `${CAN[(jd + 9) % 10]} ${CHI[(jd + 1) % 12]}`;
}

export const WEEKDAYS_VI = [
  "Thứ Hai",
  "Thứ Ba",
  "Thứ Tư",
  "Thứ Năm",
  "Thứ Sáu",
  "Thứ Bảy",
  "Chủ Nhật",
] as const;

/** Monday is 0, matching `WEEKDAYS` in epoch.ts. */
export function weekdayOfJd(jd: number): number {
  return jd % 7;
}

/** `17/2/2026`, the order Vietnamese dates are written in. */
export function formatDmy(date: { day: number; month: number; year: number }): string {
  return `${date.day}/${date.month}/${date.year}`;
}

export function formatLunar(date: LunarDate): string {
  return `${date.day}/${date.month}${date.leap ? " nhuận" : ""}/${date.year}`;
}

const MONTH_WORDS = [
  "Giêng",
  "Hai",
  "Ba",
  "Tư",
  "Năm",
  "Sáu",
  "Bảy",
  "Tám",
  "Chín",
  "Mười",
  "Mười Một",
  "Chạp",
] as const;

/** "Mùng 7 tháng Tám năm Bính Ngọ" — how a lunar date is said aloud. */
export function spellLunar(date: LunarDate): string {
  const day = date.day <= 10 ? `Mùng ${date.day}` : `Ngày ${date.day}`;
  const month = `tháng ${MONTH_WORDS[date.month - 1]}${date.leap ? " nhuận" : ""}`;
  return `${day} ${month} năm ${yearCanChi(date.year)}`;
}
