/**
 * Transaction reference codes whose first five digits carry the date:
 * two digits of year, then the ordinal day within that year.
 *
 *   262641267307
 *   ├┘└─┘└─────┘
 *   │  │    └── serial, assigned by the issuing system
 *   │  └─────── day 264 of the year
 *   └────────── year 26
 *
 * Day 264 of 2026 is 21 September 2026, which is the whole trick: the date is
 * an ordinal day, not a month and a day, so it cannot be read off by eye.
 *
 * Two digits of year name a year only once a century is assumed. The century is
 * a parameter rather than a constant here — a 1998 code and a 2098 code are the
 * same five digits, and nothing inside the code can tell them apart — but every
 * caller defaults to 2000, because that is where these codes come from.
 *
 * Error messages are Vietnamese and meant to be shown verbatim: this module
 * exists for a Vietnamese-language page, as `lunar.ts` does. Anything else
 * thrown from here is a bug.
 */

import { civilFromDays, daysFromCivil, isLeapYear, isoWeek, weekdayIndex } from "./epoch";
import { randomInt } from "./random";

/** A code that cannot name a date. The message is shown to the user as it is. */
export class TxCodeError extends Error {
  override name = "TxCodeError";
}

export const YEAR_DIGITS = 2;
export const DAY_DIGITS = 3;
/** Year plus day of year: the part that means something. */
export const DATE_DIGITS = YEAR_DIGITS + DAY_DIGITS;

/** The length these codes are issued at. Anything shorter still decodes; it is noted, not refused. */
export const TX_CODE_LENGTH = 12;

/** Past this, the input is not a code — it is a paste that went wrong. */
export const TX_CODE_MAX_DIGITS = 32;

/** How many codes one batch will read, so a pasted export cannot hang the page. */
export const TX_BATCH_LIMIT = 500;

export const DEFAULT_CENTURY = 2000;
export const CENTURIES = [1900, 2000, 2100] as const;

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface TxCode {
  /** The input with its separators removed — digits only. */
  readonly digits: string;
  readonly yearDigits: string;
  readonly dayDigits: string;
  /** Everything after the date. Empty when the code is exactly five digits. */
  readonly serial: string;
  readonly year: number;
  readonly dayOfYear: number;
  readonly daysInYear: number;
  readonly date: CivilDate;
  /** Monday is 0, as in `epoch.ts`. */
  readonly weekday: number;
  readonly week: { readonly year: number; readonly week: number };
  readonly quarter: number;
}

/**
 * Spelled out here rather than imported from `lunar.ts`: this page has no use
 * for the lunar calendar, and importing one constant from it would pull the
 * whole astronomy into the bundle.
 */
export const WEEKDAYS_VI = [
  "Thứ Hai",
  "Thứ Ba",
  "Thứ Tư",
  "Thứ Năm",
  "Thứ Sáu",
  "Thứ Bảy",
  "Chủ Nhật",
] as const;

/**
 * Codes get written down with spaces, dots or dashes in them, and pasted back
 * that way. Anything else that is not a digit is reported rather than dropped:
 * a stray letter usually means a whole different field was copied.
 */
const SEPARATORS = /[\s.,_\-/|]/gu;

export function normalizeTxCode(text: string): string {
  const digits = text.replace(SEPARATORS, "");
  if (digits === "") throw new TxCodeError("Hãy nhập mã giao dịch.");

  const stray = [...digits].find((ch) => ch < "0" || ch > "9");
  if (stray !== undefined) {
    throw new TxCodeError(`Mã giao dịch chỉ gồm chữ số, nhưng có ký tự “${stray}”.`);
  }
  if (digits.length < DATE_DIGITS) {
    throw new TxCodeError(
      `Mã giao dịch cần ít nhất ${DATE_DIGITS} chữ số — ${YEAR_DIGITS} chữ số năm và ${DAY_DIGITS} chữ số ngày — nhưng mã này chỉ có ${digits.length}.`,
    );
  }
  if (digits.length > TX_CODE_MAX_DIGITS) {
    throw new TxCodeError(
      `Mã giao dịch dài ${digits.length} chữ số, vượt quá ${TX_CODE_MAX_DIGITS}. Có lẽ hai mã đã bị dán liền nhau.`,
    );
  }
  return digits;
}

