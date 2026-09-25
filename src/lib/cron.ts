/**
 * Cron schedules: reading one, saying what it means, finding when it next
 * runs, and writing one from a handful of choices.
 *
 * The dialect is the crontab(5) of Vixie cron and its descendants — cronie on
 * Red Hat, Fedora and Amazon Linux, Debian's cron on Debian and Ubuntu — which
 * is what `crontab -e` edits on nearly every Linux server. Three of its rules
 * are the reason this is a module and not a regular expression:
 *
 * 1. **Day of month and day of week are joined with OR** when both are
 *    restricted. `0 0 13 * 5` runs on every 13th and on every Friday, not on
 *    Friday the 13th.
 * 2. **"Restricted" is decided by the first character, not by the values.** A
 *    field that begins with `*` counts as unrestricted for rule 1, so `*∕2` in
 *    the day-of-month field turns that OR back into an AND.
 * 3. **Daylight saving is handled by the kind of job.** A job whose minute and
 *    hour are both fixed runs once a day whatever the clocks do — at the jump,
 *    if its time was skipped. A job whose minute or hour begins with `*`
 *    follows the wall clock: it loses the skipped hour and runs twice in the
 *    repeated one.
 *
 * Errors are `CronError` carrying an English sentence meant for the page. The
 * description of a schedule is written in English or Vietnamese.
 */

import {
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  wallTimeAt,
  wallTimeToMs,
  zoneOffsetMs,
  zonedParts,
  type WallTime,
} from "./epoch";

/** A schedule or crontab line that cannot be read. The message is shown as it is. */
export class CronError extends Error {
  override name = "CronError";
}

export type CronLang = "en" | "vi";

/* ------------------------------------------------------------------- fields */

export type FieldId = "minute" | "hour" | "dom" | "month" | "dow";

export const FIELD_IDS: readonly FieldId[] = ["minute", "hour", "dom", "month", "dow"];

export const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

export const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface FieldSpec {
  readonly id: FieldId;
  readonly label: string;
  readonly min: number;
  /** Highest value the syntax accepts. Day of week takes 7 as a second Sunday. */
  readonly max: number;
  /** Highest distinct value: 6 for day of week, where 7 folds into 0. */
  readonly last: number;
  readonly names: readonly string[] | null;
}

export const FIELDS: Readonly<Record<FieldId, FieldSpec>> = {
  minute: { id: "minute", label: "Minute", min: 0, max: 59, last: 59, names: null },
  hour: { id: "hour", label: "Hour", min: 0, max: 23, last: 23, names: null },
  dom: { id: "dom", label: "Day of month", min: 1, max: 31, last: 31, names: null },
  month: { id: "month", label: "Month", min: 1, max: 12, last: 12, names: MONTH_NAMES },
  dow: { id: "dow", label: "Day of week", min: 0, max: 7, last: 6, names: DOW_NAMES },
};

const OUT_OF_RANGE: Readonly<Record<FieldId, string>> = {
  minute: "minutes run 0–59",
  hour: "hours run 0–23, and midnight is 0",
  dom: "days run 1–31",
  month: "months run 1–12",
  dow: "days run 0–7, where both 0 and 7 are Sunday",
};

/** One comma-separated item of a field: `*`, `5`, `1-5`, `*∕15`, `1-30∕2` or `5∕15`. */
export interface CronPart {
  readonly text: string;
  readonly kind: "star" | "value" | "range";
  readonly from: number;
  readonly to: number;
  readonly step: number;
  /**
   * `5∕15` — a start and a step with no end, read as `5-59∕15`. Not every cron
   * accepts it, which is why it is flagged rather than folded away.
   */
  readonly openEnded: boolean;
}

export interface CronField {
  readonly id: FieldId;
  readonly text: string;
  readonly parts: readonly CronPart[];
  /** Sorted and distinct. Day of week folds 7 into 0. */
  readonly values: readonly number[];
  /**
   * The field begins with `*`. This is what cron's DOM_STAR, DOW_STAR,
   * MIN_STAR and HR_STAR flags record, and it drives rules 2 and 3 above.
   */
  readonly star: boolean;
  /** Matches every value the field can take. */
  readonly full: boolean;
}

function fail(spec: FieldSpec, message: string): never {
  throw new CronError(`${spec.label}: ${message}`);
}

/**
 * Syntax from other schedulers, refused by name. A Quartz expression pasted
 * here is a common mistake, and "not a number" would not tell anyone why.
 */
function foreignItem(item: string): string | null {
  if (item.includes("?")) {
    return "“?” is Quartz and Spring syntax for “no specific value”. Crontab has no such marker — use *.";
  }
  if (item.includes("#")) {
    const nth = /#(\d)$/.exec(item);
    const n = nth ? Number(nth[1]) : 0;
    const days = n >= 1 && n <= 5 ? `days ${(n - 1) * 7 + 1}-${Math.min(31, n * 7)}` : "the seven days it can fall on";
    return `“${item}” (the nth weekday of the month) is Quartz syntax. In crontab, run on ${days} and test the weekday in the command.`;
  }
  if (/^H(?:$|[(/])/.test(item)) return `“${item}” is Jenkins syntax for a hashed value. Crontab needs a number.`;
  return null;
}

function foreignValue(text: string): string | null {
  if (/^(?:\d*L|L-\d+|LW)$/i.test(text)) {
    return `“${text}” (last day) is Quartz syntax. Crontab cannot say “the last day of the month” — run on 28-31 and test the date in the command.`;
  }
  if (/^\d+W$/i.test(text)) return `“${text}” (nearest weekday) is Quartz syntax that crontab does not have.`;
  return null;
}

function readValue(spec: FieldSpec, text: string, item: string): number {
  if (text === "") fail(spec, `“${item}” is missing a number.`);
  if (text === "*") {
    fail(spec, `* cannot be one end of a range, as in “${item}”. Write ${spec.min}-${spec.max} for the whole field.`);
  }
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (value < spec.min || value > spec.max) fail(spec, `${value} is out of range — ${OUT_OF_RANGE[spec.id]}.`);
    return value;
  }

  const foreign = foreignValue(text);
  if (foreign) fail(spec, foreign);

  if (/^[a-z]+$/i.test(text)) {
    if (!spec.names) fail(spec, `“${text}” is a name, and names only work in the month and day-of-week fields.`);
    const lower = text.toLowerCase();
    const index = spec.names.indexOf(lower);
    if (index >= 0) return spec.id === "month" ? index + 1 : index;
    const near = spec.names.indexOf(lower.slice(0, 3));
    if (near >= 0) fail(spec, `cron reads only three-letter names — write “${spec.names[near]}”, not “${text}”.`);
    fail(spec, `“${text}” is not a ${spec.id === "month" ? "month" : "day"} name. The names are ${spec.names.join(", ")}.`);
  }

  fail(spec, `“${text}” is not a number${spec.names ? " or a name" : ""}.`);
}

