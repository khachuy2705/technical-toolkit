/**
 * Checks for `src/lib/cron.ts`.
 *
 * The schedule search is pinned to an independent oracle rather than to
 * fixtures: a separate field expander and a minute-by-minute matcher written
 * from crontab(5), with none of the library's code, run against four hundred
 * generated expressions. Daylight saving is checked as a property of whole
 * years in three zones — one run per local day for a fixed-time job, one run
 * per wall hour for a wildcard one — rather than at a single transition.
 */

import {
  CRONTAB_LINE_LIMIT,
  CronError,
  FIELD_IDS,
  MACROS,
  buildExpression,
  buildField,
  choiceFromField,
  describeFieldValues,
  describeSchedule,
  everyChoice,
  formatRun,
  nextRuns,
  parseCrontab,
  parseField,
  parseSchedule,
  type CronJob,
  type CronSchedule,
  type CronTimes,
  type FieldChoice,
  type FieldId,
} from "../src/lib/cron";
import { civilFromDays, daysFromCivil, wallTimeAt, wallTimeToMs, zoneOffsetMs } from "../src/lib/epoch";
import type { Check } from "./verify-tools";

/* ------------------------------------------------------------------ oracle */

const ORACLE_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const ORACLE_DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** crontab(5) field expansion, written again from the manual page. */
function oracleSet(text: string, lo: number, hi: number, names: Record<string, number> | null): Set<number> {
  const out = new Set<number>();
  const read = (token: string): number => (/^\d+$/.test(token) ? Number(token) : names![token.toLowerCase()]!);
  for (const item of text.split(",")) {
    const [range, stepText] = item.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    let a: number;
    let b: number;
    if (range === "*") {
      a = lo;
      b = hi;
    } else if (range.includes("-")) {
      const [x, y] = range.split("-") as [string, string];
      a = read(x);
      b = read(y);
    } else {
      a = read(range);
      b = stepText === undefined ? a : hi;
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** The first `count` runs after `fromMs`, in UTC, found by looking at every minute of every candidate day. */
function oracleRuns(expression: string, fromMs: number, count: number, horizonDays: number): number[] {
  const [mi, h, dom, mon, dow] = expression.split(" ") as [string, string, string, string, string];
  const minutes = oracleSet(mi, 0, 59, null);
  const hours = oracleSet(h, 0, 23, null);
  const days = oracleSet(dom, 1, 31, null);
  const months = oracleSet(mon, 1, 12, ORACLE_MONTHS);
  const weekdays = new Set([...oracleSet(dow, 0, 7, ORACLE_DAYS)].map((v) => (v === 7 ? 0 : v)));
  // The manual's rule: if either day field is "*", both must match; otherwise either may.
  const either = !dom.startsWith("*") && !dow.startsWith("*");

  const out: number[] = [];
  const first = Math.floor(fromMs / 86_400_000);
  for (let day = first; day < first + horizonDays && out.length < count; day += 1) {
    const date = new Date(day * 86_400_000);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const domOk = days.has(date.getUTCDate());
    const dowOk = weekdays.has(date.getUTCDay());
    if (either ? !(domOk || dowOk) : !(domOk && dowOk)) continue;
    for (let minute = 0; minute < 1440 && out.length < count; minute += 1) {
      const ms = day * 86_400_000 + minute * 60_000;
      if (ms > fromMs && hours.has(Math.floor(minute / 60)) && minutes.has(minute % 60)) out.push(ms);
    }
  }
  return out;
}

/** mulberry32: a seeded generator, so a failing expression can be reproduced. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES_FOR: Partial<Record<FieldId, readonly string[]>> = {
  month: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  dow: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};
const BOUNDS: Record<FieldId, readonly [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7],
};

function randomField(rng: () => number, id: FieldId): string {
  const [lo, hi] = BOUNDS[id];
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const names = NAMES_FOR[id];
  const show = (v: number) => {
    if (!names || rng() > 0.3) return String(v);
    const index = id === "month" ? v - 1 : v;
    return names[index] ?? String(v);
  };
  const item = (): string => {
    const r = rng();
    if (r < 0.25) return "*";
    if (r < 0.4) return `*/${int(2, hi - lo)}`;
    if (r < 0.6) return show(int(lo, hi));
    const a = int(lo, hi);
    const b = int(a, hi);
    if (r < 0.75) return `${show(a)}-${show(b)}`;
    if (r < 0.9) return `${a}-${b}/${int(1, hi - lo)}`;
    return `${a}/${int(1, hi - lo)}`;
  };
  const count = rng() < 0.75 ? 1 : int(2, 3);
  return Array.from({ length: count }, item).join(",");
}

/* ----------------------------------------------------------------- helpers */

function refusal(attempt: () => unknown): { said: string; typed: boolean } {
  try {
    attempt();
    return { said: "", typed: false };
  } catch (error) {
    return { said: (error as Error).message, typed: error instanceof CronError };
  }
}

const times = (text: string): CronTimes => {
  const schedule = parseSchedule(text);
  if (schedule.kind !== "times") throw new Error(`${text} is not a timed schedule`);
  return schedule;
};

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);

function jobsOf(text: string, userField = false): CronJob[] {
  return parseCrontab(text, { userField }).filter((entry): entry is CronJob => entry.kind === "job");
}

/** Local calendar date of an instant, as days since the epoch. */
function localDay(ms: number, zone: string): number {
  const wall = wallTimeAt(ms, zone);
  return daysFromCivil(wall.year, wall.month, wall.day);
}

/* ------------------------------------------------------------------ checks */

export async function runCronChecks(check: Check): Promise<void> {
  console.log("\n-- cron: fields --");
  {
    const EXPANSIONS: readonly [FieldId, string, readonly number[]][] = [
      ["minute", "*/15", [0, 15, 30, 45]],
      ["minute", "5/15", [5, 20, 35, 50]],
      ["minute", "0-10/5,30", [0, 5, 10, 30]],
      ["hour", "22-23,0-2", [0, 1, 2, 22, 23]],
      ["dom", "*/10", [1, 11, 21, 31]],
      ["month", "*/3", [1, 4, 7, 10]],
      ["month", "JAN,jul", [1, 7]],
      ["month", "mar-may", [3, 4, 5]],
      ["dow", "*/2", [0, 2, 4, 6]],
      ["dow", "5-7", [0, 5, 6]],
      ["dow", "7", [0]],
      ["dow", "MON-fri", [1, 2, 3, 4, 5]],
      ["dow", "1/2", [0, 1, 3, 5]],
    ];
    for (const [id, text, values] of EXPANSIONS) {
      const got = parseField(id, text).values;
      check(`${id} ${text} expands to ${values.join(",")}`, got.join(",") === values.join(","), got.join(","));
    }

    // Rule 2 lives in the first character, so the flag is pinned apart from the values.
    check("*/2 is star-led, 1-31/2 is not", parseField("dom", "*/2").star && !parseField("dom", "1-31/2").star);
    check(
      "and both expand to the same days",
      parseField("dom", "*/2").values.join() === parseField("dom", "1-31/2").values.join(),
    );
    check("0-59 is full without being star-led", parseField("minute", "0-59").full && !parseField("minute", "0-59").star);
    check("day of week 1-7 is every day", parseField("dow", "1-7").full, parseField("dow", "1-7").values.join());
    check("5/15 is flagged as open-ended", parseField("minute", "5/15").parts[0]!.openEnded === true);
  }

  console.log("\n-- cron: schedules --");
  {
    const rule = (text: string) => times(text).dayRule;
    check("both day fields set → OR", rule("0 0 13 * 5") === "or");
    check("a star-led day field → AND, even when it is */2", rule("0 0 */2 * 1") === "and");
    check("the same days written 1-31/2 → OR", rule("0 0 1-31/2 * 1") === "or");
    check("day of week alone → AND with a * day of month", rule("0 0 * * 1") === "and");

    check("0 * * * * is a wildcard job (hour starts with *)", times("0 * * * *").wildcard);
    check("*/5 1 * * * is a wildcard job (minute starts with *)", times("*/5 1 * * *").wildcard);
    check("0 0 * * * is a fixed-time job", !times("0 0 * * *").wildcard);
    check("0-59/5 1 * * * is fixed-time — the flag is the first character", !times("0-59/5 1 * * *").wildcard);

    for (const [macro, expansion] of MACROS) {
      const schedule = parseSchedule(macro);
      check(
        `${macro} stands for ${expansion}`,
        schedule.kind === "times" && schedule.expression === expansion && schedule.macro === macro,
        schedule.expression,
      );
    }
    check("@reboot has no fields", parseSchedule("@reboot").kind === "reboot");
    check("spacing is forgiven", times("  30\t8  *  * 1-5 ").expression === "30 8 * * 1-5");
  }

  console.log("\n-- cron: refusals --");
  {
    const REFUSED: readonly [string, string, RegExp][] = [
      ["an empty input", "   ", /Enter a cron expression/],
      ["four fields", "* * * *", /five fields.*this has 4/],
      ["six fields, by dialect", "0 0 12 * * ?", /Quartz or Spring, which put seconds first/],
      ["minute 60", "60 * * * *", /^Minute: 60 is out of range — minutes run 0–59\.$/],
      ["hour 24", "0 24 * * *", /^Hour: 24 is out of range — hours run 0–23, and midnight is 0\.$/],
      ["day 0", "0 0 0 * *", /^Day of month: 0 is out of range/],
      ["month 13", "0 0 1 13 *", /^Month: 13 is out of range/],
      ["weekday 8", "0 0 * * 8", /both 0 and 7 are Sunday/],
      ["a range that wraps", "0 22-2 * * *", /runs backwards.*write 22-23,0-2/],
      ["a weekday range that wraps", "0 0 * * sat-sun", /write 6,0/],
      ["a step of 0", "*/0 * * * *", /step of 0/],
      ["an empty list item", "1,,2 * * * *", /empty item/],
      ["a long day name", "0 0 * * monday", /three-letter names — write “mon”/],
      ["an unknown day name", "0 0 * * xyz", /not a day name/],
      ["a name in the minute field", "mon * * * *", /names only work in the month and day-of-week/],
      ["Quartz L", "0 0 L * *", /“L” \(last day\) is Quartz/],
      ["Quartz W", "0 0 15W * *", /nearest weekday/],
      ["Quartz ?", "0 0 ? * *", /“\?” is Quartz and Spring/],
      ["Quartz #", "0 0 * * 5#3", /nth weekday.*days 15-21/],
      ["Jenkins H", "H * * * *", /Jenkins/],
      ["Go's @every", "@every 5m", /robfig\/cron/],
      ["an upper-case shorthand", "@DAILY", /lower-case: @daily/],
      ["an unknown shorthand", "@weekdays", /not a crontab shorthand/],
      ["words after a shorthand", "@daily now", /nothing follows it/],
      ["* as a range end", "*-5 * * * *", /cannot be one end of a range/],
      ["a step with nothing to step", "/5 * * * *", /nothing to step through/],
      ["two hyphens", "1-2-3 * * * *", /one hyphen/],
      ["two steps", "1/2/3 * * * *", /more than one step/],
      ["a fractional step", "*/1.5 * * * *", /whole number/],
    ];
    for (const [name, text, message] of REFUSED) {
      const { said, typed } = refusal(() => parseSchedule(text));
      check(`refuses ${name}`, message.test(said) && typed, said || "(accepted)");
    }
  }

  console.log("\n-- cron: descriptions --");
  {
    const SAID: readonly [string, string, string][] = [
      ["* * * * *", "Every minute.", "Mỗi phút."],
      ["*/5 * * * *", "Every 5 minutes.", "Cứ 5 phút một lần."],
      ["0 * * * *", "Every hour, on the hour.", "Mỗi giờ một lần, vào phút 00."],
      ["15,45 * * * *", "Every hour at :15 and :45.", "Mỗi giờ, vào phút 15 và 45."],
      ["0 0 * * *", "At 00:00 every day.", "Lúc 00:00 hằng ngày."],
      ["30 8 * * 1-5", "At 08:30, Monday through Friday.", "Lúc 08:30, từ thứ Hai đến thứ Sáu."],
      ["0 9 * * 1", "At 09:00 every Monday.", "Lúc 09:00 vào mỗi thứ Hai."],
      ["0 0 * * 0,6", "At 00:00 on Saturday and Sunday.", "Lúc 00:00 vào thứ Bảy và Chủ nhật."],
      ["0 0 * * 5-7", "At 00:00, Friday through Sunday.", "Lúc 00:00, từ thứ Sáu đến Chủ nhật."],
      ["0 0 1 1 *", "At 00:00 on the 1st of January.", "Lúc 00:00 vào ngày 1 tháng 1."],
      ["0 0 1 * *", "At 00:00 on the 1st of every month.", "Lúc 00:00 vào ngày 1 hằng tháng."],
      [
        "*/15 9-17 * * 1-5",
        "Every 15 minutes, between 09:00 and 17:59, Monday through Friday.",
        "Cứ 15 phút một lần, từ 09:00 đến 17:59, từ thứ Hai đến thứ Sáu.",
      ],
      [
        "0 9-17 * * 1-5",
        "Every hour from 09:00 to 17:00, Monday through Friday.",
        "Mỗi giờ vào phút 00, từ 09:00 đến 17:00, từ thứ Hai đến thứ Sáu.",
      ],
      [
        "0 0 13 * 5",
        "At 00:00 on the 13th of every month, and also every Friday.",
        "Lúc 00:00 vào ngày 13 hằng tháng, và cả mọi thứ Sáu.",
      ],
      [
        "0 0 */2 * 1",
        "At 00:00 on every 2nd day of every month, but only if that day is a Monday.",
        "Lúc 00:00 cứ 2 ngày một lần tính từ ngày 1 hằng tháng, nhưng chỉ khi ngày đó là thứ Hai.",
      ],
      ["0 12 * 1,7 *", "At 12:00 every day in January and July.", "Lúc 12:00 hằng ngày trong các tháng 1 và 7."],
      ["* 9 * * *", "Every minute, between 09:00 and 09:59.", "Mỗi phút, từ 09:00 đến 09:59."],
      ["5/15 * * * *", "Every 15 minutes from :05 to :50.", "Cứ 15 phút một lần, từ phút 5 đến phút 50."],
      [
        "0 0,12 1 */2 *",
        "At 00:00 and 12:00 on the 1st of January, March, May, July, September and November.",
        "Lúc 00:00 và 12:00 vào ngày 1 trong các tháng 1, 3, 5, 7, 9 và 11.",
      ],
      ["0 4 8-14 * *", "At 04:00 on the 8th through 14th of every month.", "Lúc 04:00 vào các ngày từ 8 đến 14 hằng tháng."],
      ["23 0-20/2 * * *", "Every 2 hours at :23, from 00:23 to 20:23.", "Cứ 2 giờ một lần vào phút 23, từ 00:23 đến 20:23."],
      ["0 */2 * * *", "Every 2 hours, on the hour, from 00:00 to 22:00.", "Cứ 2 giờ một lần vào phút 00, từ 00:00 đến 22:00."],
      ["0 0 29 2 *", "At 00:00 on the 29th of February.", "Lúc 00:00 vào ngày 29 tháng 2."],
      [
        "0 0 1 3-10 *",
        "At 00:00 on the 1st of each month from March through October.",
        "Lúc 00:00 vào ngày 1 từ tháng 3 đến tháng 10.",
      ],
      ["0 9 * 12 1", "At 09:00 every Monday in December.", "Lúc 09:00 vào mỗi thứ Hai trong tháng 12."],
      [
        "0 0 13 6 5",
        "At 00:00 on the 13th of June, and also every Friday in June.",
        "Lúc 00:00 vào ngày 13 tháng 6, và cả mọi thứ Sáu trong tháng 6.",
      ],
      [
        "0 1,3,5,7,9,11,13 * * *",
        "At :00 past hours 1, 3, 5, 7, 9, 11 and 13.",
        "Vào phút 00 của các giờ 1, 3, 5, 7, 9, 11 và 13.",
      ],
      [
        "@reboot",
        "Once, when the cron daemon starts — normally once per boot.",
        "Một lần, khi dịch vụ cron khởi động — thường là mỗi lần bật máy.",
      ],
    ];
    for (const [expression, en, vi] of SAID) {
      const schedule = parseSchedule(expression);
      const gotEn = describeSchedule(schedule, "en");
      const gotVi = describeSchedule(schedule, "vi");
      check(`"${expression}" reads as: ${en}`, gotEn === en, gotEn);
      check(`"${expression}" in Vietnamese`, gotVi === vi, gotVi);
    }

    // A shorthand and its expansion must never be described differently.
    for (const [macro, expansion] of MACROS) {
      const a = describeSchedule(parseSchedule(macro), "en");
      const b = describeSchedule(parseSchedule(expansion), "en");
      check(`${macro} is described as ${expansion} is`, a === b, `${a} | ${b}`);
    }

    const VALUES: readonly [FieldId, string, "en" | "vi", string][] = [
      ["dow", "1-5", "en", "Monday–Friday"],
      ["dow", "0,6", "en", "Saturday and Sunday"],
      ["dow", "1-5", "vi", "thứ Hai–thứ Sáu"],
      ["month", "1,7", "vi", "tháng 1 và tháng 7"],
      ["month", "3-5,12", "en", "March–May and December"],
      ["minute", "*/2", "en", "0, 2, 4, 6, …, 58 (30 values)"],
      ["hour", "*", "vi", "mọi giờ"],
      ["dom", "1-7,15", "en", "1–7 and 15"],
    ];
    for (const [id, text, lang, want] of VALUES) {
      const got = describeFieldValues(parseField(id, text), lang);
      check(`${id} ${text} matches “${want}”`, got === want, got);
    }
  }

  console.log("\n-- cron: notes --");
  {
    const notesOf = (line: string) => jobsOf(line)[0]?.notes ?? [];
    const has = (line: string, pattern: RegExp) => notesOf(line).some((note) => pattern.test(note));

    check("*/7 minutes: the last gap is 4", has("*/7 * * * * x", /gap from :56 to :00 is 4 minutes, not 7/));
    check("*/5 hours: the last gap is 4", has("0 */5 * * * x", /gap from 20:00 to 00:00 is 4 hours, not 5/));
    check("*/5 months: the last gap is 2", has("0 0 1 */5 * x", /gap from November to January is 2 months, not 5/));
    check("*/2 weekdays: Saturday runs into Sunday", has("0 0 * * */2 x", /gap from Saturday to Sunday is 1 day, not 2/));
    check("*/15 minutes divides the hour: no note", !has("*/15 * * * * x", /restarts/));
    check("*/2 days restarts on the 1st", has("0 0 */2 * * x", /restarts on the 1st of every month/));
    check(
      "day 31 lists the months without one, and the tip",
      has("0 0 31 * * x", /no run on the 31st in February, April, June, September and November\. For the last day/),
      notesOf("0 0 31 * * x").join(" | "),
    );
    check("29 February is only in leap years", has("0 0 29 2 * x", /29th of February outside leap years/));
    check("day 15 has no missing-day note", !has("0 0 15 * * x", /skipped, not moved/));
    check("the OR rule is explained, with date +%u for one weekday", has("0 0 13 * 5 x", /runs on the 13th and also every Friday.*= 5 \]/));
    check("Sunday is 7 to date +%u", has("0 0 1 * 0 x", /= 7 \]/));
    check("the star-led AND is explained", has("0 0 */2 * 1 x", /starts with \*.*Written as 1-31\/2/));
    check("5/15 recommends the portable form", has("5/15 * * * * x", /5-59\/15 means the same everywhere/));
    check("a bare % is flagged", has("0 0 * * * date +%F", /cron turns into a newline/));
    check("an escaped \\% is not", !has("0 0 * * * date +\\%F", /newline/));
    check("a sixth time field is noticed", has("0 0 * * * 0 /bin/job", /looks like a sixth time field/));
    check("a user column in a personal crontab is noticed", has("0 0 * * * root /bin/job", /belongs only in \/etc\/crontab/));
    check("@daily says what it stands for", has("@daily x", /@daily is shorthand for 0 0 \* \* \*/));
  }

  console.log("\n-- cron: next runs --");
  {
    const hcm = "Asia/Ho_Chi_Minh";
    const friday = Date.UTC(2026, 8, 25, 3, 0); // 10:00 in Hanoi
    const weekdays = nextRuns(times("30 8 * * 1-5"), hcm, friday, 3).runs.map((run) => formatRun(run.ms, hcm));
    check(
      "weekday mornings from a Friday 10:00 start on Monday",
      weekdays.map((w) => w.when).join("|") === "Mon 2026-09-28 08:30|Tue 2026-09-29 08:30|Wed 2026-09-30 08:30" &&
        weekdays.every((w) => w.offset === "+07:00"),
      weekdays.map((w) => `${w.when} ${w.offset}`).join("|"),
    );

    const exact = Date.UTC(2026, 8, 25, 1, 30); // exactly 08:30 in Hanoi
    const next = nextRuns(times("30 8 * * *"), hcm, exact, 1).runs[0]!;
    check("a run at the very instant searched from is not 'next'", iso(next.ms) === "2026-09-26T01:30", iso(next.ms));

    const midnight = nextRuns(times("0 0 * * *"), hcm, friday, 1).runs[0]!;
    check("midnight in Hanoi is 17:00 UTC the day before", iso(midnight.ms) === "2026-09-25T17:00", iso(midnight.ms));

    const leap = nextRuns(times("0 0 29 2 *"), "UTC", Date.UTC(2096, 0, 1), 3).runs.map((run) => iso(run.ms).slice(0, 10));
    check("29 February skips 2100, which is not a leap year", leap.join(" ") === "2096-02-29 2104-02-29 2108-02-29", leap.join(" "));

    for (const never of ["0 0 30 2 *", "0 0 31 4 *", "0 0 31 4,6,9,11 *", "0 0 31 2 */7"]) {
      const search = nextRuns(times(never), "UTC", friday, 5);
      check(`${never} never runs, and says so`, search.never && search.runs.length === 0);
    }
    const orFeb = nextRuns(times("0 0 30 2 1"), "UTC", friday, 3);
    check("30 February OR Monday still runs — on February's Mondays", !orFeb.never && orFeb.runs.length === 3, String(orFeb.runs.length));
    const thirtyFirst = nextRuns(times("0 0 31 * *"), "UTC", Date.UTC(2026, 0, 1), 7).runs.map((run) => new Date(run.ms).getUTCMonth() + 1);
    check("the 31st runs in seven months a year", thirtyFirst.join(",") === "1,3,5,7,8,10,12", thirtyFirst.join(","));

    const andRuns = nextRuns(times("0 0 */2 * 1"), "UTC", friday, 20).runs;
    check(
      "*/2 with Monday runs only on odd-numbered Mondays",
      andRuns.length === 20 && andRuns.every((run) => new Date(run.ms).getUTCDay() === 1 && new Date(run.ms).getUTCDate() % 2 === 1),
    );

    check("@reboot has no next run", nextRuns(parseSchedule("@reboot"), "UTC", friday, 5).runs.length === 0);

    // The oracle: 400 generated expressions, each compared run for run over
    // the next 800 days of UTC, where no clock change can interfere.
    const rng = seeded(20260925);
    const from = Date.UTC(2026, 8, 25, 10, 17, 30);
    const HORIZON = 800;
    let compared = 0;
    let mismatch: string | null = null;
    for (let i = 0; i < 400 && mismatch === null; i += 1) {
      const expression = FIELD_IDS.map((id) => randomField(rng, id)).join(" ");
      let schedule: CronSchedule;
      try {
        schedule = parseSchedule(expression);
      } catch (error) {
        mismatch = `${expression} was refused: ${(error as Error).message}`;
        break;
      }
      const limit = from + HORIZON * 86_400_000;
      const ours = nextRuns(schedule, "UTC", from, 20).runs.map((run) => run.ms).filter((ms) => ms < Math.floor(from / 86_400_000) * 86_400_000 + HORIZON * 86_400_000);
      const theirs = oracleRuns(expression, from, 20, HORIZON);
      if (ours.join() !== theirs.slice(0, ours.length).join() || (ours.length < 20 && theirs.length !== ours.length)) {
        mismatch = `${expression}: ${ours.slice(0, 3).map(iso).join(",")} vs ${theirs.slice(0, 3).map(iso).join(",")} (limit ${iso(limit)})`;
      }
      compared += 1;
    }
    check(`400 generated schedules agree with an independent matcher (${compared} compared)`, mismatch === null, mismatch ?? "");
  }

  console.log("\n-- cron: daylight saving --");
  {
    const ny = "America/New_York";
    const kinds = (text: string, from: number, count: number) =>
      nextRuns(times(text), ny, from, count).runs.map((run) => `${iso(run.ms).slice(5)}:${run.kind}`).join(" ");

    const spring = Date.UTC(2026, 2, 8, 4, 0); // 23:00 EST on 7 March
    const fall = Date.UTC(2026, 10, 1, 4, 0); // 00:00 EDT on 1 November
    check("02:30 on spring-forward day runs at the jump, 03:00 EDT", kinds("30 2 * * *", spring, 2) === "03-08T07:00:gap 03-09T06:30:normal", kinds("30 2 * * *", spring, 2));
    check("01:30 on fall-back day runs once, the first time", kinds("30 1 * * *", fall, 2) === "11-01T05:30:overlap-once 11-02T06:30:normal", kinds("30 1 * * *", fall, 2));
    check(
      "30 * * * * runs in both 01:30s",
      kinds("30 * * * *", fall, 4) === "11-01T04:30:normal 11-01T05:30:overlap-first 11-01T06:30:overlap-second 11-01T07:30:normal",
      kinds("30 * * * *", fall, 4),
    );
    check("0 * * * * is a wildcard job too — the hour starts with *", kinds("0 * * * *", fall, 2) === "11-01T05:00:overlap-first 11-01T06:00:overlap-second", kinds("0 * * * *", fall, 2));

    const lost = nextRuns(times("30 * * * *"), ny, spring, 6);
    check(
      "30 * * * * loses 02:30 on spring-forward day, and reports it",
      lost.skipped.length === 1 && lost.skipped[0]!.wall.hour === 2 && iso(lost.skipped[0]!.ms) === "2026-03-08T07:00" && !lost.runs.some((run) => run.wall.hour === 2),
      JSON.stringify(lost.skipped),
    );

    // Lord Howe Island moves by thirty minutes: 02:00 becomes 02:30.
    const lh = "Australia/Lord_Howe";
    const lhRun = nextRuns(times("15 2 * * *"), lh, Date.UTC(2026, 9, 3, 0, 0), 1).runs[0]!;
    check(
      "a thirty-minute gap: 02:15 runs at the instant the offset changes",
      lhRun.kind === "gap" && zoneOffsetMs(lhRun.ms - 1000, lh) !== zoneOffsetMs(lhRun.ms, lh),
      `${iso(lhRun.ms)} ${lhRun.kind}`,
    );

    // Whole years, as properties: a fixed-time job runs exactly once on every
    // local date; a wildcard job once per wall hour that exists, twice in a
    // repeated one.
    // How many days of 2026 do not show exactly 24 :30s. Lord Howe has one: its
    // spring gap is 02:00–02:29, which no :30 falls in, while its autumn
    // repeat is 01:30–01:59, which one does.
    const UNUSUAL: Record<string, number> = { "America/New_York": 2, "Europe/London": 2, "Australia/Lord_Howe": 1 };
    for (const zone of Object.keys(UNUSUAL)) {
      const start = wallTimeToMs({ year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, zone).ms - 1;
      const firstDay = daysFromCivil(2026, 1, 1);
      for (const expression of ["30 1 * * *", "30 2 * * *", "0 2 * * *", "59 1 * * *"]) {
        const runs = nextRuns(times(expression), zone, start, 365).runs;
        const days = runs.map((run) => localDay(run.ms, zone) - firstDay);
        const once = days.length === 365 && days.every((day, index) => day === index);
        check(`${zone}: ${expression} runs once on each of 2026's 365 days`, once, `${days.length} runs`);
      }

      const hourly = nextRuns(times("30 * * * *"), zone, start, 9000).runs.filter((run) => localDay(run.ms, zone) - firstDay < 365);
      const perDay = new Map<number, number>();
      for (const run of hourly) perDay.set(localDay(run.ms, zone), (perDay.get(localDay(run.ms, zone)) ?? 0) + 1);

      // What the wall clock offers each day: an :30 that happens once counts
      // one, one that happens twice counts two, one that is skipped none.
      let wrong: string | null = null;
      let unusual = 0;
      for (let day = firstDay; day < firstDay + 365 && wrong === null; day += 1) {
        const civil = civilFromDays(day);
        let expected = 0;
        for (let hour = 0; hour < 24; hour += 1) {
          const resolved = wallTimeToMs({ ...civil, hour, minute: 30, second: 0 }, zone).resolution;
          expected += resolved === "exact" ? 1 : resolved === "overlap" ? 2 : 0;
        }
        if (expected !== 24) unusual += 1;
        const got = perDay.get(day) ?? 0;
        if (got !== expected) wrong = `${civil.year}-${civil.month}-${civil.day}: ${got} runs, ${expected} expected`;
      }
      check(
        `${zone}: 30 * * * * runs once per :30 the wall clock shows, all year (${unusual} days differ from 24)`,
        wrong === null && unusual === UNUSUAL[zone],
        wrong ?? `${unusual} unusual days`,
      );
      check(`${zone}: and its runs are in order, none twice`, hourly.every((run, i) => i === 0 || run.ms > hourly[i - 1]!.ms));
    }
  }

  console.log("\n-- cron: crontab files --");
  {
    const SAMPLE = [
      "# m h dom mon dow command",
      "SHELL=/bin/bash",
      'MAILTO=""',
      "*/15 * * * * /usr/local/bin/healthcheck.sh",
      "",
      "CRON_TZ=America/New_York",
      "30 2 * * * /usr/local/bin/backup.sh",
      "61 * * * * nope",
      "CRON_TZ=Mars/Olympus",
      "@reboot /usr/local/bin/start-agent",
      "echo hello",
    ].join("\r\n");
    const entries = parseCrontab(SAMPLE, { userField: false });
    check("comments and blank lines are skipped", entries.length === 9, String(entries.length));
    check("CRLF line numbers are counted", entries.map((entry) => entry.line).join(",") === "2,3,4,6,7,8,9,10,11", entries.map((entry) => entry.line).join(","));

    const kinds = entries.map((entry) => entry.kind).join(",");
    check("each line is read as what it is", kinds === "env,env,job,env,job,error,env,job,error", kinds);

    const mailto = entries[1];
    check("a quoted empty MAILTO is empty", mailto?.kind === "env" && mailto.value === "" && /thrown away/.test(mailto.explanation));

    const [health, backup, reboot] = entries.filter((entry): entry is CronJob => entry.kind === "job");
    check("CRON_TZ does not reach the lines above it", health?.zone === null);
    check("CRON_TZ applies to the lines below it", backup?.zone?.name === "America/New_York" && backup.zone.line === 6);
    check("an unknown CRON_TZ is dropped, and says so", reboot?.zone === null && entries[6]?.kind === "env" && /not a time zone/.test(entries[6].explanation));
    check("a job's command is the rest of the line", backup?.command === "/usr/local/bin/backup.sh");

    const bad = entries[5];
    check("a bad line keeps its number and its reason", bad?.kind === "error" && bad.line === 8 && /Minute: 61/.test(bad.message));
    const stray = entries[8];
    check("a stray command is neither a job nor a setting", stray?.kind === "error" && /neither a job nor a NAME=value/.test(stray.message));

    const DEBIAN = [
      "SHELL=/bin/sh",
      "17 *\t* * *\troot    cd / && run-parts --report /etc/cron.hourly",
      "47 6\t* * 7\troot\ttest -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.weekly )",
    ].join("\n");
    const system = jobsOf(DEBIAN, true);
    check("a system crontab's user column is read", system.length === 2 && system.every((job) => job.user === "root"));
    check("and the command keeps its own spacing", system[0]?.command === "cd / && run-parts --report /etc/cron.hourly", system[0]?.command);
    check("day of week 7 is Sunday", system[1]?.schedule.kind === "times" && system[1].schedule.fields.dow.values.join() === "0");
    const missingUser = parseCrontab("0 0 * * *", { userField: true })[0];
    check("a system line with no user is refused", missingUser?.kind === "error" && /No user name/.test(missingUser.message));

    const quartz = parseCrontab("0 0 12 * * ? /bin/job", { userField: false })[0];
    check("a Quartz line is refused by name", quartz?.kind === "error" && /Quartz or Spring expression/.test(quartz.message));

    const { said, typed } = refusal(() => parseCrontab("\n".repeat(CRONTAB_LINE_LIMIT), { userField: false }));
    check(`more than ${CRONTAB_LINE_LIMIT} lines is refused`, typed && /reads up to 1,000/.test(said), said);
  }

  console.log("\n-- cron: builder --");
  {
    const choice = (id: FieldId, patch: Partial<FieldChoice>): FieldChoice => ({ ...everyChoice(id), ...patch });
    const BUILT: readonly [string, string, boolean, string][] = [
      ["every", buildField("minute", everyChoice("minute"), false), false, "*"],
      ["every 5", buildField("minute", choice("minute", { mode: "step", step: 5 }), false), false, "*/5"],
      ["every 15 from :05", buildField("minute", choice("minute", { mode: "step", step: 15, start: 5 }), false), false, "5-59/15"],
      ["every 1 is every", buildField("hour", choice("hour", { mode: "step", step: 1 }), false), false, "*"],
      ["a list", buildField("minute", choice("minute", { mode: "specific", values: [45, 0, 15, 30, 15] }), false), false, "0,15,30,45"],
      ["runs of three become ranges", buildField("dom", choice("dom", { mode: "specific", values: [1, 2, 3, 5, 6] }), false), false, "1-3,5,6"],
      ["weekdays by name", buildField("dow", choice("dow", { mode: "specific", values: [1, 2, 3, 4, 5] }), true), true, "mon-fri"],
      ["months by name", buildField("month", choice("month", { mode: "specific", values: [1, 7] }), true), true, "jan,jul"],
      ["a range", buildField("hour", choice("hour", { mode: "range", from: 9, to: 17 }), false), false, "9-17"],
      ["a stepped range", buildField("hour", choice("hour", { mode: "range", from: 9, to: 17, step: 2 }), false), false, "9-17/2"],
      ["a one-value range", buildField("hour", choice("hour", { mode: "range", from: 9, to: 9 }), false), false, "9"],
    ];
    for (const [name, got, , want] of BUILT) check(`builder writes ${name} as ${want}`, got === want, got);

    const BUILD_REFUSED: readonly [string, () => unknown, RegExp][] = [
      ["an empty list", () => buildField("minute", choice("minute", { mode: "specific", values: [] }), false), /pick at least one/],
      ["a backwards range", () => buildField("hour", choice("hour", { mode: "range", from: 17, to: 9 }), false), /runs backwards/],
      ["a step of 0", () => buildField("minute", choice("minute", { mode: "step", step: 0 }), false), /step must be between 1 and 60/],
      ["weekday 7 in the builder", () => buildField("dow", choice("dow", { mode: "specific", values: [7] }), false), /between 0 and 6/],
    ];
    for (const [name, attempt, message] of BUILD_REFUSED) {
      const result = refusal(attempt);
      check(`builder refuses ${name}`, message.test(result.said) && result.typed, result.said || "(accepted)");
    }

    // Random builder settings: what is written must parse back to exactly the
    // values chosen, and reading it into the builder again must write it the same.
    const rng = seeded(7);
    let broken: string | null = null;
    for (let i = 0; i < 2000 && broken === null; i += 1) {
      const choices = {} as Record<FieldId, FieldChoice>;
      const intended = {} as Record<FieldId, number[]>;
      for (const id of FIELD_IDS) {
        const [lo] = BOUNDS[id];
        const hi = id === "dow" ? 6 : BOUNDS[id][1];
        const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
        const modes = id === "dow" ? (["every", "specific", "range"] as const) : (["every", "step", "specific", "range"] as const);
        const mode = modes[int(0, modes.length - 1)]!;
        let c: FieldChoice = everyChoice(id);
        let values: number[] = [];
        if (mode === "every") values = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
        if (mode === "step") {
          const step = int(1, hi - lo);
          const start = int(lo, hi);
          c = { ...c, mode, step, start };
          for (let v = start; v <= hi; v += step) values.push(v);
        }
        if (mode === "specific") {
          values = [...new Set(Array.from({ length: int(1, 6) }, () => int(lo, hi)))].sort((a, b) => a - b);
          c = { ...c, mode, values };
        }
        if (mode === "range") {
          const from = int(lo, hi);
          const to = int(from, hi);
          const step = int(1, Math.max(1, to - from));
          c = { ...c, mode, from, to, step };
          for (let v = from; v <= to; v += step) values.push(v);
        }
        choices[id] = c;
        intended[id] = values;
      }
      const names = rng() < 0.5;
      const expression = buildExpression(choices, names);
      const schedule = times(expression);
      for (const id of FIELD_IDS) {
        if (schedule.fields[id].values.join() !== intended[id].join()) {
          broken = `${expression}: ${id} is ${schedule.fields[id].values.join()} but ${intended[id].join()} was chosen`;
          break;
        }
      }
      if (broken !== null) break;
      const again = {} as Record<FieldId, FieldChoice>;
      let exact = true;
      for (const id of FIELD_IDS) {
        const read = choiceFromField(schedule.fields[id]);
        again[id] = read.choice;
        exact &&= read.exact;
      }
      const rewritten = buildExpression(again, names);
      if (!exact || rewritten !== expression) broken = `${expression} came back as ${rewritten}${exact ? "" : " (inexact)"}`;
    }
    check("2,000 random builder settings write what was chosen, and read back the same", broken === null, broken ?? "");

    // Expressions from outside the builder: loading one keeps its meaning,
    // and says when the leading * — which cron reads — could not be kept.
    const LOADS: readonly [string, boolean][] = [
      ["30 8 * * 1-5", true],
      ["*/15 9-17 * * mon-fri", true],
      ["0-59/5 * * * *", true],
      ["5/15 * * * *", true],
      ["0 0 1-31/2 * 1", true],
      ["0 0 */2 * 1", true],
      ["0 0 * * */2", false],
      ["0 0 * * 1/2", true],
      ["*/15,7 * * * *", false],
      ["0 0 * * 5-7", true],
    ];
    for (const [expression, wantExact] of LOADS) {
      const original = times(expression);
      let exact = true;
      const choices = {} as Record<FieldId, FieldChoice>;
      for (const id of FIELD_IDS) {
        const read = choiceFromField(original.fields[id]);
        choices[id] = read.choice;
        exact &&= read.exact;
      }
      const reloaded = times(buildExpression(choices, false));
      const same = FIELD_IDS.every((id) => reloaded.fields[id].values.join() === original.fields[id].values.join());
      const flags = exact ? reloaded.dayRule === original.dayRule && reloaded.wildcard === original.wildcard : true;
      check(
        `loading ${expression} keeps its values${wantExact ? " and flags" : ", and says the * was lost"}`,
        same && flags && exact === wantExact,
        `${reloaded.expression} exact=${exact}`,
      );
    }
  }
}
