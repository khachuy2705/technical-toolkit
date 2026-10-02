/**
 * Checks for `src/lib/oncalendar.ts`. The unit file analyzer's checks are in
 * verify-units.ts, which borrows the systemd runner from here.
 *
 * Three kinds of evidence, in falling order of independence:
 *
 * - **systemd itself.** Where `systemd-analyze` can be run — on Linux, or
 *   through WSL on Windows — hundreds of generated expressions are put to it
 *   and to the library, and the validity, the normalized form and the next
 *   elapses must agree. Without it these checks are skipped, as the OpenSSL
 *   ones are.
 * - **Pinned answers from systemd 259**, recorded from `systemd-analyze` and
 *   asserted on every run: normalized forms, refusals, and elapses around
 *   real clock changes in New York, Lord Howe and Santiago.
 * - **An independent matcher** that expands the normalized text into sets and
 *   tests every minute of every day, sharing no code with the library, and a
 *   round trip through cron: crontab schedules converted to OnCalendar= must
 *   elapse exactly when cron.ts says cron runs them.
 */

import { spawnSync } from "node:child_process";
import {
  CalendarError,
  boundedForm,
  calendarNotes,
  clockChangeNotes,
  describeCalendar,
  describeField,
  fromCron,
  nextElapses,
  nextMatch,
  parseCalendar,
  scheduleZone,
  stepNotes,
  type CalendarWall,
  type ElapseSearch,
} from "../src/lib/oncalendar";
import { nextRuns, parseSchedule, type CronTimes } from "../src/lib/cron";
import { daysFromCivil, daysInMonth, parseWallTime, wallTimeToMs } from "../src/lib/epoch";
import type { Check } from "./verify-tools";

/* ------------------------------------------------------------- systemd */

/**
 * A way to run a POSIX shell script on a machine with systemd-analyze, or
 * null. On Windows, WSL provides one if a distribution with systemd is set up.
 */
export function findSystemd(): ((script: string) => string) | null {
  const run = (command: string, args: string[], input?: string) =>
    spawnSync(command, args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });

  const direct = run("systemd-analyze", ["--version"]);
  if (!direct.error && direct.status === 0) return (script) => run("sh", ["-s"], script).stdout ?? "";
  if (process.platform === "win32") {
    const wsl = run("wsl", ["-e", "systemd-analyze", "--version"]);
    if (!wsl.error && wsl.status === 0) return (script) => run("wsl", ["-e", "sh", "-s"], script).stdout ?? "";
  }
  return null;
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

interface CalendarAnswer {
  /** The normalized form, or null when systemd refused the expression. */
  readonly normalized: string | null;
  /** Elapses as UTC seconds. */
  readonly elapses: readonly number[];
  /**
   * systemd could not compute one of the elapses ("Infinite loop in calendar
   * calculation"). systemd-analyze then prints none of them.
   */
  readonly failed: boolean;
}

interface CalendarQuery {
  readonly expression: string;
  readonly zone: string;
  /** Unix seconds. */
  readonly base: number;
  readonly iterations: number;
}

/** Puts every query to `systemd-analyze calendar` in one shell run. */
function askSystemd(shell: (script: string) => string, queries: readonly CalendarQuery[]): CalendarAnswer[] {
  const script = queries
    .map(
      (q, i) =>
        `echo '@@@ ${i}'; TZ=${quote(q.zone)} systemd-analyze calendar --base-time=@${q.base} --iterations=${q.iterations} -- ${quote(q.expression)} 2>&1`,
    )
    .join("\n");
  const output = shell(`${script}\n`);
  const blocks = output.split(/^@@@ (\d+)$/m);
  const answers: CalendarAnswer[] = queries.map(() => ({ normalized: null, elapses: [], failed: false }));
  for (let k = 1; k < blocks.length; k += 2) {
    const index = Number(blocks[k]);
    const body = blocks[k + 1] ?? "";
    if (/Failed to determine next elapse/.test(body)) {
      // It parsed, so ask for the normalized form alone.
      answers[index] = { normalized: /Infinite loop in calendar calculation: (.*)$/m.exec(body)?.[1] ?? "?", elapses: [], failed: true };
      continue;
    }
    const normalized = /^Normalized form: (.*)$/m.exec(body)?.[1] ?? null;
    const utc = (line: string) => /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(line.trim());
    const lines = body.split("\n");
    let stamps = lines.filter((line) => line.includes("(in UTC):")).map(utc);
    if (stamps.length === 0) stamps = lines.filter((line) => /Next elapse:|Iteration #\d+:/.test(line)).map(utc);
    const elapses = stamps
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => daysFromCivil(+m[1]!, +m[2]!, +m[3]!) * 86_400 + +m[4]! * 3600 + +m[5]! * 60 + +m[6]!);
    answers[index] = { normalized, elapses, failed: false };
  }
  return answers;
}

/** mulberry32, seeded so a failing expression can be reproduced. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * A random calendar expression, mostly valid. `wholeSeconds` keeps seconds to
 * whole numbers, for the matcher below, which works a minute at a time.
 */
function randomCalendar(rng: () => number, wholeSeconds = false): string {
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const pad = (v: number, w = 2) => String(v).padStart(w, "0");
  const chain = (lo: number, hi: number, width = 2, star = 0.4): string => {
    if (rng() < star) return "*";
    const item = (): string => {
      const r = rng();
      const a = int(lo, hi);
      if (r < 0.45) return pad(a, width);
      const b = int(a, hi);
      if (r < 0.65) return `${pad(a, width)}..${pad(b, width)}`;
      if (r < 0.82) return `${pad(a, width)}..${pad(b, width)}/${int(1, Math.max(1, hi - lo))}`;
      return `${pad(a, width)}/${int(1, Math.max(1, Math.floor((hi - lo) / 2)))}`;
    };
    const count = rng() < 0.75 ? 1 : int(2, 3);
    return Array.from({ length: count }, item).join(",");
  };

  const parts: string[] = [];
  if (rng() < 0.35) {
    const days: string[] = [];
    const count = int(1, 3);
    for (let i = 0; i < count; i += 1) {
      const a = int(0, 6);
      const name = (d: number) => (rng() < 0.15 ? LONG_DAYS[d]! : DAYS[d]!);
      if (rng() < 0.35 && a < 6) days.push(`${name(a)}..${name(int(a + 1, 6))}`);
      else days.push(name(a));
    }
    parts.push(days.join(","));
  }
  const date = rng();
  if (date < 0.25) parts.push(`${rng() < 0.6 ? "*" : chain(2025, 2032, 4, 0)}-${chain(1, 12)}-${chain(1, 31)}`);
  else if (date < 0.4) parts.push(`${chain(1, 12)}-${chain(1, 31)}`);
  else if (date < 0.5) parts.push(`*-${chain(1, 12)}~${chain(1, 10, 2, 0)}`);
  if (rng() < 0.85 || parts.length === 0) {
    const seconds = rng() < 0.6 ? "" : `:${wholeSeconds ? chain(0, 59) : rng() < 0.15 ? `${pad(int(0, 58))}.${int(1, 9)}` : chain(0, 59)}`;
    parts.push(`${chain(0, 23)}:${chain(0, 59, 2, 0.3)}${seconds}`);
  }
  if (!wholeSeconds) {
    const zone = rng();
    if (zone < 0.08) parts.push("UTC");
    else if (zone < 0.14) parts.push("Europe/Berlin");
    else if (zone < 0.18) parts.push("America/New_York");
  }
  return parts.join(" ");
}

/* ------------------------------------------------- independent matcher */

/** The values of one field of a normalized form, expanded straight from systemd.time(7). */
function oracleSet(text: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  if (text === "*") {
    for (let v = lo; v <= hi; v += 1) out.add(v);
    return out;
  }
  for (const item of text.split(",")) {
    const [range, step] = item.split("/") as [string, string | undefined];
    const [a, b] = range.split("..") as [string, string | undefined];
    const start = Number(a);
    const stop = b !== undefined ? Number(b) : step !== undefined ? hi : start;
    const by = step !== undefined ? Number(step) : 1;
    for (let v = start; v <= stop && v <= hi; v += by) out.add(v);
  }
  return out;
}