const piece = (from: number, to: number): string => (from === to ? String(from) : `${from}-${to}`);

function parsePart(spec: FieldSpec, item: string): CronPart {
  if (item === "") fail(spec, "an empty item — two commas in a row, or one at the start or end.");

  const pieces = item.split("/");
  if (pieces.length > 2) fail(spec, `“${item}” has more than one step.`);

  const base = pieces[0]!;
  let step = 1;
  if (pieces.length === 2) {
    const stepText = pieces[1]!;
    if (!/^\d+$/.test(stepText)) fail(spec, `the step in “${item}” must be a whole number.`);
    step = Number(stepText);
    if (step === 0) fail(spec, `a step of 0 in “${item}” would never advance.`);
  }

  if (base === "*") return { text: item, kind: "star", from: spec.min, to: spec.max, step, openEnded: false };
  if (base === "") fail(spec, `“${item}” has a step but nothing to step through — write */${step}.`);

  const ends = base.split("-");
  if (ends.length > 2) fail(spec, `“${item}” is not a range — a range has one hyphen, as in 1-5.`);

  const from = readValue(spec, ends[0]!, item);
  if (ends.length === 1) {
    if (pieces.length === 2) return { text: item, kind: "range", from, to: spec.max, step, openEnded: true };
    return { text: item, kind: "value", from, to: from, step: 1, openEnded: false };
  }

  const to = readValue(spec, ends[1]!, item);
  if (from > to) {
    const last = spec.id === "dow" ? spec.last : spec.max;
    fail(spec, `“${item}” runs backwards, and cron does not wrap around — write ${piece(from, last)},${piece(spec.min, to)}.`);
  }
  return { text: item, kind: "range", from, to, step, openEnded: false };
}

/** Reads one of the five fields. Throws `CronError` naming the field. */
export function parseField(id: FieldId, text: string): CronField {
  const spec = FIELDS[id];
  const parts = text.split(",").map((item) => {
    const foreign = foreignItem(item);
    if (foreign) fail(spec, foreign);
    return parsePart(spec, item);
  });

  const set = new Set<number>();
  for (const part of parts) {
    for (let value = part.from; value <= part.to; value += part.step) {
      set.add(id === "dow" && value === 7 ? 0 : value);
    }
  }
  const values = [...set].sort((a, b) => a - b);

  return {
    id,
    text,
    parts,
    values,
    star: text.startsWith("*"),
    full: values.length === spec.last - spec.min + 1,
  };
}

/* ---------------------------------------------------------------- schedules */

/** The @ shorthands and the five fields each one stands for. */
export const MACROS: ReadonlyMap<string, string> = new Map([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);

export interface CronTimes {
  readonly kind: "times";
  /** The five fields that are matched — a shorthand's expansion, not the shorthand. */
  readonly expression: string;
  /** The shorthand this came from, if it did. */
  readonly macro: string | null;
  readonly fields: Readonly<Record<FieldId, CronField>>;
  /** How the two day fields combine (rules 1 and 2). */
  readonly dayRule: "and" | "or";
  /** Minute or hour begins with `*`, which changes what happens around a DST change (rule 3). */
  readonly wildcard: boolean;
}

export interface CronReboot {
  readonly kind: "reboot";
  readonly expression: "@reboot";
  readonly macro: "@reboot";
}

export type CronSchedule = CronTimes | CronReboot;

function fromFields(tokens: readonly string[], macro: string | null): CronTimes {
  const fields = {} as Record<FieldId, CronField>;
  FIELD_IDS.forEach((id, index) => {
    fields[id] = parseField(id, tokens[index]!);
  });
  return {
    kind: "times",
    expression: tokens.join(" "),
    macro,
    fields,
    dayRule: fields.dom.star || fields.dow.star ? "and" : "or",
    wildcard: fields.minute.star || fields.hour.star,
  };
}

function readMacro(token: string): CronSchedule {
  if (token === "@reboot") return { kind: "reboot", expression: "@reboot", macro: "@reboot" };
  const expansion = MACROS.get(token);
  if (expansion !== undefined) return fromFields(expansion.split(" "), token);

  const lower = token.toLowerCase();
  if (lower === "@reboot" || MACROS.has(lower)) {
    throw new CronError(`Shorthands are lower-case: ${lower}, not ${token}.`);
  }
  if (lower === "@every") {
    throw new CronError(
      "@every is an extension of Go's robfig/cron, used by some job schedulers. Crontab has no interval syntax — */15 * * * * is every fifteen minutes.",
    );
  }
  throw new CronError(
    `“${token}” is not a crontab shorthand. The ones that exist are @reboot, ${[...MACROS.keys()].join(", ")}.`,
  );
}

function fieldCountMessage(count: number): string {
  const base = `A cron schedule has five fields — minute, hour, day of month, month and day of week — and this has ${count}.`;
  if (count === 6 || count === 7) {
    return `${base} Six or seven fields usually means Quartz or Spring, which put seconds first${count === 7 ? " and a year last" : ""}; crontab has neither.`;
  }
  return base;
}

/** Reads a schedule on its own: five fields, or one @ shorthand. */
export function parseSchedule(text: string): CronSchedule {
  const tokens = text.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) throw new CronError("Enter a cron expression — five fields, such as 30 8 * * 1-5.");
  if (tokens[0]!.startsWith("@")) {
    // Read first, so an unknown shorthand is named before the extra words are.
    const schedule = readMacro(tokens[0]!);
    if (tokens.length > 1) {
      throw new CronError(`${tokens[0]} stands for all five fields on its own; nothing follows it in a schedule.`);
    }
    return schedule;
  }
  if (tokens.length !== 5) throw new CronError(fieldCountMessage(tokens.length));
  return fromFields(tokens, null);
}

/* ------------------------------------------------------------ crontab files */

export interface CronZone {
  readonly name: string;
  /** The line that set it. */
  readonly line: number;
}

export interface CronJob {
  readonly kind: "job";
  readonly line: number;
  readonly source: string;
  readonly schedule: CronSchedule;
  /** The user column of /etc/crontab and /etc/cron.d, when the page says there is one. */
  readonly user: string | null;
  readonly command: string;
  /** A valid CRON_TZ set above this line, which cronie schedules the job in. */
  readonly zone: CronZone | null;
  /** Things worth knowing that do not stop the line from working. */
  readonly notes: readonly string[];
}

export interface CronEnv {
  readonly kind: "env";
  readonly line: number;
  readonly source: string;
  readonly name: string;
  readonly value: string;
  readonly explanation: string;
}