/** Reads the date out of a code. `century` decides which century the two year digits name. */
export function decodeTxCode(text: string, century: number = DEFAULT_CENTURY): TxCode {
  const digits = normalizeTxCode(text);
  const yearDigits = digits.slice(0, YEAR_DIGITS);
  const dayDigits = digits.slice(YEAR_DIGITS, DATE_DIGITS);
  const serial = digits.slice(DATE_DIGITS);

  const year = century + Number(yearDigits);
  const ordinal = Number(dayDigits);
  const daysInYear = isLeapYear(year) ? 366 : 365;

  if (ordinal === 0) {
    throw new TxCodeError("Ba chữ số ngày là 000, nhưng ngày trong năm được đánh số từ 001.");
  }
  if (ordinal > daysInYear) {
    throw new TxCodeError(
      `Mã ghi ngày thứ ${ordinal}, nhưng năm ${year} chỉ có ${daysInYear} ngày${isLeapYear(year) ? " (năm nhuận)" : ""}.`,
    );
  }

  const date = civilFromDays(daysFromCivil(year, 1, 1) + ordinal - 1);
  return {
    digits,
    yearDigits,
    dayDigits,
    serial,
    year,
    dayOfYear: ordinal,
    daysInYear,
    date,
    weekday: weekdayIndex(date.year, date.month, date.day),
    week: isoWeek(date.year, date.month, date.day),
    quarter: Math.ceil(date.month / 3),
  };
}

/** The five digits every code issued on `date` begins with. */
export function prefixFor(date: CivilDate, century: number = DEFAULT_CENTURY): string {
  const offset = date.year - century;
  if (offset < 0 || offset > 99) {
    throw new TxCodeError(
      `Năm ${date.year} nằm ngoài thế kỷ ${century}–${century + 99}, nên hai chữ số năm không diễn tả được nó.`,
    );
  }
  const ordinal =
    daysFromCivil(date.year, date.month, date.day) - daysFromCivil(date.year, 1, 1) + 1;
  return `${pad(offset, YEAR_DIGITS)}${pad(ordinal, DAY_DIGITS)}`;
}

/**
 * A sample code for `date`: the real five-digit prefix with a random tail, for
 * filling a test system or a screenshot. The digits come from the browser's
 * CSPRNG like everything else here — not because they are a secret, but because
 * it is the one source of randomness this site uses.
 */
export function sampleTxCode(
  date: CivilDate,
  century: number = DEFAULT_CENTURY,
  length: number = TX_CODE_LENGTH,
): string {
  if (length < DATE_DIGITS || length > TX_CODE_MAX_DIGITS) {
    throw new TxCodeError(`Độ dài mã phải từ ${DATE_DIGITS} đến ${TX_CODE_MAX_DIGITS} chữ số.`);
  }
  let serial = "";
  for (let i = DATE_DIGITS; i < length; i += 1) serial += String(randomInt(10));
  return prefixFor(date, century) + serial;
}

export interface TxCodeLine {
  /** The line as typed, trimmed. */
  readonly input: string;
  readonly code: TxCode | null;
  /** Vietnamese, already fit to show. Null when the line decoded. */
  readonly error: string | null;
}

/** Reads a pasted list, one code per line. Blank lines are skipped, not counted. */
export function decodeLines(text: string, century: number = DEFAULT_CENTURY): TxCodeLine[] {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length > TX_BATCH_LIMIT) {
    throw new TxCodeError(
      `Mỗi lần đọc tối đa ${TX_BATCH_LIMIT} mã, danh sách này có ${lines.length}. Hãy chia nhỏ ra.`,
    );
  }

  return lines.map((input) => {
    try {
      return { input, code: decodeTxCode(input, century), error: null };
    } catch (error) {
      return { input, code: null, error: messageOf(error) };
    }
  });
}

/**
 * The module's own refusals are Vietnamese and shown as they are; anything else
 * that throws is a bug here, and gets a Vietnamese sentence rather than an
 * English engine message.
 */
export function messageOf(error: unknown): string {
  return error instanceof TxCodeError ? error.message : "Không đọc được mã giao dịch này.";
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 21/09/2026 — the form a Vietnamese receipt prints. */
export function formatDate(date: CivilDate): string {
  return `${pad(date.day, 2)}/${pad(date.month, 2)}/${pad(date.year, 4)}`;
}

export function formatIso(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

export function weekdayName(code: TxCode): string {
  return WEEKDAYS_VI[code.weekday]!;
}

/**
 * How far a date is from today, in days. Exact rather than rounded to months or
 * years: the question people bring here is *which day*, so a vague "khoảng 3
 * tháng trước" would be a worse answer than the count itself.
 */
export function describeGap(days: number): string {
  if (days === 0) return "hôm nay";
  if (days === -1) return "hôm qua";
  if (days === 1) return "ngày mai";
  const count = Math.abs(days).toLocaleString("vi-VN");
  return days < 0 ? `cách đây ${count} ngày` : `còn ${count} ngày nữa`;
}

/** Whole days from `from` to `to`, both civil dates. */
export function daysBetween(from: CivilDate, to: CivilDate): number {
  return daysFromCivil(to.year, to.month, to.day) - daysFromCivil(from.year, from.month, from.day);
}