/** Days of one month for a `~` field: each value counts back from the month's last day. */
function oracleEndOfMonth(text: string, last: number): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [range, step] = item.split("/") as [string, string | undefined];
    const [a, b] = range.split("..") as [string, string | undefined];
    const by = step !== undefined ? Number(step) : 1;
    // ~A..B is the days from the B-th-last to the A-th-last; ~A/S runs from the A-th-last towards the end.
    const first = last + 1 - (b !== undefined ? Number(b) : Number(a));
    const final = b !== undefined || step !== undefined ? (b !== undefined ? last + 1 - Number(a) : last) : first;
    for (let d = first; d <= final; d += by) out.add(d);
  }
  return out;
}

/** The first `count` matching walls at or after `from`, by looking at every minute of every candidate day. */
function oracleMatches(normalized: string, from: CalendarWall, count: number, horizonDays: number): CalendarWall[] {
  const words = normalized.split(" ");
  const weekdayText = /^[A-Z]/.test(words[0]!) ? words.shift()! : null;
  const [dateText, timeText] = words as [string, string];
  const eom = dateText.includes("~");
  const [yearText, monthText, dayText] = dateText.split(/[-~]/) as [string, string, string];
  const [hourText, minuteText, secondText] = timeText.split(":") as [string, string, string];

  const weekdays = new Set<number>();
  if (weekdayText === null) for (let d = 0; d < 7; d += 1) weekdays.add(d);
  else {
    for (const item of weekdayText.split(",")) {
      const [a, b] = item.split("..");
      const from = DAYS.indexOf(a!);
      const to = b === undefined ? from : DAYS.indexOf(b);
      for (let d = from; d <= to; d += 1) weekdays.add(d);
    }
  }
  const years = oracleSet(yearText, 1970, 2199);
  const months = oracleSet(monthText, 1, 12);
  const hours = oracleSet(hourText, 0, 23);
  const minutes = oracleSet(minuteText, 0, 59);
  const seconds = [...oracleSet(secondText, 0, 59)].sort((a, b) => a - b);

  const out: CalendarWall[] = [];
  const firstDay = daysFromCivil(from.year, from.month, from.day);
  for (let n = firstDay; n < firstDay + horizonDays && out.length < count; n += 1) {
    const date = new Date(n * 86_400_000);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (y > 2199) break;
    if (!years.has(y) || !months.has(m)) continue;
    const last = daysInMonth(y, m);
    const days = eom ? oracleEndOfMonth(dayText, last) : oracleSet(dayText, 1, 31);
    if (!days.has(d)) continue;
    if (!weekdays.has((date.getUTCDay() + 6) % 7)) continue;
    for (let minute = 0; minute < 1440 && out.length < count; minute += 1) {
      const h = Math.floor(minute / 60);
      const mi = minute % 60;
      if (!hours.has(h) || !minutes.has(mi)) continue;
      for (const s of seconds) {
        const wall = { year: y, month: m, day: d, hour: h, minute: mi, us: s * 1_000_000 };
        if (compare(wall, from) >= 0) out.push(wall);
        if (out.length === count) break;
      }
    }
  }
  return out;
}

const compare = (a: CalendarWall, b: CalendarWall): number =>
  a.year - b.year || a.month - b.month || a.day - b.day || a.hour - b.hour || a.minute - b.minute || a.us - b.us;

const wallText = (w: CalendarWall): string =>
  `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.us / 1e6).padStart(2, "0")}`;

/* -------------------------------------------------------------- helpers */

function refusal(attempt: () => unknown): { en: string; vi: string; typed: boolean; cron: boolean } {
  try {
    attempt();
    return { en: "", vi: "", typed: false, cron: false };
  } catch (error) {
    if (error instanceof CalendarError) return { ...error.text, typed: true, cron: error.cron };
    return { en: (error as Error).message, vi: "", typed: false, cron: false };
  }
}

/** Unix seconds of a wall time in a zone. */
function at(zone: string, text: string): number {
  return wallTimeToMs(parseWallTime(text), zone).ms / 1000;
}

const utcText = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");

function searchFrom(expression: string, zone: string, base: number, count: number): ElapseSearch {
  const spec = parseCalendar(expression);
  return nextElapses(spec, scheduleZone(spec, zone), base * 1_000_000, count);
}

function elapsesFrom(expression: string, zone: string, base: number, count: number): number[] {
  return searchFrom(expression, zone, base, count).elapses.map((e) => Math.floor(e.us / 1_000_000));
}

/* ----------------------------------------------------------------- checks */