export interface CronBadLine {
  readonly kind: "error";
  readonly line: number;
  readonly source: string;
  readonly message: string;
}

export type CrontabEntry = CronJob | CronEnv | CronBadLine;

export interface CrontabOptions {
  /** Lines carry a user name between the schedule and the command. */
  readonly userField: boolean;
}

/** Past this, the input is not a crontab but a paste that went wrong. */
export const CRONTAB_LINE_LIMIT = 1000;

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** True when this browser (or Node) can render times in `zone`. */
export function isKnownZone(zone: string): boolean {
  if (zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

function explainEnv(name: string, value: string): string {
  switch (name) {
    case "SHELL":
      return value === "/bin/sh"
        ? "Jobs below run under /bin/sh, which is cron's default anyway."
        : `Jobs below run under ${value} instead of cron's default, /bin/sh — so bash-only syntax works in their commands.`;
    case "PATH": {
      const dirs = value.split(":").filter((dir) => dir !== "");
      return `Jobs below look for commands in ${dirs.length} director${dirs.length === 1 ? "y" : "ies"}, in this order: ${dirs.join(", ")}. Without this line cron's PATH is minimal — often just /usr/bin:/bin — which is why a command that works in a terminal can fail under cron.`;
    }
    case "MAILTO":
      return value === ""
        ? "Output is thrown away instead of mailed. Error messages disappear with it, so redirect to a log file any job whose failures matter."
        : `Anything a job below prints is mailed to ${value}. That needs a working mail setup on the server; without one the output is lost.`;
    case "MAILFROM":
      return `Mail about the jobs below is sent from ${value}.`;
    case "CRON_TZ":
      return isKnownZone(value)
        ? `The schedules below are read in ${value} instead of the server's own zone. cronie honours this; not every cron does, so check man 5 crontab on the server.`
        : `“${value}” is not a time zone this browser knows, so the runs below are shown in the zone selected above.`;
    case "TZ":
      return `Jobs below see TZ=${value}, so the times they print are in that zone. Whether cron also schedules in it depends on the cron — cronie uses CRON_TZ for that.`;
    case "HOME":
      return `Jobs below run with HOME=${value}. Without it, HOME is the crontab owner's home directory.`;
    case "RANDOM_DELAY":
      return `cronie delays each job below by a random number of minutes, up to ${value}, to spread load.`;
    case "LOGNAME":
    case "USER":
      return `Sets ${name} for jobs below. cron sets it to the crontab's owner itself, and some crons ignore a change to it.`;
    case "CONTENT_TYPE":
    case "CONTENT_TRANSFER_ENCODING":
      return `Sets the ${name.toLowerCase().replaceAll("_", "-")} of the mail cron sends.`;
    default:
      return `Sets ${name} in the environment of every job below.`;
  }
}

/** `date +%u` numbers Monday 1 through Sunday 7, where cron has Sunday as 0. */
const isoWeekday = (dow: number): number => (dow === 0 ? 7 : dow);

/** Notes that do not stop a job from being read, but that someone should hear. */
function jobNotes(schedule: CronSchedule, command: string, next: string | null, user: string | null): string[] {
  const notes: string[] = [];

  if (schedule.kind === "reboot") {
    notes.push("@reboot runs once when the cron daemon starts — normally once per boot. It has no next run to show.");
  } else {
    if (schedule.macro !== null) notes.push(`${schedule.macro} is shorthand for ${schedule.expression}.`);
    notes.push(...scheduleNotes(schedule));
  }

  if (/(?<!\\)%/.test(command)) {
    notes.push(
      "The command contains %, which cron turns into a newline: everything after the first % is fed to the command as input instead. Write \\% where a literal % is meant — date +\\%F, not date +%F.",
    );
  }

  if (user === null && next !== null) {
    if (/^[\d*/,-]+$/.test(next)) {
      notes.push(
        `The command starts with “${next}”, which looks like a sixth time field. Crontab has five; Quartz and Spring put seconds first, and a system crontab puts a user name here.`,
      );
    } else if (next === "root") {
      notes.push(
        "“root” in front of the command is a user name, which belongs only in /etc/crontab and /etc/cron.d. In a user's own crontab, cron would try to run a program called root. Tick “Lines include a user” if this is a system crontab.",
      );
    }
  }
  if (user !== null && user.includes("/")) {
    notes.push(`“${user}” is in the user column. If this is a personal crontab, untick “Lines include a user” — only system crontabs have that column.`);
  }

  return notes;
}

const UNIT: Readonly<Record<FieldId, [string, string]>> = {
  minute: ["minute", "minutes"],
  hour: ["hour", "hours"],
  dom: ["day", "days"],
  month: ["month", "months"],
  dow: ["day", "days"],
};

const plural = (count: number, [one, many]: readonly [string, string]): string =>
  `${count} ${count === 1 ? one : many}`;

/** The notes that follow from the schedule alone. Exported for the builder, which has no command. */
export function scheduleNotes(schedule: CronTimes): string[] {
  const notes: string[] = [];
  const { dom, dow, month } = schedule.fields;

  for (const id of FIELD_IDS) {
    for (const part of schedule.fields[id].parts) {
      if (part.openEnded) {
        const spec = FIELDS[id];
        notes.push(
          `${part.text} is read as ${part.from}-${spec.max}/${part.step}. Not every cron accepts the short form; ${part.from}-${spec.max}/${part.step} means the same everywhere.`,
        );
      }
    }
  }

  // Rule 1: both day fields restricted, neither starting with *.
  if (schedule.dayRule === "or" && !dom.full && !dow.full) {
    const single = dow.values.length === 1 ? dow.values[0]! : null;
    const test =
      single === null
        ? "test the weekday in the command with date +\\%u"
        : `test it in the command: [ "$(date +\\%u)" = ${isoWeekday(single)} ] && your-command`;
    notes.push(
      `Day of month and day of week are both set, so cron runs on ${describeDom(dom, month, "en", true)} and also ${describeDowList(dow, "en")} — not only when both match. To require both, put * in the day-of-week field and ${test}.`,
    );
  }

  // Rule 2: a star-led field that is not actually every day.
  if (schedule.dayRule === "and" && !dom.full && !dow.full) {
    const starred = dom.star ? dom : dow;
    const spec = FIELDS[starred.id];
    const step = starred.parts[0]?.step ?? 1;
    const rewrite = `${spec.min}-${spec.last}${step > 1 ? `/${step}` : ""}`;
    notes.push(
      `The ${spec.label.toLowerCase()} field “${starred.text}” starts with *, so cron treats it like * when combining the two day fields: a day must match both. Written as ${rewrite} it would mean the same days, but cron would run when either field matched instead.`,
    );
  }

  // A step that does not divide the field restarts at the top of it, so the
  // last gap is short. */7 is not every seven minutes.
  for (const id of ["minute", "hour", "month", "dow"] as const) {
    const field = schedule.fields[id];
    const spec = FIELDS[id];
    if (field.parts.length !== 1) continue;
    const part = field.parts[0]!;
    if (part.step <= 1 || part.from !== spec.min || (part.kind !== "star" && part.to < spec.last)) continue;
    const span = spec.last - spec.min + 1;
    const lastValue = field.values[field.values.length - 1]!;
    const gap = span - (lastValue - spec.min);
    if (gap === part.step) continue;
    notes.push(
      `${field.text} restarts ${RESTART[id]}, so the gap from ${valueLabel(id, lastValue)} to ${valueLabel(id, spec.min)} is ${plural(gap, UNIT[id])}, not ${part.step}.`,
    );
  }
  if (dom.parts.length === 1 && dom.parts[0]!.kind === "star" && dom.parts[0]!.step > 1) {
    notes.push(
      `${dom.text} restarts on the 1st of every month, so the gap across a month's end is not ${dom.parts[0]!.step} days — it depends on how long the month is.`,
    );
  }

  // Days that some of the chosen months do not have are skipped, not moved.
  const domCounts = schedule.dayRule === "or" ? !dom.full && !dow.full : !dom.full;
  if (domCounts) {
    const lacking: string[] = [];
    for (const day of dom.values.filter((d) => d >= 29)) {
      const months = month.values.filter((m) => day > (m === 2 ? 29 : daysInMonth(2001, m)));
      const leapOnly = day === 29 && month.values.includes(2);
      if (months.length > 0) lacking.push(`the ${ordinal(day)} in ${joinAnd(months.map((m) => EN_MONTHS[m - 1]!), "en")}`);
      else if (leapOnly) lacking.push("the 29th of February outside leap years");
    }
    if (lacking.length > 0) {
      const lastDayTip = dom.values.every((d) => d >= 28)
        ? ` For the last day of every month, run on 28-31 and test for it in the command: [ "$(date -d tomorrow +\\%d)" = 01 ] && your-command.`
        : "";
      notes.push(`A day a month does not have is skipped, not moved: there is no run on ${joinAnd(lacking, "en")}.${lastDayTip}`);
    }
  }

  return notes;
}

const RESTART: Readonly<Record<"minute" | "hour" | "month" | "dow", string>> = {
  minute: "at :00 every hour",
  hour: "at midnight",
  month: "in January",
  dow: "on Sunday",
};

function valueLabel(id: FieldId, value: number): string {
  if (id === "minute") return `:${two(value)}`;
  if (id === "hour") return `${two(value)}:00`;
  if (id === "month") return EN_MONTHS[value - 1]!;
  if (id === "dow") return EN_DAYS[value]!;
  return String(value);
}

function readJob(source: string, line: number, options: CrontabOptions, zone: CronZone | null): CronJob {
  const tokens = [...source.matchAll(/\S+/g)];
  const first = tokens[0]![0];

  if (!/^[\d*@]/.test(first)) {
    throw new CronError(
      "This line is neither a job nor a NAME=value setting. A job starts with five time fields, or with a shorthand such as @daily.",
    );
  }

  let schedule: CronSchedule;
  let used: number;
  if (first.startsWith("@")) {
    schedule = readMacro(first);
    used = 1;
  } else {
    if (tokens.length < 5) {
      throw new CronError(
        `Only ${tokens.length} field${tokens.length === 1 ? "" : "s"} — a job needs five time fields, then the command.`,
      );
    }
    schedule = fromFields(
      tokens.slice(0, 5).map((match) => match[0]),
      null,
    );
    used = 5;
  }

  // Quartz writes seconds first and `?` in one day field; the sixth token is
  // then where that shows up. Refused by name rather than read as a command.
  const sixth = tokens[used]?.[0] ?? null;
  if (sixth !== null && /^[\d*/,?LW#-]+$/i.test(sixth) && sixth.includes("?")) {
    throw new CronError(
      "This is a Quartz or Spring expression: it has seconds first and a “?”. For crontab, drop the seconds field and write * for ?. Quartz also numbers days of the week 1–7 from Sunday, where cron uses 0–6.",
    );
  }

  let user: string | null = null;
  if (options.userField) {
    if (sixth === null) {
      throw new CronError("No user name. In /etc/crontab and /etc/cron.d, a user comes between the schedule and the command.");
    }
    user = sixth;
    used += 1;
  }

  const lastUsed = tokens[used - 1]!;
  const command = source.slice(lastUsed.index! + lastUsed[0].length).trim();
  return {
    kind: "job",
    line,
    source,
    schedule,
    user,
    command,
    zone,
    notes: jobNotes(schedule, command, user === null ? sixth : null, user),
  };
}

/**
 * Reads a crontab — `crontab -l` output, /etc/crontab, or a single line.
 * Comments and blank lines are skipped. A line that cannot be read becomes an
 * error entry carrying its line number, so one typo does not hide the rest.
 */
export function parseCrontab(text: string, options: CrontabOptions): CrontabEntry[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > CRONTAB_LINE_LIMIT) {
    throw new CronError(
      `That is ${lines.length.toLocaleString("en-US")} lines; the explainer reads up to ${CRONTAB_LINE_LIMIT.toLocaleString("en-US")} at once.`,
    );
  }

  const entries: CrontabEntry[] = [];
  let zone: CronZone | null = null;

  lines.forEach((raw, index) => {
    const line = index + 1;
    const source = raw.trim();
    if (source === "" || source.startsWith("#")) return;

    const env = ENV_LINE.exec(source);
    if (env) {
      const name = env[1]!;
      const value = unquote(env[2]!.trim());
      if (name === "CRON_TZ") zone = isKnownZone(value) ? { name: value, line } : null;
      entries.push({ kind: "env", line, source, name, value, explanation: explainEnv(name, value) });
      return;
    }

    try {
      entries.push(readJob(source, line, options, zone));
    } catch (error) {
      if (!(error instanceof CronError)) throw error;
      entries.push({ kind: "error", line, source, message: error.message });
    }
  });

  return entries;
}

/* ----------------------------------------------------------------- next runs */

/**
 * - `normal`: the wall time happened once, and the job ran at it.
 * - `gap`: the wall time was skipped by a clock change; a fixed-time job runs
 *   at the moment of the jump instead.
 * - `overlap-once`: the wall time happened twice; a fixed-time job runs the
 *   first time only.
 * - `overlap-first` / `overlap-second`: the same, for a wildcard job, which
 *   runs both times.
 */
export type RunKind = "normal" | "gap" | "overlap-once" | "overlap-first" | "overlap-second";

export interface CronRun {
  readonly ms: number;
  /** The wall time cron matched. It differs from the run's own time only in a gap. */
  readonly wall: WallTime;
  readonly kind: RunKind;
}

export interface SkippedRun {
  /** The wall time that never happened. */
  readonly wall: WallTime;
  /** When the clocks jumped over it. */
  readonly ms: number;
}

export interface RunSearch {
  readonly runs: readonly CronRun[];
  /** Wall times a wildcard job loses to a clock change, between now and the last run shown. */
  readonly skipped: readonly SkippedRun[];
  /** Nothing matches in a whole 400-year Gregorian cycle, so nothing ever will. */
  readonly never: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The Gregorian calendar repeats every 400 years: 146,097 days, a whole number of weeks. */
export const GREGORIAN_CYCLE_DAYS = 146_097;

/** Remainder that is always in `[0, m)`. */
const mod = (n: number, m: number): number => ((n % m) + m) % m;

function dayMatches(schedule: CronTimes, days: number, day: number): boolean {
  const { dom, dow } = schedule.fields;
  // 1970-01-01 was a Thursday: cron's 4.
  const weekday = mod(days + 4, 7);
  const domOk = dom.values.includes(day);
  const dowOk = dow.values.includes(weekday);
  return schedule.dayRule === "and" ? domOk && dowOk : domOk || dowOk;
}

/** The first instant at or after `from` with `offset` in force, to the second. */
function transitionInstant(from: number, to: number, offset: number, zone: string): number {
  let lo = Math.floor(from / 1000);
  let hi = Math.ceil(to / 1000);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(mid * 1000, zone) === offset) hi = mid;
    else lo = mid + 1;
  }
  return lo * 1000;
}

/**
 * The next `count` runs strictly after `fromMs`, in `zone`.
 *
 * Days are walked one at a time and matched arithmetically, with no `Date`
 * and no `Intl`; only a matching day asks the zone database anything. Asking
 * three times — a day before, midday, two days after — tells a day with a
 * clock change from one without, and only the former converts each run
 * separately. The walk stops after one full Gregorian cycle, which is what
 * makes "never" a proof rather than a timeout.
 */
export function nextRuns(schedule: CronSchedule, zone: string, fromMs: number, count: number): RunSearch {
  if (schedule.kind === "reboot" || count <= 0) return { runs: [], skipped: [], never: false };

  const { minute, hour, month } = schedule.fields;
  const start = wallTimeAt(fromMs, zone);
  const first = daysFromCivil(start.year, start.month, start.day) - 1;
  const limit = first + GREGORIAN_CYCLE_DAYS + 2;

  const runs: CronRun[] = [];
  const skipped: SkippedRun[] = [];
  let matchedAnyDay = false;

  for (let days = first; days <= limit && runs.length < count; days += 1) {
    const civil = civilFromDays(days);
    if (!month.values.includes(civil.month)) {
      // Jump to the last day of this month; the loop steps onto the 1st of the next.
      days += daysInMonth(civil.year, civil.month) - civil.day;
      continue;
    }
    if (!dayMatches(schedule, days, civil.day)) continue;
    matchedAnyDay = true;

    const base = days * DAY_MS;
    const before = zoneOffsetMs(base - DAY_MS, zone);
    const steady = before === zoneOffsetMs(base + DAY_MS / 2, zone) && before === zoneOffsetMs(base + 2 * DAY_MS, zone);

    const today: CronRun[] = [];
    for (const h of hour.values) {
      for (const m of minute.values) {
        const wall: WallTime = { ...civil, hour: h, minute: m, second: 0 };
        const naive = base + h * HOUR_MS + m * MINUTE_MS;

        if (steady) {
          const ms = naive - before;
          if (ms > fromMs) today.push({ ms, wall, kind: "normal" });
          if (today.length + runs.length >= count) break;
          continue;
        }

        const resolved = wallTimeToMs(wall, zone);
        if (resolved.resolution === "exact") {
          today.push({ ms: resolved.ms, wall, kind: "normal" });
        } else if (resolved.resolution === "overlap") {
          if (schedule.wildcard) {
            today.push({ ms: resolved.ms, wall, kind: "overlap-first" });
            today.push({ ms: resolved.later!, wall, kind: "overlap-second" });
          } else {
            today.push({ ms: resolved.ms, wall, kind: "overlap-once" });
          }
        } else {
          const after = zoneOffsetMs(naive + DAY_MS, zone);
          const earlier = zoneOffsetMs(naive - DAY_MS, zone);
          const jump = transitionInstant(naive - after, naive - earlier, after, zone);
          if (schedule.wildcard) skipped.push({ wall, ms: jump });
          else today.push({ ms: jump, wall, kind: "gap" });
        }
      }
      if (steady && today.length + runs.length >= count) break;
    }

    today.sort((a, b) => a.ms - b.ms);
    for (const run of today) {
      if (run.ms <= fromMs) continue;
      runs.push(run);
      if (runs.length === count) break;
    }
  }

  const lastMs = runs.length > 0 ? runs[runs.length - 1]!.ms : Number.POSITIVE_INFINITY;
  return {
    runs,
    skipped: skipped.filter((skip) => skip.ms > fromMs && skip.ms <= lastMs),
    never: !matchedAnyDay,
  };
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `Mon 2026-09-28 08:30 +07:00` — the weekday first, because cron schedules are read by it. */
export function formatRun(ms: number, zone: string): { when: string; offset: string } {
  const p = zonedParts(ms, zone);
  const weekday = SHORT_DAYS[mod(daysFromCivil(p.year, p.month, p.day) + 4, 7)]!;
  return {
    when: `${weekday} ${String(p.year).padStart(4, "0")}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`,
    offset: p.offset,
  };
}

/* --------------------------------------------------------------- describing */

const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const VI_DAYS = ["Chủ nhật", "thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy"] as const;
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function two(n: number): string {
  return String(n).padStart(2, "0");
}

const clock = (h: number, m: number): string => `${two(h)}:${two(m)}`;

function joinWith(items: readonly string[], word: string): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

function joinAnd(items: readonly string[], lang: CronLang): string {
  return joinWith(items, lang === "vi" ? "và" : "and");
}

function joinOr(items: readonly string[], lang: CronLang): string {
  return joinWith(items, lang === "vi" ? "hoặc" : "or");
}

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

type Run = readonly [number, number];

/** Consecutive stretches of an ascending list: [1,2,3,5] becomes [1,3] and [5,5]. */
function runsOf(values: readonly number[]): Run[] {
  const runs: [number, number][] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && value === last[1] + 1) last[1] = value;
    else runs.push([value, value]);
  }
  return runs;
}

/** Stretches of three or more stay ranges; shorter ones are listed one by one. */
function listItems(values: readonly number[], range: (a: number, b: number) => string, single: (v: number) => string): string[] {
  const items: string[] = [];
  for (const [a, b] of runsOf(values)) {
    if (b - a >= 2) items.push(range(a, b));
    else for (let v = a; v <= b; v += 1) items.push(single(v));
  }
  return items;
}

/** A long list keeps its first few and its last, and says how many there are. */
function abbreviate(items: readonly string[], lang: CronLang, join: (items: readonly string[]) => string): string {
  if (items.length <= 8) return join(items);
  return `${items.slice(0, 4).join(", ")}, …, ${items[items.length - 1]} (${items.length} ${lang === "vi" ? "giá trị" : "values"})`;
}

/** Day-of-week values in the order people read a week: Monday first. */
function weekOrder(values: readonly number[]): number[] {
  return values.map((v) => (v === 0 ? 7 : v)).sort((a, b) => a - b);
}

const dayName = (key: number, lang: CronLang): string => (lang === "vi" ? VI_DAYS : EN_DAYS)[key % 7]!;
const monthName = (m: number, lang: CronLang): string => (lang === "vi" ? `tháng ${m}` : EN_MONTHS[m - 1]!);

function dowItems(field: CronField, lang: CronLang): { items: string[]; single: boolean; oneRange: boolean } {
  const keys = weekOrder(field.values);
  const through = lang === "vi" ? "đến" : "through";
  const items = listItems(
    keys,
    (a, b) => (lang === "vi" ? `từ ${dayName(a, lang)} ${through} ${dayName(b, lang)}` : `${dayName(a, lang)} ${through} ${dayName(b, lang)}`),
    (v) => dayName(v, lang),
  );
  const runs = runsOf(keys);
  return { items, single: keys.length === 1, oneRange: runs.length === 1 && keys.length >= 3 };
}