export async function runCalendarChecks(check: Check): Promise<void> {
  console.log("\n-- oncalendar: normalized forms, as systemd 259 prints them --");
  {
    // Recorded from `systemd-analyze calendar`. null: systemd refused it.
    const NORMALIZED: readonly [string, string | null][] = [
      ["Mon..Fri *-*-* 08:30:00", "Mon..Fri *-*-* 08:30:00"],
      ["*:0/15", "*-*-* *:00/15:00"],
      ["*:0/59", "*-*-* *:00/59:00"],
      ["Sat..Sun", "Sat,Sun *-*-* 00:00:00"],
      ["Mon-Fri", "Mon..Fri *-*-* 00:00:00"],
      ["Mon..Fri,Sun", "Mon..Fri,Sun *-*-* 00:00:00"],
      ["mon", "Mon *-*-* 00:00:00"],
      ["MONDAY", "Mon *-*-* 00:00:00"],
      ["monday..friday", "Mon..Fri *-*-* 00:00:00"],
      ["Mon,Mon", "Mon *-*-* 00:00:00"],
      ["Mon,Tue,Wed", "Mon..Wed *-*-* 00:00:00"],
      ["Mon,Tue", "Mon,Tue *-*-* 00:00:00"],
      ["Mon..Sun", "*-*-* 00:00:00"],
      ["Mon..Wed,Fri..Sun", "Mon..Wed,Fri..Sun *-*-* 00:00:00"],
      ["Tue..Thu,Mon", "Mon..Thu *-*-* 00:00:00"],
      ["Sun,Mon", "Mon,Sun *-*-* 00:00:00"],
      ["Mon,", "Mon *-*-* 00:00:00"],
      ["*-*~01", "*-*~01 00:00:00"],
      ["*~01", "*-*~01 00:00:00"],
      ["*-*~1", "*-*~01 00:00:00"],
      ["*-02~03", "*-02~03 00:00:00"],
      ["Mon *-05~07/1", "Mon *-05~07/1 00:00:00"],
      ["*-*~01..03", "*-*~01..03 00:00:00"],
      ["*-*~07/2", "*-*~07/2 00:00:00"],
      ["*-*~28", "*-*~28 00:00:00"],
      ["*-*~03..10", "*-*~03..10 00:00:00"],
      ["*-*~01,15", "*-*~01,15 00:00:00"],
      ["*-*~5/2", "*-*~05/2 00:00:00"],
      ["*-*~02/1", "*-*~02/1 00:00:00"],
      ["*~02,01", "*-*~01,02 00:00:00"],
      ["10..12/5:00", "*-*-* 10:00:00"],
      ["08..18/2:00", "*-*-* 08..18/2:00:00"],
      ["8..18/3:00", "*-*-* 08..17/3:00:00"],
      ["*:0..59/5", "*-*-* *:00..55/5:00"],
      ["*:0..10/1", "*-*-* *:00..10:00"],
      ["1..1:00", "*-*-* 01:00:00"],
      ["5,1,3,1:00", "*-*-* 01,03,05:00:00"],
      ["1,1..3:00", "*-*-* 01,01..03:00:00"],
      ["1..3,2..5:00", "*-*-* 01..03,02..05:00:00"],
      ["0/7:00", "*-*-* 00/7:00:00"],
      ["*:5..20/4", "*-*-* *:05..17/4:00"],
      ["*:5..21/4", "*-*-* *:05..21/4:00"],
      ["12-25", "*-12-25 00:00:00"],
      ["26-12-25", "2026-12-25 00:00:00"],
      ["99-12-25", "1999-12-25 00:00:00"],
      ["2199-12-31", "2199-12-31 00:00:00"],
      ["2026,2025-01-01", "2025,2026-01-01 00:00:00"],
      ["26..28-01-01", "2026..2028-01-01 00:00:00"],
      ["70-01-01", "1970-01-01 00:00:00"],
      ["69-01-01", "2069-01-01 00:00:00"],
      ["0-01-01", "2000-01-01 00:00:00"],
      ["2026/2-01-01", "2026/2-01-01 00:00:00"],
      ["*-1/2-01", "*-01/2-01 00:00:00"],
      ["*-01/11-01", "*-01/11-01 00:00:00"],
      ["@1700000000", "2023-11-14 22:13:20 UTC"],
      ["*:*:0.5", "*-*-* *:*:00.500000"],
      ["*:*:0/0.25", "*-*-* *:*:00/0.250000"],
      ["*:*:1..3", "*-*-* *:*:01..03"],
      ["*:*:1..3/0.5", "*-*-* *:*:01..03/0.500000"],
      ["*:*:5.5..10", "*-*-* *:*:05.500000..09.500000"],
      ["*:*:5..10.5", "*-*-* *:*:05..10"],
      ["*:*:0.1/0.1", "*-*-* *:*:00.100000/0.100000"],
      ["*:*:*", "*-*-* *:*:*"],
      ["*:*:0..59", "*-*-* *:*:00..59"],
      ["*:*:00/1", "*-*-* *:*:*"],
      ["*-*-* 23:59:59.999999", "*-*-* 23:59:59.999999"],
      ["*:00:00.5", "*-*-* *:00:00.500000"],
      ["*:0:0.000001", "*-*-* *:00:00.000001"],
      ["00:00:00.000000", "*-*-* 00:00:00"],
      ["daily", "*-*-* 00:00:00"],
      ["Daily", "*-*-* 00:00:00"],
      ["DAILY UTC", "*-*-* 00:00:00 UTC"],
      ["weekly", "Mon *-*-* 00:00:00"],
      ["monthly", "*-*-01 00:00:00"],
      ["quarterly", "*-01,04,07,10-01 00:00:00"],
      ["semiannually", "*-01,07-01 00:00:00"],
      ["anually", "*-01-01 00:00:00"],
      ["biannually", "*-01,07-01 00:00:00"],
      ["minutely", "*-*-* *:*:00"],
      ["hourly", "*-*-* *:00:00"],
      ["08:30", "*-*-* 08:30:00"],
      ["8:5", "*-*-* 08:05:00"],
      ["8:5:3", "*-*-* 08:05:03"],
      ["Mon  08:00", "Mon *-*-* 08:00:00"],
      ["*-*-*  08:00", "*-*-* 08:00:00"],
      ["Mon *-*-* 8:00 Europe/Berlin", "Mon *-*-* 08:00:00 Europe/Berlin"],
      ["8:00 UTC", "*-*-* 08:00:00 UTC"],
      ["8:00 utc", "*-*-* 08:00:00 UTC"],
      ["*-12-25 utc", "*-12-25 00:00:00 UTC"],
      ["Sat *-*-* 23:00 UTC", "Sat *-*-* 23:00:00 UTC"],
      ["2026-12-25 09:00:00 Asia/Ho_Chi_Minh", "2026-12-25 09:00:00 Asia/Ho_Chi_Minh"],
      ["Fri *-*-13", "Fri *-*-13 00:00:00"],
      ["Mon *-*-01..07 10:00", "Mon *-*-01..07 10:00:00"],
      ["*-*-* 8..10,14:30", "*-*-* 08..10,14:30:00"],
      ["*-1,15", "*-*-01,15 00:00:00"],
      ["*-04-31", "*-04-31 00:00:00"],
      ["2026-1-1", "2026-01-01 00:00:00"],
      ["1-1", "*-01-01 00:00:00"],
      ["*/2", null],
      ["*:*/2", null],
      ["*:50/15", null],
      ["*:0/60", null],
      ["Fri..Mon", null],
      ["Mond", null],
      ["*-*~03..01", null],
      ["*-*~29", null],
      ["*-*~01/1", null],
      ["*-*~10..03", null],
      ["2200-01-01", null],
      ["1969-12-31", null],
      ["100-01-01", null],
      ["Mon 08", null],
      ["*-*-* 24:00", null],
      ["*-*-* 23:60", null],
      ["*-*-* 23:59:60", null],
      ["*-*-* 23:59:59.9999999", null],
      ["*:*:*/1", null],
      ["daily  UTC", null],
      ["2026-01-01T00:00", null],
      ["13-1", null],
      ["*-13-01", null],
      ["*-00-01", null],
      ["*-01-00", null],
      ["*-01-32", null],
      ["Feb", null],
      ["*-feb-01", null],
      ["x", null],
      ["Mon Fri", null],
      ["Mon..Fri Sat", null],
      ["Mon *-*-* 08:00 Sat", null],
      ["Mon, Tue", null],
      ["Mon ,Tue", null],
      ["Mon,,Tue", null],
      ["Mon..", null],
      ["Mon...Fri", null],
      ["*-*-01..07 Mon", null],
      ["1,15 *", null],
      ["*-*/2-01", null],
      ["*-01/12-01", null],
      ["8:00 Mars/Olympus", null],
    ];
    for (const [input, expected] of NORMALIZED) {
      let got: string | null;
      try {
        got = parseCalendar(input).normalized;
      } catch (error) {
        if (!(error instanceof CalendarError)) throw error;
        got = null;
      }
      check(`${JSON.stringify(input)} → ${expected ?? "refused"}`, got === expected, String(got));
    }
  }

  console.log("\n-- oncalendar: refusals say why --");
  {
    const REFUSED: readonly [string, RegExp][] = [
      ["", /Enter a calendar expression/],
      ["30 8 * * 1-5", /crontab schedule/],
      ["0 0 12 * * ?", /crontab schedule/],
      ["*/15", /no \*\/N.*0\/N/],
      ["2026-01-01T08:00", /T of ISO 8601/],
      ["Mond", /“Mond” is not a day name.*Mon or Monday/],
      ["Fri..Mon", /runs backwards.*Fri\.\.Sun,Mon/],
      ["Sat..Tue", /Sat\.\.Sun,Mon\.\.Tue/],
      ["Mon.Fri", /two dots/],
      ["Mon..", /has no end/],
      ["Mon, Tue", /commas and no spaces/],
      ["*-feb-01", /write 02, not feb/],
      ["Mon 08", /write 08:00, not 08/],
      ["*:50/15", /never repeats: 50 plus 15 is past 59/],
      ["*:0/60", /step in “00\/60” is longer/],
      ["24:00", /Hour 24 does not exist.*midnight is 00:00/],
      ["*-13-01", /Month 13 does not exist/],
      ["2200-01-01", /Years run 1970–2199/],
      ["*-*~29", /at most 28 days/],
      ["*-*~03..01", /smaller number first: ~01\.\.03/],
      ["*-*~01/1", /steps past the last day/],
      ["18..08:00", /runs backwards/],
      ["*:*:01..01", /at least one whole second/],
      ["*:*:0/0", /step of 0/],
      ["8.5:00", /Only seconds can have a fraction/],
      ["8:00 EDT", /abbreviation/],
      ["8:00 asia/ho_chi_minh", /case-sensitive.*Asia\/Ho_Chi_Minh/],
      ["8:00 UTC+7", /Etc\/GMT-7/],
      ["8:00 +07:00", /Etc\/GMT-7/],
      ["8:00 Mars/Olympus", /not a time zone/],
      ["daily  UTC", /more than one space/],
      ["*~01-05", /“~” marks the day/],
      ["2026-01-01-01", /three parts at most/],
      ["08:00:00:00", /three parts at most: hour:minute:second/],
      ["Mon *-*-* 08:00 Sat", /comes after the time/],
      ["@", /Unix time in seconds/],
      ["@1700000000 08:00", /nothing can follow/],
      ["@99999999999", /after 2199/],
    ];
    for (const [input, message] of REFUSED) {
      const said = refusal(() => parseCalendar(input));
      check(
        `refuses ${JSON.stringify(input)} by name, in both languages`,
        said.typed && message.test(said.en) && said.vi.length > 0 && said.vi !== said.en,
        said.en || "(accepted)",
      );
    }
    check("a crontab line is flagged as one", refusal(() => parseCalendar("*/5 * * * *")).cron);
    check("a calendar mistake is not", !refusal(() => parseCalendar("Mond")).cron);
    check("leading and trailing space is trimmed, as a unit file does", parseCalendar("  daily  ").normalized === "*-*-* 00:00:00");
    check("241 list items are accepted", (() => {
      try {
        parseCalendar(`*:*:${Array.from({ length: 241 }, (_, i) => String(i % 60)).join(",")}`);
        return true;
      } catch {
        return false;
      }
    })());
    check("242 are refused", /at most 241/.test(refusal(() => parseCalendar(`*:*:${Array.from({ length: 242 }, (_, i) => String(i % 60)).join(",")}`)).en));
  }

  console.log("\n-- oncalendar: descriptions in both languages --");
  {
    const SAID: readonly [string, string, string][] = [
      ["Mon..Fri *-*-* 08:30:00", "At 08:30:00, Monday through Friday.", "Lúc 08:30:00, từ thứ Hai đến thứ Sáu."],
      ["daily", "At 00:00:00 every day.", "Lúc 00:00:00 hằng ngày."],
      ["weekly", "At 00:00:00 every Monday.", "Lúc 00:00:00 mỗi thứ Hai."],
      ["monthly", "At 00:00:00 on the 1st of every month.", "Lúc 00:00:00 vào ngày 1 hằng tháng."],
      ["quarterly", "At 00:00:00 on the 1st of January, April, July and October.", "Lúc 00:00:00 vào ngày 1 các tháng 1, 4, 7 và 10."],
      ["hourly", "Every hour, on the hour.", "Mỗi giờ, vào phút 00."],
      ["minutely", "Every minute, on the minute.", "Mỗi phút, vào giây 00."],
      ["*:*:*", "Every second.", "Mỗi giây."],
      ["*:*:0/10", "Every 10 seconds.", "Cứ 10 giây một lần."],
      ["*:0/15", "Every 15 minutes.", "Cứ 15 phút một lần."],
      ["*:5/15", "Every 15 minutes from :05 to :50.", "Cứ 15 phút một lần, từ phút 05 đến phút 50."],
      ["*:15,45", "Every hour at :15 and :45.", "Mỗi giờ, vào phút 15 và 45."],
      ["08..18/2:00", "Every 2 hours, on the hour, from 08:00 to 18:00.", "Cứ 2 giờ một lần vào phút 00, từ 08:00 đến 18:00."],
      ["09..17:00", "Every hour from 09:00 to 17:00.", "Mỗi giờ vào phút 00, từ 09:00 đến 17:00."],
      ["Mon..Fri 09..17:0/30", "Every 30 minutes, between 09:00 and 17:59, Monday through Friday.", "Cứ 30 phút một lần, từ 09:00 đến 17:59, từ thứ Hai đến thứ Sáu."],
      ["Sat,Sun 10:00", "At 10:00:00 on Saturday and Sunday.", "Lúc 10:00:00 vào thứ Bảy và Chủ nhật."],
      ["Mon,Wed,Fri 07:00", "At 07:00:00 on Monday, Wednesday and Friday.", "Lúc 07:00:00 vào thứ Hai, thứ Tư và thứ Sáu."],
      ["Fri *-*-13", "At 00:00:00 on the 13th of every month, but only if that day is a Friday.", "Lúc 00:00:00 vào ngày 13 hằng tháng, nhưng chỉ khi ngày đó là thứ Sáu."],
      ["Mon *-*-01..07 10:00", "At 10:00:00 on the first Monday of every month.", "Lúc 10:00:00 vào thứ Hai đầu tiên của mỗi tháng."],
      ["Thu *-*-08..14", "At 00:00:00 on the second Thursday of every month.", "Lúc 00:00:00 vào thứ Năm thứ hai của mỗi tháng."],
      ["Mon *-05~07/1", "At 00:00:00 on the last Monday of May.", "Lúc 00:00:00 vào thứ Hai cuối cùng của tháng 5."],
      ["*-*~01 23:00", "At 23:00:00 on the last day of every month.", "Lúc 23:00:00 vào ngày cuối cùng của mỗi tháng."],
      ["*-02~03", "At 00:00:00 on the 3rd-to-last day of February.", "Lúc 00:00:00 vào ngày thứ 3 tính từ cuối tháng 2."],
      ["*-*~01..03", "At 00:00:00 on the last 3 days of every month.", "Lúc 00:00:00 vào 3 ngày cuối của mỗi tháng."],
      ["2026-12-25 09:00", "At 09:00:00 on 25 December 2026.", "Lúc 09:00:00 vào ngày 25 tháng 12 năm 2026."],
      ["2026..2028-01-01", "At 00:00:00 on the 1st of January, from 2026 through 2028.", "Lúc 00:00:00 vào ngày 1 tháng 1, từ năm 2026 đến năm 2028."],
      ["*-*-* 08,20:00", "At 08:00:00 and 20:00:00 every day.", "Lúc 08:00:00 và 20:00:00 hằng ngày."],
      ["*-03..10-* 06:00", "At 06:00:00 every day in March through October.", "Lúc 06:00:00 mỗi ngày trong các tháng từ 3 đến 10."],
      ["daily UTC", "At 00:00:00 every day (UTC).", "Lúc 00:00:00 hằng ngày (giờ UTC)."],
      ["Mon 08:00 Europe/Berlin", "At 08:00:00 every Monday (Europe/Berlin time).", "Lúc 08:00:00 mỗi thứ Hai (theo giờ Europe/Berlin)."],
      ["@1767225600", "Once, at 2026-01-01 00:00:00 UTC.", "Một lần duy nhất, lúc 2026-01-01 00:00:00 UTC."],
    ];
    for (const [input, en, vi] of SAID) {
      const spec = parseCalendar(input);
      const gotEn = describeCalendar(spec, "en");
      const gotVi = describeCalendar(spec, "vi");
      check(`${input}: ${en}`, gotEn === en, gotEn);
      check(`${input}: ${vi}`, gotVi === vi, gotVi);
    }
    const spec = parseCalendar("Mon..Fri *-*-01,15 08..18/2:30:00");
    check("field table: weekday", describeField(spec, "weekday", "en") === "Monday through Friday", describeField(spec, "weekday", "en"));
    check("field table: day", describeField(spec, "day", "en") === "01 and 15", describeField(spec, "day", "en"));
    check("field table: hour", describeField(spec, "hour", "en") === "08, 10, 12, 14, 16 and 18", describeField(spec, "hour", "en"));
    check("field table: year, in Vietnamese", describeField(spec, "year", "vi") === "mọi năm", describeField(spec, "year", "vi"));
  }

  console.log("\n-- oncalendar: notes --");
  {
    const notesOf = (input: string) => calendarNotes(parseCalendar(input)).map((note) => note.en).join(" | ");
    check("weekly is Monday, and says so", /Monday at 00:00:00, not Sunday/.test(notesOf("weekly")));
    check("a shorthand names its expansion", /“daily” is shorthand for \*-\*-\* 00:00:00\./.test(notesOf("daily UTC")), notesOf("daily UTC"));
    check("no time written means midnight", /fires at midnight/.test(notesOf("Mon..Fri")));
    check("a two-digit year is expanded", /26 is read as 2026/.test(notesOf("26-12-25")));
    check("a cut range is explained", /reads 08\.\.18\/3 as 08\.\.17\/3/.test(notesOf("8..18/3:00")), notesOf("8..18/3:00"));
    check("a step that cannot fire twice is explained", /10\.\.12\/5 can only ever match 10/.test(notesOf("10..12/5:00")), notesOf("10..12/5:00"));
    check("sorting is explained", /sorts each list/.test(notesOf("5,1,3:00")));
    check("weekday and date must both match", /systemd always requires both/.test(notesOf("Fri *-*-13")));
    check("the 31st is skipped in short months", /no elapse on the 31st in February, April, June, September and November. For the last day/.test(notesOf("*-*-31")), notesOf("*-*-31"));
    check("so is 29 February outside leap years", /no elapse on 29 February outside leap years/.test(notesOf("*-01,02-29")), notesOf("*-01,02-29"));
    check("31 April never happens", /never elapses/.test(notesOf("*-04-31")), notesOf("*-04-31"));
    check("29 February is a leap-year date", /only in leap years/.test(notesOf("*-02-29")), notesOf("*-02-29"));
    check("~ is explained", /counts days back from the end/.test(notesOf("*-*~01")));
    check("sub-minute schedules need AccuracySec", /AccuracySec=1s/.test(notesOf("*:*:0/10")));
    check("a minute schedule does not", !/AccuracySec/.test(notesOf("minutely")));
    check("Asia/Saigon is an old name for Asia/Ho_Chi_Minh", /old name for Asia\/Ho_Chi_Minh.*tzdata-legacy/.test(notesOf("08:00 Asia/Saigon")), notesOf("08:00 Asia/Saigon"));
    check("a zone in the expression wins", /whatever zone the server is set to/.test(notesOf("08:00 Europe/Berlin")));

    const BOUNDED: readonly [string, string | null][] = [
      ["0/7:00", "*-*-* 00..21/7:00:00"],
      ["*:0/7", "*-*-* *:00..56/7:00"],
      ["*:*:0/7", "*-*-* *:*:00..56/7"],
      ["*-*-01/7", "*-*-01..29/7 00:00:00"],
      ["*-01/5-01", "*-01..11/5-01 00:00:00"],
      ["Mon *-*-11/14", "Mon *-*-11..25/14 00:00:00"],
      ["*:0/15", null],
      ["0/6:00", null],
      ["*-01/3-01", null],
      ["Mon..Fri 08:30", null],
      ["*-*~07/1", null],
    ];
    for (const [input, expected] of BOUNDED) {
      const got = boundedForm(parseCalendar(input));
      check(`${input} with its step given an end: ${expected ?? "nothing to change"}`, got === expected, String(got));
      if (got === null) continue;
      // The same wall times, before and after.
      const before = parseCalendar(input);
      const after = parseCalendar(got);
      let cursor: CalendarWall | null = { year: 2026, month: 1, day: 1, hour: 0, minute: 0, us: 0 };
      let same = true;
      for (let n = 0; n < 200 && cursor !== null; n += 1) {
        const a = nextMatch(before, cursor);
        const b = nextMatch(after, cursor);
        if (a === null || b === null || wallText(a) !== wallText(b)) {
          same = a === b;
          break;
        }
        cursor = { ...a, us: a.us + 1 };
      }
      check(`  and matches the same 200 times`, same);
    }
    const stepWarned = (input: string, zone: string) => stepNotes(parseCalendar(input), zone, at(zone, "2026-01-01 00:00:00") * 1000).length > 0;
    check("an uneven hour step is warned about anywhere", stepWarned("0/7:00", "Asia/Ho_Chi_Minh") && stepWarned("0/7:00", "UTC"));
    check("a day step only where the clocks change", stepWarned("*-*-01/7", "America/New_York") && !stepWarned("*-*-01/7", "Asia/Ho_Chi_Minh"));
    check("an even step never", !stepWarned("*:0/15", "America/New_York"));

    const from = at("America/New_York", "2026-01-01 00:00:00") * 1000;
    const dst = (input: string) => clockChangeNotes(parseCalendar(input), "America/New_York", from).map((note) => note.en).join(" | ");
    check("02:30 is skipped on 8 March in New York", /8 March 2026.*from 02:00 to 03:00\. 02:30 does not exist/.test(dst("*-*-* 02:30")), dst("*-*-* 02:30"));
    check("01:30 happens twice on 1 November", /1 November 2026.*01:00–02:00 happens twice\. systemd fires 01:30 once/.test(dst("*-*-* 01:30")), dst("*-*-* 01:30"));
    check("09:00 is touched by neither", dst("*-*-* 09:00") === "");
    check("no clock changes in Ho Chi Minh City", clockChangeNotes(parseCalendar("*-*-* 02:30"), "Asia/Ho_Chi_Minh", from).length === 0);
  }

  console.log("\n-- oncalendar: elapses around clock changes, as systemd 259 computed them --");
  {
    // [zone, base wall time or @seconds, expression, the UTC times systemd listed]
    const PINNED: readonly [string, string, string, string[]][] = [
      ["America/New_York", "2026-03-07 12:00:00", "*-*-* 02:30:00", ["2026-03-09 06:30:00", "2026-03-10 06:30:00", "2026-03-11 06:30:00"]],
      ["America/New_York", "2026-03-07 12:00:00", "*-*-* 02:00:00", ["2026-03-09 06:00:00", "2026-03-10 06:00:00"]],
      ["America/New_York", "2026-03-08 00:00:00", "*:30", ["2026-03-08 05:30:00", "2026-03-08 06:30:00", "2026-03-08 07:30:00", "2026-03-08 08:30:00", "2026-03-08 09:30:00"]],
      ["America/New_York", "2026-03-08 01:57:00", "minutely", ["2026-03-08 06:58:00", "2026-03-08 06:59:00", "2026-03-08 07:00:00", "2026-03-08 07:01:00"]],
      ["America/New_York", "2026-10-31 12:00:00", "*-*-* 01:30:00", ["2026-11-01 05:30:00", "2026-11-02 06:30:00", "2026-11-03 06:30:00"]],
      ["America/New_York", "2026-11-01 00:00:00", "*:30", ["2026-11-01 04:30:00", "2026-11-01 05:30:00", "2026-11-01 07:30:00", "2026-11-01 08:30:00", "2026-11-01 09:30:00"]],
      ["America/New_York", "2026-11-01 00:58:00", "minutely", ["2026-11-01 04:59:00", "2026-11-01 05:00:00", "2026-11-01 05:01:00", "2026-11-01 05:02:00"]],
      ["America/New_York", "2026-11-01 01:58:00", "minutely", ["2026-11-01 05:59:00", "2026-11-01 07:00:00", "2026-11-01 07:01:00", "2026-11-01 07:02:00"]],
      ["America/New_York", "2026-11-01 00:00:00", "*:0/20", ["2026-11-01 04:20:00", "2026-11-01 04:40:00", "2026-11-01 05:00:00", "2026-11-01 05:20:00", "2026-11-01 05:40:00", "2026-11-01 07:00:00", "2026-11-01 07:20:00", "2026-11-01 07:40:00"]],
      // Counting from inside the repeat, after its first pass: 01:10 EST.
      ["America/New_York", "@1793513400", "minutely", ["2026-11-01 06:11:00", "2026-11-01 06:12:00", "2026-11-01 06:13:00"]],
      ["America/New_York", "@1793513400", "*:30", ["2026-11-01 06:30:00", "2026-11-01 07:30:00", "2026-11-01 08:30:00"]],
      ["America/New_York", "@1793513400", "*-*-* 01:30:00", ["2026-11-01 06:30:00", "2026-11-02 06:30:00"]],
      ["America/New_York", "@1793513400", "*-*-* 01:05:00", ["2026-11-02 06:05:00", "2026-11-03 06:05:00"]],
      // Lord Howe moves its clocks by thirty minutes.
      ["Australia/Lord_Howe", "2026-10-03 12:00:00", "*-*-* 02:15:00", ["2026-10-04 15:15:00", "2026-10-05 15:15:00", "2026-10-06 15:15:00"]],
      ["Australia/Lord_Howe", "2026-04-04 12:00:00", "*-*-* 01:45:00", ["2026-04-04 14:45:00", "2026-04-05 15:15:00", "2026-04-06 15:15:00"]],
      ["Australia/Lord_Howe", "2026-04-05 00:00:00", "*:45", ["2026-04-04 13:45:00", "2026-04-04 14:45:00", "2026-04-04 16:15:00", "2026-04-04 17:15:00", "2026-04-04 18:15:00"]],
      ["Europe/London", "2026-03-28 12:00:00", "*-*-* 01:30:00", ["2026-03-30 00:30:00", "2026-03-31 00:30:00", "2026-04-01 00:30:00"]],
      ["Europe/London", "2026-10-24 12:00:00", "*-*-* 01:30:00", ["2026-10-25 00:30:00", "2026-10-26 01:30:00", "2026-10-27 01:30:00"]],
      ["Europe/London", "2026-10-25 00:00:00", "*:15", ["2026-10-24 23:15:00", "2026-10-25 00:15:00", "2026-10-25 02:15:00", "2026-10-25 03:15:00", "2026-10-25 04:15:00"]],
      // Santiago changes its clocks at midnight, so a daily job loses a whole day.
      ["America/Santiago", "2026-09-05 12:00:00", "daily", ["2026-09-07 03:00:00", "2026-09-08 03:00:00", "2026-09-09 03:00:00"]],
      ["America/Santiago", "2026-09-05 23:58:00", "minutely", ["2026-09-06 03:59:00", "2026-09-06 04:00:00", "2026-09-06 04:01:00"]],
      ["America/Santiago", "2026-09-05 22:00:00", "*:30", ["2026-09-06 02:30:00", "2026-09-06 03:30:00", "2026-09-06 04:30:00"]],
      ["America/Santiago", "2026-04-04 12:00:00", "*-*-* 23:30:00", ["2026-04-05 02:30:00", "2026-04-06 03:30:00", "2026-04-07 03:30:00"]],
      ["America/Santiago", "2026-04-04 22:00:00", "*:30", ["2026-04-05 01:30:00", "2026-04-05 02:30:00", "2026-04-05 04:30:00", "2026-04-05 05:30:00"]],
      ["America/Santiago", "2026-04-04 12:00:00", "daily", ["2026-04-05 04:00:00", "2026-04-06 04:00:00"]],
      // An expression's own zone wins over the server's.
      ["Asia/Ho_Chi_Minh", "@1793513400", "*-*-* 01:30:00 America/New_York", ["2026-11-01 06:30:00", "2026-11-02 06:30:00"]],
      ["Asia/Ho_Chi_Minh", "2026-10-02 20:00:00", "Mon *-*-* 8:00 Europe/Berlin", ["2026-10-05 06:00:00"]],
      ["Asia/Ho_Chi_Minh", "2026-10-02 20:00:00", "*-12-25 utc", ["2026-12-25 00:00:00"]],
    ];
    for (const [zone, base, expression, expected] of PINNED) {
      const from = base.startsWith("@") ? Number(base.slice(1)) : at(zone, base);
      const got = elapsesFrom(expression, zone, from, expected.length).map(utcText);
      check(`${expression} from ${base} in ${zone}`, got.join() === expected.join(), got.join(", "));
    }

    // An item with a step and no end runs past its field into the next day,
    // month or year; across a clock change systemd 259 then gives up, or
    // resumes an hour late. The same times with an end are unaffected.
    const OVERFLOW: readonly [string, string, string, readonly string[] | "gives up"][] = [
      ["America/New_York", "2026-03-07 22:00:00", "0/7:00", "gives up"],
      ["America/New_York", "2026-03-07 22:00:00", "00..21/7:00", ["2026-03-08 05:00:00", "2026-03-08 11:00:00", "2026-03-08 18:00:00"]],
      ["America/New_York", "2026-03-07 22:00:00", "0/5:00", ["2026-03-08 05:00:00", "2026-03-08 09:00:00", "2026-03-08 14:00:00"]],
      ["America/New_York", "2026-10-31 22:00:00", "0/7:00", ["2026-11-01 12:00:00", "2026-11-01 19:00:00", "2026-11-02 02:00:00"]],
      ["America/New_York", "2026-10-31 22:00:00", "00..21/7:00", ["2026-11-01 04:00:00", "2026-11-01 12:00:00", "2026-11-01 19:00:00"]],
      ["America/New_York", "2026-11-15 00:00:00", "*-01/5-01", "gives up"],
      ["America/New_York", "2026-11-15 00:00:00", "*-01..11/5-01", ["2027-01-01 05:00:00", "2027-06-01 04:00:00", "2027-11-01 04:00:00"]],
      ["America/New_York", "2026-01-01 00:00:00", "Mon *-*-11/14", "gives up"],
      ["America/New_York", "2026-01-01 00:00:00", "Mon *-*-11..25/14", ["2026-05-11 04:00:00", "2026-05-25 04:00:00", "2027-01-11 05:00:00"]],
      ["Europe/Berlin", "2026-03-28 22:00:00", "0/7:00", "gives up"],
      ["Europe/Berlin", "2026-03-28 22:00:00", "00..21/7:00", ["2026-03-28 23:00:00", "2026-03-29 05:00:00", "2026-03-29 12:00:00"]],
      ["Australia/Sydney", "2026-10-03 22:00:00", "0/7:00", "gives up"],
      ["Australia/Sydney", "2026-09-20 00:00:00", "*-*-11/14", "gives up"],
      ["America/Santiago", "2026-09-05 20:00:00", "0/5:00", "gives up"],
      ["America/Santiago", "2026-09-05 20:00:00", "00..20/5:00", ["2026-09-06 08:00:00", "2026-09-06 13:00:00", "2026-09-06 18:00:00"]],
      ["Australia/Lord_Howe", "@1780000000", "Mon *-*-11/14", "gives up"],
      ["Asia/Ho_Chi_Minh", "@1780000000", "Mon *-*-11/14", ["2027-01-10 17:00:00", "2027-01-24 17:00:00", "2027-10-10 17:00:00"]],
    ];
    for (const [zone, base, expression, expected] of OVERFLOW) {
      const from = base.startsWith("@") ? Number(base.slice(1)) : at(zone, base);
      const search = searchFrom(expression, zone, from, 3);
      const got = search.stuck !== null ? "gives up" : search.elapses.map((e) => utcText(Math.floor(e.us / 1e6))).join();
      const want = expected === "gives up" ? expected : expected.join();
      check(`${expression} from ${base} in ${zone}: ${expected === "gives up" ? "systemd 259 gives up" : "as systemd 259 lists"}`, got === want, got);
    }
    // Even with no clock change, an overflow that crosses midnight, a month or
    // a year resets only the field below the one that changed.
    const CARRIED: readonly [string, string, string, readonly string[]][] = [
      ["UTC", "2026-10-31 22:00:00", "0/7:00", ["2026-11-01 07:00:00", "2026-11-01 14:00:00"]],
      ["UTC", "2026-10-30 22:00:00", "0/7:00", ["2026-10-31 00:00:00", "2026-10-31 07:00:00"]],
      ["UTC", "2026-10-02 23:50:00", "*:0/7", ["2026-10-02 23:56:00", "2026-10-03 00:07:00", "2026-10-03 00:14:00"]],
      ["UTC", "2026-10-02 22:50:00", "*:0/7", ["2026-10-02 22:56:00", "2026-10-02 23:00:00", "2026-10-02 23:07:00"]],
      ["UTC", "2026-10-02 23:50:00", "*:00..56/7", ["2026-10-02 23:56:00", "2026-10-03 00:00:00", "2026-10-03 00:07:00"]],
      ["UTC", "2026-12-31 22:00:00", "0/7:00", ["2027-01-01 07:00:00", "2027-01-01 14:00:00"]],
      ["UTC", "2026-12-31 23:59:50", "*:*:0/7", ["2026-12-31 23:59:56", "2027-01-01 00:00:07", "2027-01-01 00:00:14"]],
      // A new year resets the day too, since 259.5, so these do not skip.
      ["UTC", "2026-12-29 12:00:00", "*-*-01/9", ["2027-01-01 00:00:00", "2027-01-10 00:00:00"]],
      ["UTC", "2026-12-30 12:00:00", "*-*-02/7", ["2027-01-02 00:00:00", "2027-01-09 00:00:00"]],
      ["UTC", "2026-11-30 12:00:00", "*-*-01/7", ["2026-12-01 00:00:00", "2026-12-08 00:00:00"]],
      ["Europe/Berlin", "2026-10-24 22:00:00", "0/7:00", ["2026-10-25 06:00:00", "2026-10-25 13:00:00"]],
    ];
    for (const [zone, base, expression, expected] of CARRIED) {
      const got = elapsesFrom(expression, zone, at(zone, base), expected.length).map(utcText);
      check(`${expression} from ${base} in ${zone}`, got.join() === expected.join(), got.join(", "));
    }
    const missedOf = (expression: string, zone: string, base: string, count: number) => searchFrom(expression, zone, at(zone, base), count).missed;
    const nightly = missedOf("*:0/7", "UTC", "2026-10-02 23:50:00", 3);
    check("*:0/7 misses midnight, by carry", nightly.length === 1 && nightly[0]!.lost.hour === 0 && nightly[0]!.lost.minute === 0 && nightly[0]!.cause === "carry", JSON.stringify(nightly));
    const monthly = missedOf("0/7:00", "America/New_York", "2026-10-31 22:00:00", 1);
    check("0/7:00 misses midnight on the 1st, by carry", monthly.length === 1 && monthly[0]!.lost.day === 1 && monthly[0]!.cause === "carry", JSON.stringify(monthly));
    const autumn = missedOf("0/7:00", "Europe/Berlin", "2026-10-24 22:00:00", 1);
    check("0/7:00 misses midnight on 25 October in Berlin, by the clock change", autumn.length === 1 && autumn[0]!.lost.day === 25 && autumn[0]!.cause === "clock", JSON.stringify(autumn));
    check("00..21/7 misses nothing", missedOf("00..21/7:00", "UTC", "2026-10-31 22:00:00", 3).length === 0);

    const spring = parseCalendar("*-*-* 02:30");
    const search = nextElapses(spring, "America/New_York", at("America/New_York", "2026-03-07 12:00:00") * 1e6, 2);
    check("the skipped 02:30 is reported", search.skipped.length === 1 && search.skipped[0]!.wall.day === 8 && !search.skipped[0]!.more);
    const minutely = nextElapses(parseCalendar("minutely"), "America/New_York", at("America/New_York", "2026-03-08 01:57:00") * 1e6, 4);
    check("a skipped hour of minutes is one report, marked as more", minutely.skipped.length === 1 && minutely.skipped[0]!.more);
    const repeat = nextElapses(parseCalendar("*-*-* 01:30"), "America/New_York", at("America/New_York", "2026-10-31 12:00:00") * 1e6, 2);
    check("the repeated 01:30 is the first of the two", repeat.elapses[0]!.repeated === "first" && repeat.elapses[1]!.repeated === null);
    const second = nextElapses(parseCalendar("minutely"), "America/New_York", 1793513400 * 1e6, 1);
    check("counting from inside the repeat lands on the second", second.elapses[0]!.repeated === "second");

    const never = (input: string) => nextElapses(parseCalendar(input), "UTC", at("UTC", "2026-10-02 00:00:00") * 1e6, 3).never;
    check("*-02-30 never elapses", never("*-02-30"));
    check("*-04-31 never elapses", never("*-04-31"));
    check("a date in the past never elapses", never("2025-01-01"));
    check("@1700000000 is in the past", never("@1700000000"));
    check("*-02-29 is not never", !never("*-02-29"));
    check("2199-12-31 is still to come", !never("2199-12-31 23:59:59"));
    const leap = elapsesFrom("*-02-29 12:00", "UTC", at("UTC", "2026-10-02 00:00:00"), 3).map(utcText);
    check("29 February, three times", leap.join() === "2028-02-29 12:00:00,2032-02-29 12:00:00,2036-02-29 12:00:00", leap.join());
    const centuries = elapsesFrom("*-02-29", "UTC", at("UTC", "2096-03-01 00:00:00"), 2).map(utcText);
    check("2100 is not a leap year", centuries.join() === "2104-02-29 00:00:00,2108-02-29 00:00:00", centuries.join());
    const fraction = nextElapses(parseCalendar("*:*:0/0.25"), "UTC", at("UTC", "2026-10-02 00:00:00") * 1e6, 3).elapses.map((e) => e.us % 1e6);
    check("quarter seconds land on the microsecond", fraction.join() === "250000,500000,750000", fraction.join());
    const epoch = nextElapses(parseCalendar("Tue @1700000000"), "UTC", 0, 1);
    check("@ with the right weekday elapses", epoch.elapses.length === 1);
    check("@ with the wrong one never does", nextElapses(parseCalendar("Mon @1700000000"), "UTC", 0, 1).never);
  }

  console.log("\n-- oncalendar: matching against an independent expander --");
  {
    const rng = seeded(20261002);
    let compared = 0;
    let disagreed = 0;
    let first = "";
    for (let n = 0; n < 500; n += 1) {
      const expression = randomCalendar(rng, true);
      let spec;
      try {
        spec = parseCalendar(expression);
      } catch {
        continue;
      }
      const day = 1 + Math.floor(rng() * 28);
      const from: CalendarWall = { year: 2026, month: 1 + Math.floor(rng() * 12), day, hour: Math.floor(rng() * 24), minute: Math.floor(rng() * 60), us: 0 };
      const expected = oracleMatches(spec.normalized, from, 5, 1500);
      const got: CalendarWall[] = [];
      let cursor: CalendarWall | null = from;
      while (got.length < expected.length && cursor !== null) {
        const found = nextMatch(spec, cursor);
        if (found === null) break;
        got.push(found);
        cursor = { ...found, us: found.us + 1 };
      }
      compared += 1;
      if (got.map(wallText).join() !== expected.map(wallText).join()) {
        disagreed += 1;
        if (first === "") first = `${expression} from ${wallText(from)}: ${got.map(wallText).join(", ")} vs ${expected.map(wallText).join(", ")}`;
      }
    }
    check(`${compared} generated expressions match the expander minute by minute`, compared > 300 && disagreed === 0, first);
  }

  console.log("\n-- oncalendar: crontab schedules converted to OnCalendar= --");
  {
    const CONVERTED: readonly [string, string[]][] = [
      ["30 8 * * 1-5", ["Mon..Fri *-*-* 08:30:00"]],
      ["*/15 * * * *", ["*-*-* *:00/15:00"]],
      ["0 * * * *", ["*-*-* *:00:00"]],
      ["0 0 * * *", ["*-*-* 00:00:00"]],
      ["0 0 1 * *", ["*-*-01 00:00:00"]],
      ["0 0 13 * 5", ["*-*-13 00:00:00", "Fri *-*-* 00:00:00"]],
      ["0 0 */2 * 1", ["Mon *-*-01..31/2 00:00:00"]],
      ["0 */7 * * *", ["*-*-* 00..21/7:00:00"]],
      ["0 */6 * * *", ["*-*-* 00/6:00:00"]],
      ["0 0 1 */3 *", ["*-01/3-01 00:00:00"]],
      ["0 9-17 * * 1-5", ["Mon..Fri *-*-* 09..17:00:00"]],
      ["0 0 1 1,4,7,10 *", ["*-01,04,07,10-01 00:00:00"]],
      ["0 0 * * 0,6", ["Sat,Sun *-*-* 00:00:00"]],
      ["5,10 1 2 3 *", ["*-03-02 01:05,10:00"]],
    ];
    for (const [cron, lines] of CONVERTED) {
      const schedule = parseSchedule(cron) as CronTimes;
      const got = fromCron(schedule);
      check(`${cron} → ${lines.join(" + ")}`, got.join(" + ") === lines.join(" + "), got.join(" + "));
      for (const line of got) check(`  ${line} is a valid calendar event`, refusal(() => parseCalendar(line)).en === "");
    }

    // Every converted schedule elapses exactly when cron runs the original.
    const rng = seeded(4242);
    const field = (lo: number, hi: number): string => {
      const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
      const r = rng();
      if (r < 0.35) return "*";
      if (r < 0.5) return `*/${int(2, Math.max(2, Math.floor((hi - lo) / 2)))}`;
      const items = Array.from({ length: rng() < 0.7 ? 1 : int(2, 3) }, () => {
        const a = int(lo, hi);
        const b = int(a, hi);
        const s = rng();
        if (s < 0.5) return String(a);
        if (s < 0.8) return `${a}-${b}`;
        return `${a}-${b}/${int(1, Math.max(1, hi - lo))}`;
      });
      return items.join(",");
    };
    let agreed = 0;
    let differed = "";
    const from = at("UTC", "2026-10-02 00:00:00");
    for (let n = 0; n < 300; n += 1) {
      const cron = [field(0, 59), field(0, 23), field(1, 31), field(1, 12), field(0, 6)].join(" ");
      const schedule = parseSchedule(cron) as CronTimes;
      const runs = nextRuns(schedule, "UTC", from * 1000, 40);
      const cronTimes = runs.runs.map((run) => run.ms / 1000);
      const lines = fromCron(schedule);
      const merged = [...new Set(lines.flatMap((line) => elapsesFrom(line, "UTC", from, 40)))].sort((a, b) => a - b).slice(0, 40);
      if (merged.join() === cronTimes.join()) agreed += 1;
      else if (differed === "") differed = `${cron} → ${lines.join(" + ")}: ${merged.slice(0, 3).map(utcText)} vs ${cronTimes.slice(0, 3).map(utcText)}`;
    }
    check(`300 random crontab schedules elapse when cron runs them`, agreed === 300, differed);
  }

  const shell = findSystemd();
  if (shell === null) {
    console.log("\n  note: systemd-analyze is not reachable (Linux, or WSL on Windows) — the live systemd cross-checks were skipped.");
    return;
  }

  console.log("\n-- oncalendar: systemd-analyze itself, on generated expressions --");
  {
    const rng = seeded(7);
    const ZONES = ["UTC", "Asia/Ho_Chi_Minh", "America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "America/Santiago"];
    // Bases near the 2026 clock changes, and a scatter through the year.
    const BASES = [
      at("America/New_York", "2026-03-07 22:00:00"),
      at("America/New_York", "2026-10-31 22:00:00"),
      at("Europe/Berlin", "2026-03-28 23:00:00"),
      at("Europe/Berlin", "2026-10-24 23:00:00"),
      at("Australia/Lord_Howe", "2026-04-04 22:00:00"),
      at("Australia/Lord_Howe", "2026-10-03 22:00:00"),
      at("America/Santiago", "2026-04-04 20:00:00"),
      at("America/Santiago", "2026-09-05 20:00:00"),
    ];
    const queries: CalendarQuery[] = [];
    for (let n = 0; n < 500; n += 1) {
      const base = rng() < 0.5 ? BASES[Math.floor(rng() * BASES.length)]! : at("UTC", "2026-01-01 00:00:00") + Math.floor(rng() * 365 * 86_400);
      queries.push({ expression: randomCalendar(rng), zone: ZONES[Math.floor(rng() * ZONES.length)]!, base, iterations: 4 });
    }
    compareWithSystemd(check, "generated expressions", queries, askSystemd(shell, queries));
  }

  console.log("\n-- oncalendar: systemd-analyze on steps that run past a clock change --");
  {
    // An item with a step and no end overflows into the next day, month or
    // year. These put that overflow just before real clock changes, where
    // systemd 259 either gives up or resumes late, and the library must agree.
    const rng = seeded(259);
    const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
    const pad = (v: number) => String(v).padStart(2, "0");
    const CHANGES: readonly [string, string, string][] = [
      // zone, the day the clocks go forward, the day they go back
      ["America/New_York", "2026-03-08", "2026-11-01"],
      ["Europe/Berlin", "2026-03-29", "2026-10-25"],
      ["Australia/Sydney", "2026-10-04", "2026-04-05"],
      ["Australia/Lord_Howe", "2026-10-04", "2026-04-05"],
      ["America/Santiago", "2026-09-06", "2026-04-05"],
      ["Pacific/Auckland", "2026-09-27", "2026-04-05"],
      ["America/Havana", "2026-03-08", "2026-11-01"],
    ];
    const shiftDay = (date: string, days: number): string =>
      new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const queries: CalendarQuery[] = [];
    for (const [zone, forward, back] of CHANGES) {
      for (const day of [forward, back]) {
        for (let n = 0; n < 24; n += 1) {
          const kind = rng();
          let expression: string;
          let base: number;
          if (kind < 0.45) {
            const step = int(5, 13);
            expression = `${pad(int(0, step - 1))}/${step}:${pad(int(0, 59))}`;
            base = at(zone, `${shiftDay(day, -1)} ${pad(int(12, 23))}:${pad(int(0, 59))}:00`);
          } else if (kind < 0.7) {
            const step = int(5, 20);
            const weekday = rng() < 0.4 ? `${DAYS[int(0, 6)]} ` : "";
            expression = `${weekday}*-*-${pad(int(1, Math.min(step, 28)))}/${step}`;
            base = at(zone, `${shiftDay(day, -int(20, 70))} 00:00:00`);
          } else if (kind < 0.85) {
            const step = int(2, 7);
            expression = `*-${pad(int(1, step))}/${step}-01`;
            base = at(zone, `${shiftDay(day, -int(60, 300))} 00:00:00`);
          } else {
            const step = int(7, 29);
            expression = `*:${pad(int(0, step - 1))}/${step}`;
            base = at(zone, `${day} 00:${pad(int(0, 59))}:00`) - 3600 * int(0, 3);
          }
          queries.push({ expression, zone, base, iterations: 6 });
        }
      }
    }
    compareWithSystemd(check, "overflowing steps", queries, askSystemd(shell, queries));
  }

  console.log("\n-- oncalendar: systemd-analyze on steps that run past midnight, a month or a year --");
  {
    // No clock change needed: crossing midnight resets only the hour, and a
    // month only the day, so the minute or hour the overflow landed on stays.
    const rng = seeded(1231);
    const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
    const pad = (v: number) => String(v).padStart(2, "0");
    const ZONES = ["UTC", "Asia/Ho_Chi_Minh", "Europe/Berlin", "America/New_York"];
    const queries: CalendarQuery[] = [];
    for (let n = 0; n < 300; n += 1) {
      const zone = ZONES[int(0, ZONES.length - 1)]!;
      const year = rng() < 0.5 ? 2026 : 2027;
      const month = int(1, 12);
      const lastDay = `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
      const kind = rng();
      let expression: string;
      let base: string;
      if (kind < 0.35) {
        const step = int(5, 13);
        expression = `${pad(int(0, step - 1))}/${step}:${pad(int(0, 59))}`;
        base = `${lastDay} ${pad(int(14, 23))}:${pad(int(0, 59))}:00`;
      } else if (kind < 0.6) {
        const step = int(7, 29);
        expression = `*:${pad(int(0, step - 1))}/${step}`;
        base = `${lastDay} 23:${pad(int(30, 59))}:00`;
      } else if (kind < 0.8) {
        const step = int(7, 29);
        expression = `*:*:${pad(int(0, step - 1))}/${step}`;
        base = `${lastDay} 23:59:${pad(int(0, 59))}`;
      } else {
        const step = int(5, 20);
        expression = `*-*-${pad(int(1, step))}/${step}`;
        base = `${year}-${pad(month)}-${pad(int(20, daysInMonth(year, month)))} 12:00:00`;
      }
      queries.push({ expression, zone, base: at(zone, base), iterations: 4 });
    }
    compareWithSystemd(check, "steps across midnight and month ends", queries, askSystemd(shell, queries));
  }
}

/** Puts each answer next to the library's, and reports the first disagreement of each kind. */
function compareWithSystemd(check: Check, label: string, queries: readonly CalendarQuery[], answers: readonly CalendarAnswer[]): void {
  let valid = 0;
  let failures = 0;
  let validity = "";
  let normalized = "";
  let elapses = "";
  queries.forEach((query, i) => {
    const answer = answers[i]!;
    let spec;
    try {
      spec = parseCalendar(query.expression);
    } catch {
      spec = null;
    }
    if ((spec === null) !== (answer.normalized === null)) {
      if (validity === "") validity = `${query.expression}: systemd ${answer.normalized ?? "refused"}, here ${spec?.normalized ?? "refused"}`;
      return;
    }
    if (spec === null) return;
    valid += 1;
    if (spec.normalized !== answer.normalized) {
      if (normalized === "") normalized = `${query.expression}: ${answer.normalized} vs ${spec.normalized}`;
      return;
    }
    const search = searchFrom(query.expression, query.zone, query.base, query.iterations);
    const got = search.elapses.map((e) => Math.floor(e.us / 1_000_000));
    const where = `${query.expression} in ${query.zone} from ${utcText(query.base)}`;
    if (answer.failed) {
      failures += 1;
      if (search.stuck === null && elapses === "") elapses = `${where}: systemd gives up, here ${got.map(utcText).join(", ")}`;
    } else if (search.stuck !== null) {
      if (elapses === "") elapses = `${where}: systemd ${answer.elapses.map(utcText).join(", ")}, here stuck after ${got.length}`;
    } else if (got.join() !== answer.elapses.join()) {
      if (elapses === "") elapses = `${where}: ${got.map(utcText).join(", ")} vs ${answer.elapses.map(utcText).join(", ")}`;
    }
  });
  console.log(`     ${queries.length} ${label}, ${valid} valid, ${failures} that systemd itself cannot schedule`);
  check(`systemd accepts and refuses the same ${label}`, validity === "", validity);
  check("and normalizes them identically", normalized === "", normalized);
  check("and lists the same elapses, or gives up in the same places", elapses === "", elapses);
}