/** "every Monday", "Monday through Friday", "on Monday, Wednesday and Friday". */
function describeDowList(field: CronField, lang: CronLang): string {
  const { items, single, oneRange } = dowItems(field, lang);
  if (lang === "vi") {
    if (single) return `mọi ${items[0]}`;
    if (oneRange) return `mọi ngày ${items[0]}`;
    return `mọi ${joinAnd(items, lang)}`;
  }
  if (single) return `every ${items[0]}`;
  if (oneRange) return `every day from ${items[0]}`;
  return `every ${joinAnd(items, lang)}`;
}

function dowPhrase(field: CronField, lang: CronLang): { lead: string; text: string } {
  const { items, single, oneRange } = dowItems(field, lang);
  if (lang === "vi") {
    if (single) return { lead: " ", text: `vào mỗi ${items[0]}` };
    if (oneRange) return { lead: ", ", text: items[0]! };
    return { lead: " ", text: `vào ${joinAnd(items, lang)}` };
  }
  if (single) return { lead: " ", text: `every ${items[0]}` };
  if (oneRange) return { lead: ", ", text: items[0]! };
  return { lead: " ", text: `on ${joinAnd(items, lang)}` };
}

function dowCondition(field: CronField, lang: CronLang): string {
  const { items, single, oneRange } = dowItems(field, lang);
  if (lang === "vi") {
    if (oneRange) return `một ngày ${items[0]}`;
    return joinOr(items, lang);
  }
  if (single) return `a ${items[0]}`;
  if (oneRange) return `a day from ${items[0]}`;
  return `a ${joinOr(items, lang)}`;
}

/** Months as a list: "January and July", "March through October". */
function monthItems(field: CronField, lang: CronLang): { items: string[]; oneRange: boolean } {
  const items = listItems(
    field.values,
    (a, b) => (lang === "vi" ? `${a} đến ${b}` : `${EN_MONTHS[a - 1]} through ${EN_MONTHS[b - 1]}`),
    (v) => (lang === "vi" ? String(v) : EN_MONTHS[v - 1]!),
  );
  const runs = runsOf(field.values);
  return { items, oneRange: runs.length === 1 && field.values.length >= 3 };
}

/** " in January", " from March through October" — or nothing, for every month. */
function monthSuffix(field: CronField, lang: CronLang): string {
  if (field.full) return "";
  const { items, oneRange } = monthItems(field, lang);
  if (lang === "vi") {
    if (field.values.length === 1) return ` trong tháng ${items[0]}`;
    if (oneRange) return ` từ tháng ${field.values[0]} đến tháng ${field.values[field.values.length - 1]}`;
    return ` trong các tháng ${joinAnd(items, lang)}`;
  }
  if (oneRange) return ` from ${items[0]}`;
  return ` in ${joinAnd(items, lang)}`;
}

/** The day-of-month phrase with its month attached: "on the 1st of every month". */
function describeDom(dom: CronField, month: CronField, lang: CronLang, bare = false): string {
  const part = dom.parts.length === 1 ? dom.parts[0]! : null;
  const stepped = part !== null && part.step > 1;
  const first = dom.values[0]!;
  const last = dom.values[dom.values.length - 1]!;

  let core: string;
  if (lang === "vi") {
    if (stepped && part.kind === "star") core = `cứ ${part.step} ngày một lần tính từ ngày 1`;
    else if (stepped) core = `cứ ${part.step} ngày một lần, từ ngày ${first} đến ngày ${last}`;
    else if (dom.values.length === 1) core = `vào ngày ${first}`;
    else {
      const items = listItems(dom.values, (a, b) => `từ ${a} đến ${b}`, String);
      core = `vào các ngày ${abbreviate(items, lang, (list) => joinAnd(list, lang))}`;
    }
  } else if (stepped && part.kind === "star") {
    core = `on every ${ordinal(part.step)} day`;
  } else if (stepped) {
    core = `on every ${ordinal(part.step)} day from the ${ordinal(first)} to the ${ordinal(last)}`;
  } else {
    const items = listItems(dom.values, (a, b) => `${ordinal(a)} through ${ordinal(b)}`, ordinal);
    core = `on the ${abbreviate(items, lang, (list) => joinAnd(list, lang))}`;
  }
  if (bare) return lang === "vi" ? core : core.replace(/^on /, "");

  if (lang === "vi") {
    if (month.full) return `${core} hằng tháng`;
    if (month.values.length === 1 && !stepped) return `${core} tháng ${month.values[0]}`;
    return `${core}${monthSuffix(month, lang)}`;
  }
  if (month.full) return `${core} of every month`;
  const { items, oneRange } = monthItems(month, lang);
  if (oneRange) return `${core} of each month from ${items[0]}`;
  return `${core} of ${joinAnd(items, lang)}`;
}

/** Hour and minute, as the opening of the sentence. `times` means it names clock times. */
function describeTime(minute: CronField, hour: CronField, lang: CronLang): { text: string; times: boolean } {
  const vi = lang === "vi";
  const fixed = (field: CronField) => field.parts.every((part) => part.kind === "value");

  if (minute.full && hour.full) return { text: vi ? "Mỗi phút" : "Every minute", times: false };

  if (fixed(minute) && fixed(hour) && minute.values.length * hour.values.length <= 6) {
    const times = hour.values.flatMap((h) => minute.values.map((m) => clock(h, m)));
    return { text: `${vi ? "Lúc" : "At"} ${joinAnd(times, lang)}`, times: true };
  }

  const hourPart = hour.parts.length === 1 ? hour.parts[0]! : null;
  const hFirst = hour.values[0]!;
  const hLast = hour.values[hour.values.length - 1]!;
  const hourList = () =>
    abbreviate(
      listItems(hour.values, (a, b) => `${a}–${b}`, String),
      lang,
      (items) => joinAnd(items, lang),
    );

  // A few fixed minutes: read as marks on a clock face, ":15 and :45".
  if (fixed(minute) && minute.values.length <= 4) {
    const marks = joinAnd(minute.values.map((m) => (vi ? two(m) : `:${two(m)}`)), lang);
    const onTheHour = minute.values.length === 1 && minute.values[0] === 0;
    const mFirst = minute.values[0]!;
    const mLast = minute.values[minute.values.length - 1]!;
    const span = vi
      ? `từ ${clock(hFirst, mFirst)} đến ${clock(hLast, mLast)}`
      : `from ${clock(hFirst, mFirst)} to ${clock(hLast, mLast)}`;

    if (hour.full) {
      if (vi) return { text: `Mỗi giờ${minute.values.length === 1 ? " một lần" : ""}, vào phút ${marks}`, times: false };
      return { text: onTheHour ? "Every hour, on the hour" : `Every hour at ${marks}`, times: false };
    }
    if (hourPart !== null && hourPart.step > 1) {
      const n = hourPart.step;
      if (vi) return { text: `Cứ ${n} giờ một lần vào phút ${marks}, ${span}`, times: false };
      return { text: `Every ${n} hours${onTheHour ? ", on the hour," : ` at ${marks},`} ${span}`, times: false };
    }
    if (hourPart !== null && hourPart.kind === "range") {
      if (vi) return { text: `Mỗi giờ vào phút ${marks}, ${span}`, times: false };
      return { text: onTheHour ? `Every hour ${span}` : `Every hour at ${marks}, ${span}`, times: false };
    }
    if (vi) return { text: `Vào phút ${marks} của các giờ ${hourList()}`, times: false };
    return { text: `At ${marks} past hours ${hourList()}`, times: false };
  }

  // Everything else: a minute clause, then which hours it applies in.
  const minutePart = minute.parts.length === 1 ? minute.parts[0]! : null;
  const mFirst = minute.values[0]!;
  const mLast = minute.values[minute.values.length - 1]!;
  let text: string;
  if (minute.full) {
    text = vi ? "Mỗi phút" : "Every minute";
  } else if (minutePart !== null && minutePart.kind === "star") {
    text = vi ? `Cứ ${minutePart.step} phút một lần` : `Every ${minutePart.step} minutes`;
  } else if (minutePart !== null && minutePart.kind === "range" && minutePart.step === 1) {
    text = vi ? `Mỗi phút từ phút ${mFirst} đến phút ${mLast}` : `Every minute from :${two(mFirst)} to :${two(mLast)}`;
  } else if (minutePart !== null && minutePart.kind === "range") {
    text = vi
      ? `Cứ ${minutePart.step} phút một lần, từ phút ${mFirst} đến phút ${mLast}`
      : `Every ${minutePart.step} minutes from :${two(mFirst)} to :${two(mLast)}`;
  } else {
    const items = listItems(minute.values, (a, b) => `${a}–${b}`, String);
    text = `${vi ? "Vào các phút" : "At minutes"} ${abbreviate(items, lang, (list) => joinAnd(list, lang))}`;
  }

  if (hour.full) return { text, times: false };

  let hours: string;
  if (hourPart !== null && hourPart.step > 1) {
    hours = vi
      ? `cứ ${hourPart.step} giờ một lần, từ ${clock(hFirst, 0)} đến ${clock(hLast, 59)}`
      : `every ${ordinal(hourPart.step)} hour from ${clock(hFirst, 0)} to ${clock(hLast, 59)}`;
  } else if (hourPart !== null) {
    hours = vi
      ? `từ ${clock(hFirst, 0)} đến ${clock(hLast, 59)}`
      : `between ${clock(hFirst, 0)} and ${clock(hLast, 59)}`;
  } else {
    hours = `${vi ? "trong các giờ" : "during hours"} ${hourList()}`;
  }
  return { text: `${text}, ${hours}`, times: false };
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One sentence saying when a schedule runs.
 *
 * It is built from the fields' structure as written, not only from the values
 * they expand to, so `*∕15` reads as "every 15 minutes" rather than as a list
 * of four minutes — and so that the day-field rules above are honoured
 * exactly as cron applies them.
 */
export function describeSchedule(schedule: CronSchedule, lang: CronLang): string {
  if (schedule.kind === "reboot") {
    return lang === "vi"
      ? "Một lần, khi dịch vụ cron khởi động — thường là mỗi lần bật máy."
      : "Once, when the cron daemon starts — normally once per boot.";
  }

  const { minute, hour, dom, month, dow } = schedule.fields;
  const time = describeTime(minute, hour, lang);
  const vi = lang === "vi";

  // What the two day fields amount to, after rules 1 and 2.
  let days: "every" | "dom" | "dow" | "or" | "and";
  if (schedule.dayRule === "or") days = dom.full || dow.full ? "every" : "or";
  else if (dom.full) days = dow.full ? "every" : "dow";
  else days = dow.full ? "dom" : "and";

  let sentence = time.text;
  switch (days) {
    case "every":
      if (time.times) sentence += vi ? " hằng ngày" : " every day";
      sentence += monthSuffix(month, lang);
      break;
    case "dow": {
      const phrase = dowPhrase(dow, lang);
      sentence += `${phrase.lead}${phrase.text}${monthSuffix(month, lang)}`;
      break;
    }
    case "dom":
      sentence += ` ${describeDom(dom, month, lang)}`;
      break;
    case "or":
      sentence += ` ${describeDom(dom, month, lang)}`;
      sentence += vi ? `, và cả ${describeDowList(dow, lang)}` : `, and also ${describeDowList(dow, lang)}`;
      sentence += monthSuffix(month, lang);
      break;
    case "and":
      sentence += ` ${describeDom(dom, month, lang)}`;
      sentence += vi
        ? `, nhưng chỉ khi ngày đó là ${dowCondition(dow, lang)}`
        : `, but only if that day is ${dowCondition(dow, lang)}`;
      break;
  }
  return `${capitalise(sentence)}.`;
}

const EVERY_VALUE: Readonly<Record<FieldId, [string, string]>> = {
  minute: ["every minute", "mọi phút"],
  hour: ["every hour", "mọi giờ"],
  dom: ["every day", "mọi ngày"],
  month: ["every month", "mọi tháng"],
  dow: ["every day of the week", "mọi ngày trong tuần"],
};

/** What one field matches, for the breakdown table: "Monday–Friday", "0, 15, 30 and 45". */
export function describeFieldValues(field: CronField, lang: CronLang): string {
  if (field.full) return EVERY_VALUE[field.id][lang === "vi" ? 1 : 0];
  const join = (items: readonly string[]) => joinAnd(items, lang);

  if (field.id === "dow") {
    const items = listItems(weekOrder(field.values), (a, b) => `${dayName(a, lang)}–${dayName(b, lang)}`, (v) => dayName(v, lang));
    return join(items);
  }
  if (field.id === "month") {
    const items = listItems(
      field.values,
      (a, b) => (lang === "vi" ? `tháng ${a}–${b}` : `${monthName(a, lang)}–${monthName(b, lang)}`),
      (v) => monthName(v, lang),
    );
    return join(items);
  }
  const items = listItems(field.values, (a, b) => `${a}–${b}`, String);
  return abbreviate(items, lang, join);
}

/* ------------------------------------------------------------------ builder */

/**
 * How the builder describes one field:
 * - `every`: `*`
 * - `step`: every N, from a start value — `*∕N`, or `S-max∕N`
 * - `specific`: a set of values, compressed into ranges where they run on
 * - `range`: from–to, optionally every N within it
 */
export type BuilderMode = "every" | "step" | "specific" | "range";

export interface FieldChoice {
  readonly mode: BuilderMode;
  readonly step: number;
  readonly start: number;
  readonly values: readonly number[];
  readonly from: number;
  readonly to: number;
}

/**
 * The modes the builder offers per field. Day of week has no step mode: the
 * seven days are few enough to tick, and "every second weekday" restarts on
 * Sunday in a way nobody means (see the step notes above).
 */
export const BUILDER_MODES: Readonly<Record<FieldId, readonly BuilderMode[]>> = {
  minute: ["every", "step", "specific", "range"],
  hour: ["every", "step", "specific", "range"],
  dom: ["every", "step", "specific", "range"],
  month: ["every", "step", "specific", "range"],
  dow: ["every", "specific", "range"],
};

/** The builder's own upper bound: day of week stops at 6, since 7 is a second Sunday. */
export function builderMax(id: FieldId): number {
  return FIELDS[id].last;
}

export function everyChoice(id: FieldId): FieldChoice {
  const spec = FIELDS[id];
  return { mode: "every", step: 1, start: spec.min, values: [], from: spec.min, to: builderMax(id) };
}

function inField(id: FieldId, value: number, what: string): number {
  const spec = FIELDS[id];
  if (!Number.isInteger(value) || value < spec.min || value > builderMax(id)) {
    throw new CronError(`${spec.label}: the ${what} must be between ${spec.min} and ${builderMax(id)}.`);
  }
  return value;
}

/** Writes one field. With `names`, months and weekdays are written jan and mon. */
export function buildField(id: FieldId, choice: FieldChoice, names: boolean): string {
  const spec = FIELDS[id];
  const max = builderMax(id);
  const label = (value: number): string => {
    if (!names || !spec.names) return String(value);
    return spec.names[id === "month" ? value - 1 : value]!;
  };
  const stepOf = (value: number): number => {
    if (!Number.isInteger(value) || value < 1 || value > max - spec.min + 1) {
      throw new CronError(`${spec.label}: the step must be between 1 and ${max - spec.min + 1}.`);
    }
    return value;
  };

  switch (choice.mode) {
    case "every":
      return "*";
    case "step": {
      const step = stepOf(choice.step);
      const start = inField(id, choice.start, "starting value");
      if (start === spec.min) return step === 1 ? "*" : `*/${step}`;
      if (start === max) return label(start);
      return step === 1 ? `${label(start)}-${label(max)}` : `${start}-${max}/${step}`;
    }
    case "specific": {
      const values = [...new Set(choice.values.map((v) => inField(id, v, "values")))].sort((a, b) => a - b);
      if (values.length === 0) throw new CronError(`${spec.label}: pick at least one value.`);
      const items: string[] = [];
      for (const [a, b] of runsOf(values)) {
        if (b - a >= 2) items.push(`${label(a)}-${label(b)}`);
        else for (let v = a; v <= b; v += 1) items.push(label(v));
      }
      return items.join(",");
    }
    case "range": {
      const from = inField(id, choice.from, "start of the range");
      const to = inField(id, choice.to, "end of the range");
      const step = stepOf(choice.step);
      if (from > to) throw new CronError(`${spec.label}: the range runs backwards — its start is after its end.`);
      if (step > 1) return `${from}-${to}/${step}`;
      return from === to ? label(from) : `${label(from)}-${label(to)}`;
    }
  }
}

export function buildExpression(choices: Readonly<Record<FieldId, FieldChoice>>, names: boolean): string {
  return FIELD_IDS.map((id) => buildField(id, choices[id], names)).join(" ");
}

/**
 * The builder settings that write a field back out. `exact` is false only
 * when the rewrite would lose the field's leading `*` — which matters, since
 * that character is what rules 2 and 3 read.
 */
export function choiceFromField(field: CronField): { choice: FieldChoice; exact: boolean } {
  const spec = FIELDS[field.id];
  const max = builderMax(field.id);
  const base = everyChoice(field.id);

  if (field.parts.length === 1) {
    const part = field.parts[0]!;
    const stepped = BUILDER_MODES[field.id].includes("step");
    if (part.kind === "star" && part.step === 1) return { choice: base, exact: true };
    if (part.kind === "star" && stepped) {
      return { choice: { ...base, mode: "step", step: part.step, start: spec.min }, exact: true };
    }
    if (part.kind === "range" && part.to <= max) {
      // `5/15` and `5-59/15` are both "every 15 from 5". Starting at the
      // minimum stays a range: turning `0-59/5` into `*/5` would add a star.
      if (stepped && part.step > 1 && part.to === max && part.from > spec.min) {
        return { choice: { ...base, mode: "step", step: part.step, start: part.from }, exact: true };
      }
      return { choice: { ...base, mode: "range", from: part.from, to: part.to, step: part.step }, exact: true };
    }
  }

  return { choice: { ...base, mode: "specific", values: field.values }, exact: !field.star };
}
