/**
 * systemd unit files — .service, .timer and the rest — read line by line as
 * systemd 259 reads them, with every mistake it would make of them named.
 *
 * Three layers, each a port of systemd's own code:
 *
 * 1. **The file format** (src/shared/conf-parser.c): comments are whole lines
 *    starting with # or ;, a backslash at the very end of a line continues it,
 *    section and key names are case-sensitive, and an unknown section or key is
 *    ignored with a warning — so a typo does not break a unit, it silently
 *    removes a setting from it.
 * 2. **Each value**, by the parser systemd uses for that key (load-fragment.c;
 *    the table in unitdirectives.ts is generated from systemd's own). Most bad
 *    values are ignored with a warning; a few, such as a relative ExecStart=
 *    path, stop systemd reading the file, and the unit fails to load.
 * 3. **The unit as a whole** (service_verify(), timer_verify()): rules that
 *    only show once every line and drop-in has been read, such as a second
 *    ExecStart= on a service that is not Type=oneshot.
 *
 * On top of those, advice: things systemd accepts without a word that rarely
 * do what was meant, such as `date +%Y` in a command line, where systemd
 * replaces %Y with a directory before date ever sees it.
 *
 * Every finding says who says so — systemd, about a line or about the unit,
 * or this page — and carries an English and a Vietnamese sentence.
 */

import type { Both } from "../data/i18n";
import { SECTION_DIRECTIVES, SECTION_SHARES, SHARED_DIRECTIVES, SYSTEMD_VERSION } from "./unitdirectives";
import { ASSERT_DOC, CONDITION_DOC, DIRECTIVE_DOCS } from "./unitdocs";
import { CalendarError, boundedForm, describeCalendar, parseCalendar } from "./oncalendar";
import { formatTimespan, parseTimespan } from "./timespan";

export { SYSTEMD_VERSION };

/* ------------------------------------------------------------- the table */

export const UNIT_TYPES = ["service", "socket", "target", "device", "mount", "automount", "swap", "timer", "path", "slice", "scope"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** The section of its own each unit type reads, besides [Unit] and [Install]. */
const TYPE_SECTION: Readonly<Record<UnitType, string | null>> = {
  service: "Service",
  socket: "Socket",
  target: null,
  device: null,
  mount: "Mount",
  automount: "Automount",
  swap: "Swap",
  timer: "Timer",
  path: "Path",
  slice: "Slice",
  scope: "Scope",
};

const SECTION_TYPE: ReadonlyMap<string, UnitType> = new Map(
  UNIT_TYPES.filter((type) => TYPE_SECTION[type] !== null).map((type) => [TYPE_SECTION[type]!, type]),
);

export interface DirectiveInfo {
  readonly name: string;
  /** The section it belongs to. */
  readonly section: string;
  /** How systemd reads the value; see unitdirectives.ts. */
  readonly kind: string;
  /** The shared set it comes from — exec, kill or cgroup — or null. */
  readonly share: string | null;
}

const BY_SECTION = new Map<string, Map<string, DirectiveInfo>>();
const BY_LOWER = new Map<string, DirectiveInfo[]>();
for (const [section, list] of Object.entries(SECTION_DIRECTIVES)) {
  const table = new Map<string, DirectiveInfo>();
  const add = (pairs: string, share: string | null) => {
    for (const pair of pairs.trim().split(/\s+/)) {
      const colon = pair.lastIndexOf(":");
      const info: DirectiveInfo = { name: pair.slice(0, colon), section, kind: pair.slice(colon + 1), share };
      if (table.has(info.name)) continue;
      table.set(info.name, info);
      const lower = info.name.toLowerCase();
      BY_LOWER.set(lower, [...(BY_LOWER.get(lower) ?? []), info]);
    }
  };
  add(list, null);
  for (const share of SECTION_SHARES[section] ?? []) add(SHARED_DIRECTIVES[share] ?? "", share);
  BY_SECTION.set(section, table);
}

export function directiveIn(section: string, name: string): DirectiveInfo | null {
  return BY_SECTION.get(section)?.get(name) ?? null;
}

/** Every directive of a section, for the checks that walk them all. */
export function directivesOf(section: string): readonly DirectiveInfo[] {
  return [...(BY_SECTION.get(section)?.values() ?? [])];
}

const MAN_PAGE: Readonly<Record<string, string>> = {
  Unit: "systemd.unit",
  Install: "systemd.unit",
  Service: "systemd.service",
  Socket: "systemd.socket",
  Mount: "systemd.mount",
  Automount: "systemd.automount",
  Swap: "systemd.swap",
  Timer: "systemd.timer",
  Path: "systemd.path",
  Slice: "systemd.slice",
  Scope: "systemd.scope",
  exec: "systemd.exec",
  kill: "systemd.kill",
  cgroup: "systemd.resource-control",
};

/** The directive's entry in systemd's manual. A plain link: following it sends nothing typed here. */
export function manualUrl(info: DirectiveInfo): string {
  const page = MAN_PAGE[info.share ?? info.section] ?? "systemd.directives";
  return `https://www.freedesktop.org/software/systemd/man/latest/${page}.html#${info.name}=`;
}

/** What a setting does, in both languages, where the page has a sentence for it. */
export function directiveDoc(info: DirectiveInfo): Both | null {
  const doc = DIRECTIVE_DOCS[info.name];
  if (doc) return doc;
  if (info.name.startsWith("Condition")) return CONDITION_DOC;
  if (info.name.startsWith("Assert")) return ASSERT_DOC;
  return null;
}

/* ---------------------------------------------------------------- findings */

export type Severity = "error" | "warning" | "note";

/**
 * Who says so. `line`: systemd logs it when it reads that line. `unit`:
 * systemd logs it about the unit once its files are read. `advice`: systemd
 * says nothing; this page does.
 */
export type FindingSource = "line" | "unit" | "advice";

/** How loud systemd's own message is: error and warning show with SYSTEMD_LOG_LEVEL=warning, notice and info do not. */
export type LogLevel = "error" | "warning" | "notice" | "info";

export interface Finding {
  readonly severity: Severity;
  readonly source: FindingSource;
  /** systemd's log level for its own message; null for advice. */
  readonly level: LogLevel | null;
  /** The line in the pasted text, from 1, where it starts; null for the unit as a whole. */
  readonly line: number | null;
  /**
   * The line number systemd's message carries: the last line of a continued
   * line, or one past the end for a continuation the file never finished.
   * Null unless the source is `line`.
   */
  readonly systemdLine: number | null;
  readonly text: Both;
  /** A corrected line to offer, where there is one. */
  readonly fix?: string;
}

const both = (en: string, vi: string): Both => ({ en, vi });

/* --------------------------------------------- systemd's helpers, ported */

const WHITESPACE = " \t\n\r";
const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && WHITESPACE.includes(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
const MAX_U64 = 2n ** 64n - 1n;

/** parse_boolean(). */
function parseBoolean(text: string): boolean | null {
  const lower = text.toLowerCase();
  if (["1", "yes", "y", "true", "t", "on"].includes(lower)) return true;
  if (["0", "no", "n", "false", "f", "off"].includes(lower)) return false;
  return null;
}

/** strtol() and strtoul(): the number C reads, and where it stopped — 0 when it read nothing. */
function strtoInteger(s: string, base: number): { value: bigint; end: number } {
  let i = 0;
  while (i < s.length && " \t\n\r\v\f".includes(s[i]!)) i += 1;
  let negative = false;
  if (s[i] === "+" || s[i] === "-") {
    negative = s[i] === "-";
    i += 1;
  }
  if ((base === 0 || base === 16) && s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X") && /^[0-9a-f]$/i.test(s[i + 2] ?? "")) {
    i += 2;
    base = 16;
  } else if (base === 0) {
    base = s[i] === "0" ? 8 : 10;
  }
  const start = i;
  let value = 0n;
  for (; i < s.length; i += 1) {
    const digit = parseInt(s[i]!, 36);
    if (Number.isNaN(digit) || digit >= base) break;
    value = value * BigInt(base) + BigInt(digit);
  }
  if (i === start) return { value: 0n, end: 0 };
  return { value: negative ? -value : value, end: i };
}

/** mangle_base(): Python-style 0b and 0o prefixes, when no base was asked for. */
function mangleBase(s: string, base: number): { s: string; base: number } {
  if (base !== 0) return { s, base };
  if (/^0[bB]/.test(s)) return { s: s.slice(2), base: 2 };
  if (/^0[oO]/.test(s)) return { s: s.slice(2), base: 8 };
  return { s, base };
}

/** safe_atou_full(). */
function safeAtou(text: string, bits = 32, base = 0, refuse: { plusMinus?: boolean; leadingZero?: boolean; leadingWhitespace?: boolean } = {}): bigint | null {
  if (refuse.leadingWhitespace && isWhitespace(text[0])) return null;
  const trimmed = text.replace(/^[ \t\n\r]+/, "");
  if (refuse.plusMinus && (trimmed[0] === "+" || trimmed[0] === "-")) return null;
  if (refuse.leadingZero && trimmed[0] === "0" && trimmed !== "0") return null;
  const { s, base: radix } = mangleBase(trimmed, base);
  const { value, end } = strtoInteger(s, radix);
  if (end === 0 || end !== s.length) return null;
  const magnitude = value < 0n ? -value : value;
  if (magnitude > MAX_U64) return null;
  if (value !== 0n && s[0] === "-") return null;
  if (magnitude > 2n ** BigInt(bits) - 1n) return null;
  return magnitude;
}

/** safe_atoi() and safe_atoli(). */
function safeAtoi(text: string, bits = 32): bigint | null {
  const { s, base } = mangleBase(text.replace(/^[ \t\n\r]+/, ""), 0);
  const { value, end } = strtoInteger(s, base);
  if (end === 0 || end !== s.length) return null;
  const limit = 2n ** BigInt(bits - 1);
  return value < -limit || value > limit - 1n ? null : value;
}

/** parse_mode(): octal, at most 07777. */
function parseMode(text: string): number | null {
  const value = safeAtou(text, 32, 8, { plusMinus: true });
  return value === null || value > 0o7777n ? null : Number(value);
}

const IEC_SUFFIXES: readonly (readonly [string, bigint])[] = [
  ["E", 1024n ** 6n],
  ["P", 1024n ** 5n],
  ["T", 1024n ** 4n],
  ["G", 1024n ** 3n],
  ["M", 1024n ** 2n],
  ["K", 1024n],
  ["B", 1n],
  ["", 1n],
];

/** parse_size() with base 1024: `1G`, `1.5G`, `1G 512M`, `512 M` — but not `1GB` or `1Gb`. */
function parseSize(text: string): bigint | null {
  let p = 0;
  let total = 0n;
  let startPos = 0;
  do {
    while (isWhitespace(text[p])) p += 1;
    const rest = text.slice(p);
    const { value, end } = strtoInteger(rest, 10);
    if (end === 0) return null;
    if (rest[0] === "-" || value < 0n || value > MAX_U64) return null;
    let e = p + end;
    let fraction = 0;
    if (text[e] === ".") {
      e += 1;
      const digits = e;
      while (isDigit(text[e])) e += 1;
      if (e > digits) fraction = Number(`0.${text.slice(digits, e)}`);
    }
    while (isWhitespace(text[e])) e += 1;
    let i = startPos;
    while (i < IEC_SUFFIXES.length && !text.startsWith(IEC_SUFFIXES[i]![0], e)) i += 1;
    if (i >= IEC_SUFFIXES.length) return null;
    const [suffix, factor] = IEC_SUFFIXES[i]!;
    total += value * factor + BigInt(Math.floor(fraction * Number(factor)));
    if (total > MAX_U64) return null;
    p = e + suffix.length;
    startPos = i + 1;
  } while (p < text.length);
  return total;
}

/** parse_permyriad(): `50%`, `12.5%`, `12.34%`, `5‰`, `5‱`, as parts in 10000. */
function parsePermyriad(text: string, bounded: boolean): number | null {
  const places = (body: string, allowed: number, scale: number): number | null => {
    const dot = body.indexOf(".");
    let whole = body;
    let part = 0;
    if (dot >= 0) {
      const decimals = body.slice(dot + 1);
      if (decimals.length < 1 || decimals.length > allowed || !/^\d+$/.test(decimals)) return null;
      part = Number(decimals.padEnd(allowed, "0"));
      whole = body.slice(0, dot);
    }
    const value = safeAtoi(whole);
    if (value === null || value < 0n) return null;
    return Number(value) * scale + part;
  };
  let value: number | null;
  if (text.endsWith("‱")) {
    const whole = safeAtoi(text.slice(0, -1));
    value = whole === null || whole < 0n ? null : Number(whole);
  } else if (text.endsWith("‰")) value = places(text.slice(0, -1), 1, 10);
  else if (text.endsWith("%")) value = places(text.slice(0, -1), 2, 100);
  else return null;
  if (value === null || (bounded && value > 10000)) return null;
  return value;
}

const SIGNAL_NAMES = [
  "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT",
  "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS",
];

/** signal_from_string(): 15, TERM, SIGTERM, RTMIN+3, SIGRTMAX-1. */
function signalFromString(text: string): boolean {
  const number = safeAtoi(text);
  if (number !== null) return number >= 1n && number <= 64n;
  const name = text.startsWith("SIG") ? text.slice(3) : text;
  if (SIGNAL_NAMES.includes(name)) return true;
  for (const [base, sign] of [["RTMIN", "+"], ["RTMAX", "-"]] as const) {
    if (!name.startsWith(base)) continue;
    const rest = name.slice(base.length);
    if (rest === "") return true;
    if (rest[0] !== sign) return false;
    const offset = safeAtoi(rest);
    return offset !== null && (sign === "+" ? offset >= 0n && offset <= 30n : offset <= 0n && offset >= -30n);
  }
  return false;
}

/** cunescape_one(): the character a backslash sequence stands for, and its length after the backslash. */
function cunescapeOne(s: string, i: number): { char: string; length: number } | null {
  const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'", s: " " };
  const c = s[i];
  if (c === undefined) return null;
  if (c in simple) return { char: simple[c]!, length: 1 };
  const hex = (from: number, count: number): number | null => {
    const digits = s.slice(from, from + count);
    return digits.length === count && /^[0-9a-f]+$/i.test(digits) ? parseInt(digits, 16) : null;
  };
  if (c === "x") {
    const v = hex(i + 1, 2);
    return v === null || v === 0 ? null : { char: String.fromCharCode(v), length: 3 };
  }
  if (c === "u" || c === "U") {
    const count = c === "u" ? 4 : 8;
    const v = hex(i + 1, count);
    if (v === null || v === 0) return null;
    if (c === "U" && (v >= 0x110000 || (v & 0xfffff800) === 0xd800 || (v >= 0xfdd0 && v <= 0xfdef) || (v & 0xfffe) === 0xfffe)) return null;
    return { char: String.fromCodePoint(v), length: count + 1 };
  }
  if (c >= "0" && c <= "7") {
    const digits = s.slice(i, i + 3);
    if (!/^[0-7]{3}$/.test(digits)) return null;
    const v = parseInt(digits, 8);
    return v === 0 || v > 255 ? null : { char: String.fromCharCode(v), length: 3 };
  }
  return null;
}

/**
 * extract_first_word() with EXTRACT_UNQUOTE and EXTRACT_CUNESCAPE, from
 * `start`: the word, and where the next one starts. Null when none is left;
 * "einval" for an unknown escape (unless `relax`) or an unclosed quote.
 */
function extractWord(s: string, start: number, relax = false): { word: string; next: number } | null | "einval" {
  let p = start;
  while (p < s.length && isWhitespace(s[p])) p += 1;
  if (p >= s.length) return null;
  let out = "";
  let quote: string | null = null;
  let backslash = false;
  for (;;) {
    if (backslash) {
      const c = s[p];
      if (c === undefined) return relax && quote === null ? { word: `${out}\\`, next: s.length } : "einval";
      const escape = cunescapeOne(s, p);
      if (escape) {
        out += escape.char;
        p += escape.length - 1;
      } else if (relax) {
        out += `\\${c}`;
      } else {
        return "einval";
      }
      backslash = false;
      p += 1;
      continue;
    }
    if (quote !== null) {
      for (;; p += 1) {
        const c = s[p];
        if (c === undefined) return "einval";
        if (c === quote) {
          quote = null;
          break;
        }
        if (c === "\\") {
          backslash = true;
          break;
        }
        out += c;
      }
      p += 1;
      continue;
    }
    for (;; p += 1) {
      const c = s[p];
      if (c === undefined) return { word: out, next: s.length };
      if (c === "'" || c === '"') {
        quote = c;
        break;
      }
      if (c === "\\") {
        backslash = true;
        break;
      }
      if (isWhitespace(c)) {
        let q = p;
        while (q < s.length && isWhitespace(s[q])) q += 1;
        return { word: out, next: q };
      }
      out += c;
    }
    p += 1;
  }
}

/** extract_first_word_and_warn(): an unknown escape is kept as written, with a warning. */
function extractWordAndWarn(s: string, start: number): { word: string; next: number; unknownEscape: boolean } | null | "unbalanced" {
  const strict = extractWord(s, start);
  if (strict !== "einval") return strict === null ? null : { ...strict, unknownEscape: false };
  const relaxed = extractWord(s, start, true);
  if (relaxed === "einval") return "unbalanced";
  return relaxed === null ? null : { ...relaxed, unknownEscape: true };
}

/** Every word of a line, as systemd splits it, or null where a quote is never closed. */
function splitWords(s: string): string[] | null {
  const words: string[] = [];
  for (let p = 0; ; ) {
    const next = extractWord(s, p, true);
    if (next === "einval") return null;
    if (next === null) return words;
    words.push(next.word);
    p = next.next;
  }
}

/* -------------------------------------------------------------- specifiers */

/** The letters unit_name_printf() expands: the ones fit for unit names. */
const NAME_SPECIFIERS = "ijnNp" + "aAbBHlqmMovwW" + "gGuU";
/** The letters unit_full_printf() and unit_path_printf() expand. */
const FULL_SPECIFIERS = "iIjJnNpPfyYcrRCdDELSths" + "aAbBHlqmMovwW" + "gGuU" + "TV";

/** What a specifier stands for, near enough to tell a path from a name. */
function specifierValue(letter: string, unit: string): string {
  const dot = unit.lastIndexOf(".");
  const base = dot > 0 ? unit.slice(0, dot) : unit;
  const at = base.indexOf("@");
  const prefix = at >= 0 ? base.slice(0, at) : base;
  const instance = at >= 0 ? base.slice(at + 1) : "";
  const unescape = (text: string) => text.replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const last = prefix.slice(prefix.lastIndexOf("-") + 1);
  const values: Record<string, string> = {
    i: instance,
    I: unescape(instance),
    j: last,
    J: unescape(last),
    n: unit,
    N: base,
    p: prefix,
    P: unescape(prefix),
    f: `/${unescape(instance || prefix).replace(/-/g, "/")}`,
    y: `/etc/systemd/system/${unit}`,
    Y: "/etc/systemd/system",
    c: `/system.slice/${unit}`,
    r: "/system.slice",
    R: "/",
    C: "/var/cache",
    d: `/run/credentials/${unit}`,
    D: "/usr/share",
    E: "/etc",
    L: "/var/log",
    S: "/var/lib",
    t: "/run",
    h: "/root",
    s: "/bin/sh",
    T: "/tmp",
    V: "/var/tmp",
    a: "x86-64",
    b: "0123456789abcdef0123456789abcdef",
    H: "localhost",
    l: "localhost",
    q: "localhost",
    m: "0123456789abcdef0123456789abcdef",
    o: "linux",
    v: "6.8.0",
    w: "24.04",
    g: "root",
    G: "0",
    u: "root",
    U: "0",
  };
  return values[letter] ?? "";
}

/** specifier_printf(): the text with specifiers expanded, or the first one systemd does not know. */
function expandSpecifiers(text: string, letters: string, unit: string): { text: string } | { bad: string } {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "%") {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += "%";
      break;
    }
    i += 1;
    if (next === "%") out += "%";
    else if (letters.includes(next)) out += specifierValue(next, unit);
    else if (/[A-Za-z0-9]/.test(next)) return { bad: `%${next}` };
    else out += `%${next}`;
  }
  return { text: out };
}

/** The specifier letters a word uses, %% pairs aside. */
function specifierLetters(text: string): string[] {
  const letters: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "%") continue;
    const next = text[i + 1];
    if (next !== undefined && next !== "%" && /[A-Za-z0-9]/.test(next) && !letters.includes(next)) letters.push(next);
    i += 1;
  }
  return letters;
}

/** Doubles the % of each specifier — or of just `only` — so systemd passes it through. */
function doublePercents(text: string, only?: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "%") {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === "%") {
      out += "%%";
      i += 1;
    } else {
      out += next !== undefined && /[A-Za-z0-9]/.test(next) && (only === undefined || only === next) ? "%%" : "%";
    }
  }
  return out;
}

/** Specifiers that look like date(1) formats, with what systemd puts in their place. */
const DATE_LOOKALIKES: Readonly<Record<string, Both>> = {
  Y: both("the unit file's directory", "thư mục chứa file unit"),
  m: both("the machine ID", "machine ID"),
  d: both("the credentials directory", "thư mục credentials"),
  H: both("the host name", "tên máy"),
  M: both("the OS image ID", "ID ảnh hệ điều hành"),
  S: both("the state directory, /var/lib", "thư mục state, /var/lib"),
  T: both("the temporary directory, /tmp", "thư mục tạm, /tmp"),
  s: both("the user's shell", "shell của người dùng"),
  a: both("the architecture", "kiến trúc máy"),
  A: both("the OS image version", "phiên bản ảnh hệ điều hành"),
  b: both("the boot ID", "boot ID"),
  B: both("the OS build ID", "build ID của hệ điều hành"),
  j: both("part of the unit's name", "một phần tên unit"),
  p: both("the unit's name", "tên unit"),
  u: both("the user name", "tên người dùng"),
};

/* ------------------------------------------------------------ names, paths */

/** unit_name_is_valid() with UNIT_NAME_ANY. */
export function unitNameIsValid(name: string): boolean {
  if (name === "" || name.length >= 256) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !(UNIT_TYPES as readonly string[]).includes(name.slice(dot + 1))) return false;
  const stem = name.slice(0, dot);
  return /^[A-Za-z0-9:_.\\@-]+$/.test(stem) && stem.indexOf("@") !== 0;
}

/** path_simplify(): no doubled slashes, no "." components, no trailing slash. */
function pathSimplify(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return path.startsWith("/") ? `/${parts.join("/")}` : parts.join("/") || ".";
}

type PathProblem = "relative" | "dotdot" | "long";

/** path_simplify_and_warn() with PATH_CHECK_ABSOLUTE: what systemd objects to, if anything. */
function pathProblem(path: string): PathProblem | null {
  if (!path.startsWith("/")) return "relative";
  const simple = pathSimplify(path);
  if (simple.length >= 4096 || simple.split("/").some((part) => part.length > 255)) return "long";
  return simple.split("/").includes("..") ? "dotdot" : null;
}

/** valid_user_group_name() with VALID_USER_RELAX: "strict", "relaxed" (accepted with a notice) or null. */
function userNameValidity(name: string): "strict" | "relaxed" | null {
  if (name === "") return null;
  const uid = safeAtou(name, 32, 10, { plusMinus: true, leadingZero: true, leadingWhitespace: true });
  if (uid !== null) return uid === 0xffffffffn || uid === 0xffffn ? null : "strict";
  if (name.startsWith(" ") || name.endsWith(" ")) return null;
  if (/[\u0000-\u001f\u007f:/]/.test(name)) return null;
  if (/^\d+$/.test(name) || /^-\d*$/.test(name) || name === "." || name === "..") return null;
  return /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/.test(name) ? "strict" : "relaxed";
}

/** service_name_is_valid(): org.example.App, or a unique name such as :1.42. */
function busNameIsValid(name: string): boolean {
  if (name === "" || name.length > 255) return false;
  const unique = name.startsWith(":");
  const parts = (unique ? name.slice(1) : name).split(".");
  return parts.length >= 2 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part) && (unique || !/^\d/.test(part)));
}

/** documentation_url_is_valid(). */
function documentationUrlIsValid(url: string): boolean {
  for (const scheme of ["http://", "https://", "file:/", "info:", "man:"]) {
    if (url.startsWith(scheme)) return /^[\u0001-\u007f]+$/.test(url.slice(scheme.length));
  }
  return false;
}

/* ---------------------------------------------------------------- the files */

export interface UnitEntry {
  /** The first physical line, from 1, and the line systemd numbers it by. */
  readonly line: number;
  readonly systemdLine: number;
  readonly section: string;
  readonly key: string;
  readonly value: string;
  readonly info: DirectiveInfo | null;
  /** systemd skips the line: unknown, misplaced, or a value it refused. */
  ignored: boolean;
  /** systemd stops reading the file at this line, and the unit fails to load. */
  fatal: boolean;
  /** For command lines: how many commands systemd keeps from it. */
  commands: number;
}

export interface UnitSection {
  readonly name: string;
  readonly line: number;
  /** systemd reads it for this unit type; otherwise everything under it is ignored. */
  readonly known: boolean;
}

export interface UnitFile {
  /** The path systemctl cat printed above it, if it was pasted that way. */
  readonly path: string | null;
  /** The unit's name, `backup.service`; for a drop-in, the unit it extends. */
  readonly name: string | null;
  readonly type: UnitType | null;
  readonly dropIn: boolean;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly sections: readonly UnitSection[];
  readonly entries: readonly UnitEntry[];
  /** systemd stops reading the file at this line: a broken section header or a fatal value. */
  readonly stoppedAt: number | null;
}

export interface UnitFact {
  readonly label: Both;
  readonly value: Both;
}

export interface UnitSummary {
  readonly name: string | null;
  readonly type: UnitType | null;
  /** The files it was read from: its own and its drop-ins. */
  readonly files: readonly UnitFile[];
  readonly facts: readonly UnitFact[];
  /** systemd would refuse to load it. */
  readonly refused: boolean;
}

export interface UnitAnalysis {
  readonly files: readonly UnitFile[];
  readonly units: readonly UnitSummary[];
  /** In line order, the unit-wide ones last. */
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<Severity, number>>;
}

/** Past this the input is not a unit file but a paste that went wrong. */
export const UNIT_LINE_LIMIT = 5000;

const SUFFIXES = UNIT_TYPES.join("|");
/** `# /etc/systemd/system/backup.service`, as systemctl cat prints above each file. */
const CAT_HEADER = new RegExp(`^#\\s+(/\\S+?\\.(?:${SUFFIXES})(?:\\.d/[^\\s/]+\\.conf)?)\\s*$`);

interface RawFile {
  readonly path: string | null;
  readonly name: string | null;
  readonly dropIn: boolean;
  /** The systemctl cat header line above it, if any. */
  readonly header: number | null;
  readonly lines: readonly { readonly number: number; readonly text: string }[];
}

function unitTypeOf(name: string | null): UnitType | null {
  if (name === null) return null;
  const suffix = /\.([a-z]+)$/.exec(name)?.[1];
  return (UNIT_TYPES as readonly string[]).includes(suffix ?? "") ? (suffix as UnitType) : null;
}

/**
 * The files in a paste: one per `systemctl cat` header; and, when no file
 * name was given, a new file wherever a second [Unit] or a second type's
 * section shows two files were pasted one after the other.
 */
function splitFiles(text: string, fileName: string | null): RawFile[] {
  const lines = text.split(/\r\n|\n|\r/);
  // A final newline ends the last line; it does not start another.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  type Building = { path: string | null; name: string | null; dropIn: boolean; header: number | null; lines: { number: number; text: string }[]; typeSection: string | null };
  const files: Building[] = [];
  let current: Building | null = null;
  lines.forEach((line, index) => {
    const header = CAT_HEADER.exec(line.trim());
    if (header) {
      const path = header[1]!;
      const dropIn = /\.d\/[^/]+\.conf$/.test(path);
      const name = dropIn ? /([^/]+)\.d\/[^/]+\.conf$/.exec(path)![1]! : path.slice(path.lastIndexOf("/") + 1);
      current = { path, name, dropIn, header: index + 1, lines: [], typeSection: null };
      files.push(current);
      return;
    }
    const section = /^\s*\[([^\]]*)\]\s*$/.exec(line)?.[1];
    if (current !== null && current.path === null && fileName === null && current.typeSection !== null && section !== undefined) {
      if (section === "Unit" || (SECTION_TYPE.has(section) && section !== current.typeSection)) current = null;
    }
    if (current === null) {
      current = { path: null, name: null, dropIn: false, header: null, lines: [], typeSection: null };
      files.push(current);
    }
    if (section !== undefined && SECTION_TYPE.has(section) && current.typeSection === null) current.typeSection = section;
    current.lines.push({ number: index + 1, text: line });
  });
  const kept = files.filter((file) => file.path !== null || file.lines.some((line) => line.text.trim() !== ""));
  if (kept.length === 1 && kept[0]!.path === null) kept[0]!.name = fileName;
  return kept;
}

interface ReadContext {
  readonly findings: Finding[];
  readonly type: UnitType | null;
  /** For expanding specifiers: the unit's name, or a stand-in. */
  readonly unit: string;
  readonly dropIn: boolean;
}

interface ReadState {
  section: string | null;
  sectionIgnored: boolean;
  stoppedAt: number | null;
}

function readFile(raw: RawFile, findings: Finding[]): UnitFile {
  // A file named by its path has its type from the name; otherwise from the
  // one type-specific section it has, as long as there is just one.
  let type = unitTypeOf(raw.name);
  if (type === null) {
    const present = new Set<UnitType>();
    for (const { text } of raw.lines) {
      const header = /^\s*\[([^\]]*)\]\s*$/.exec(text);
      const found = header ? SECTION_TYPE.get(header[1]!) : undefined;
      if (found) present.add(found);
    }
    if (present.size === 1) type = [...present][0]!;
  }
  const valid = new Set(["Unit", "Install"]);
  if (type !== null && TYPE_SECTION[type]) valid.add(TYPE_SECTION[type]!);

  const ctx: ReadContext = { findings, type, unit: raw.name ?? `unit.${type ?? "service"}`, dropIn: raw.dropIn };
  const sections: UnitSection[] = [];
  const entries: UnitEntry[] = [];
  const state: ReadState = { section: null, sectionIgnored: false, stoppedAt: null };

  const parseLine = (text: string, first: number, reported: number): void => {
    const line = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    if (line === "") return;
    const say = (severity: Severity, level: LogLevel, en: string, vi: string, fix?: string) =>
      findings.push({ severity, source: "line", level, line: first, systemdLine: reported, text: both(en, vi), ...(fix ? { fix } : {}) });

    if (line[0] === "[") {
      if (!line.endsWith("]")) {
        say(
          "error",
          "error",
          `“${line}” opens a section header without closing it. ${stopped(raw.dropIn).en}`,
          `“${line}” mở tên mục mà không đóng lại. ${stopped(raw.dropIn).vi}`,
          `${line}]`,
        );
        state.stoppedAt = first;
        return;
      }
      const name = line.slice(1, -1);
      if (/[\u0000-\u001f\u007f'"\\]/.test(name)) {
        say(
          "error",
          "error",
          `The section name “${name}” has a character systemd refuses — a quote, a backslash or a control character. ${stopped(raw.dropIn).en}`,
          `Tên mục “${name}” có ký tự systemd không chấp nhận — dấu nháy, gạch chéo ngược hoặc ký tự điều khiển. ${stopped(raw.dropIn).vi}`,
        );
        state.stoppedAt = first;
        return;
      }
      const known = valid.has(name);
      sections.push({ name, line: first, known });
      state.section = known ? name : null;
      state.sectionIgnored = !known;
      if (!known) unknownSection(name, first, reported, ctx, valid);
      return;
    }

    const section = state.section;
    if (section === null) {
      if (!state.sectionIgnored) {
        say(
          "warning",
          "warning",
          "This line comes before any [Section] header, and systemd ignores it. Every setting belongs under one — most under [Unit] or the unit type's own.",
          "Dòng này nằm trước mọi tiêu đề [Mục], và systemd bỏ qua nó. Mọi thiết lập phải nằm trong một mục — phần lớn là [Unit] hoặc mục riêng của loại unit.",
        );
      }
      return;
    }

    const equals = line.indexOf("=");
    if (equals < 0) {
      if (/^\.include\s/.test(line)) {
        say(
          "warning",
          "warning",
          "systemd dropped .include long ago: it now reads this as a line with no “=”, and ignores it. Put the shared settings in a drop-in file instead.",
          "systemd đã bỏ .include từ lâu: giờ nó đọc dòng này như một dòng không có “=”, và bỏ qua. Hãy đặt các thiết lập dùng chung vào một file drop-in.",
        );
      } else {
        say("warning", "warning", `“${line}” has no “=”, so it is not a setting, and systemd ignores the line.`, `“${line}” không có dấu “=”, nên không phải một thiết lập, và systemd bỏ qua dòng này.`);
      }
      return;
    }
    if (equals === 0) {
      say("warning", "warning", "A value with no key in front of the “=” — systemd ignores the line.", "Có giá trị nhưng không có tên khoá trước dấu “=” — systemd bỏ qua dòng này.");
      return;
    }
    const key = line.slice(0, equals).replace(/[ \t\r\n]+$/, "");
    const value = line.slice(equals + 1).replace(/^[ \t\r\n]+/, "");
    const info = directiveIn(section, key);
    const entry: UnitEntry = { line: first, systemdLine: reported, section, key, value, info, ignored: false, fatal: false, commands: 0 };
    entries.push(entry);
    if (info === null) {
      entry.ignored = true;
      unknownKey(entry, ctx, valid);
      return;
    }
    // [Install] is read by systemctl enable, not when the unit loads.
    if (section === "Install") return;
    const outcome = checkValue(entry, info, ctx);
    if (outcome === "ignored") entry.ignored = true;
    if (outcome === "fatal") {
      entry.fatal = true;
      state.stoppedAt = first;
    }
  };

  let continuation: { text: string; first: number } | null = null;
  let bomSeen = false;
  const lines = raw.lines;
  for (const { number, text: physical } of lines) {
    if (state.stoppedAt !== null) break;
    // Comment lines go, even in the middle of a continued line.
    const lead = physical.replace(/^[ \t\r\n]+/, "");
    if (lead !== "" && (lead[0] === "#" || lead[0] === ";")) continue;
    let text = physical;
    if (!bomSeen && text.startsWith("\ufeff")) {
      text = text.slice(1);
      bomSeen = true;
    }

    const joined: string = continuation ? continuation.text + text : text;
    const first: number = continuation ? continuation.first : number;
    let escaped = false;
    for (const ch of joined) escaped = escaped ? false : ch === "\\";
    if (escaped) {
      continuation = { text: `${joined.slice(0, -1)} `, first };
      continue;
    }
    continuation = null;
    if (/\\[ \t]+$/.test(text)) {
      findings.push({
        severity: "warning",
        source: "advice",
        level: null,
        line: number,
        systemdLine: null,
        text: both(
          "This line ends in a backslash followed by spaces, which does not continue it: systemd reads the next line on its own. Delete the spaces after the backslash.",
          "Dòng này kết thúc bằng dấu gạch chéo ngược theo sau là dấu cách, nên không nối được sang dòng sau: systemd đọc dòng kế tiếp như một dòng riêng. Hãy xoá các dấu cách sau dấu gạch chéo ngược.",
        ),
      });
    }
    parseLine(joined, first, number);
  }
  // A continuation the file never finishes is read at the end, numbered one past it.
  const pending = continuation as { text: string; first: number } | null;
  if (pending !== null && state.stoppedAt === null) parseLine(pending.text, pending.first, (lines[lines.length - 1]?.number ?? 0) + 1);

  return {
    path: raw.path,
    name: raw.name,
    type,
    dropIn: raw.dropIn,
    firstLine: lines[0]?.number ?? 1,
    lastLine: lines[lines.length - 1]?.number ?? 1,
    sections,
    entries,
    stoppedAt: state.stoppedAt,
  };
}

/* ------------------------------------------------------- names and typos */

/** Levenshtein distance, capped: anything past `limit` is just "far". */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
      best = Math.min(best, row[j]!);
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length]!;
}

function closest(word: string, candidates: Iterable<string>): string | null {
  const limit = word.length <= 5 ? 1 : word.length <= 10 ? 2 : 3;
  let best: string | null = null;
  let bestScore = limit + 1;
  for (const candidate of candidates) {
    const score = distance(word.toLowerCase(), candidate.toLowerCase(), limit);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

const ALL_SECTIONS = ["Unit", "Install", ...SECTION_TYPE.keys()];

function unknownSection(name: string, line: number, reported: number, ctx: ReadContext, valid: ReadonlySet<string>): void {
  const say = (en: string, vi: string, fix?: string) =>
    ctx.findings.push({ severity: "warning", source: "line", level: "warning", line, systemdLine: reported, text: both(en, vi), ...(fix ? { fix } : {}) });
  if (name.startsWith("X-")) {
    ctx.findings.push({
      severity: "note",
      source: "advice",
      level: null,
      line,
      systemdLine: null,
      text: both(`[${name}] is a custom section: systemd ignores it, and everything under it, without a word.`, `[${name}] là mục tự đặt: systemd lặng lẽ bỏ qua nó và mọi thứ bên dưới.`),
    });
    return;
  }
  const cased = [...valid].find((section) => section.toLowerCase() === name.toLowerCase());
  if (cased) {
    say(
      `Section names are case-sensitive: systemd does not know [${name}], so it ignores the section and every setting in it. Write [${cased}].`,
      `Tên mục phân biệt chữ hoa chữ thường: systemd không biết [${name}], nên bỏ qua cả mục và mọi thiết lập trong đó. Hãy viết [${cased}].`,
      `[${cased}]`,
    );
    return;
  }
  const otherType = SECTION_TYPE.get(name);
  if (otherType) {
    say(
      `[${name}] belongs in a .${otherType} file. In ${ctx.type ? `a .${ctx.type} file` : "this file"} systemd ignores it, with every setting under it.`,
      `[${name}] thuộc về file .${otherType}. Trong ${ctx.type ? `file .${ctx.type}` : "file này"}, systemd bỏ qua nó cùng mọi thiết lập bên dưới.`,
    );
    return;
  }
  const near = closest(name, valid) ?? closest(name, ALL_SECTIONS);
  say(
    `systemd does not know a [${name}] section, so it ignores it and every setting under it.${near ? ` Did you mean [${near}]?` : ""}`,
    `systemd không biết mục [${name}], nên bỏ qua nó và mọi thiết lập bên dưới.${near ? ` Có phải ý bạn là [${near}]?` : ""}`,
    near ? `[${near}]` : undefined,
  );
}

function unknownKey(entry: UnitEntry, ctx: ReadContext, valid: ReadonlySet<string>): void {
  const { key, section, value } = entry;
  if (key.startsWith("X-")) {
    advise(ctx, entry, "note", `${key}= is a custom key: systemd ignores it without a word.`, `${key}= là khoá tự đặt: systemd lặng lẽ bỏ qua nó.`);
    return;
  }

  // The right name in the wrong case.
  const cased = (BY_LOWER.get(key.toLowerCase()) ?? []).find((info) => info.section === section);
  if (cased) {
    warn(ctx, entry, `Keys are case-sensitive: systemd does not know ${key}=, and ignores the line. Write ${cased.name}=.`, `Tên khoá phân biệt chữ hoa chữ thường: systemd không biết ${key}=, và bỏ qua dòng này. Hãy viết ${cased.name}=.`, `${cased.name}=${value}`);
    return;
  }

  // A real setting, in another section.
  const elsewhere = BY_LOWER.get(key.toLowerCase())?.filter((info) => info.name === key) ?? [];
  const here = elsewhere.find((info) => valid.has(info.section));
  if (here) {
    warn(
      ctx,
      entry,
      `${key}= belongs in [${here.section}], not [${section}]. Here systemd ignores it, so the setting has no effect.`,
      `${key}= thuộc mục [${here.section}], không phải [${section}]. Đặt ở đây thì systemd bỏ qua, nên thiết lập không có tác dụng.`,
    );
    return;
  }
  if (elsewhere.length > 0) {
    const where = elsewhere[0]!;
    const type = SECTION_TYPE.get(where.section);
    warn(
      ctx,
      entry,
      `${key}= is a [${where.section}] setting${type ? `, for .${type} files` : ""}. In this unit systemd ignores it.`,
      `${key}= là thiết lập của mục [${where.section}]${type ? `, dành cho file .${type}` : ""}. Trong unit này systemd bỏ qua nó.`,
    );
    return;
  }

  const near = closest(key, BY_SECTION.get(section)?.keys() ?? []);
  warn(
    ctx,
    entry,
    `systemd ${SYSTEMD_VERSION} does not know ${key}= in [${section}], and ignores the line.${near ? ` Did you mean ${near}=?` : ""}`,
    `systemd ${SYSTEMD_VERSION} không biết ${key}= trong mục [${section}], và bỏ qua dòng này.${near ? ` Có phải ý bạn là ${near}=?` : ""}`,
    near ? `${near}=${value}` : undefined,
  );
}

/* ---------------------------------------------------------------- values */

type Outcome = "ok" | "ignored" | "fatal";

function push(ctx: ReadContext, entry: UnitEntry, severity: Severity, source: FindingSource, level: LogLevel | null, en: string, vi: string, fix?: string): void {
  ctx.findings.push({
    severity,
    source,
    level: source === "advice" ? null : level,
    line: entry.line,
    systemdLine: source === "line" ? entry.systemdLine : null,
    text: both(en, vi),
    ...(fix ? { fix } : {}),
  });
}

/** systemd warns about this line and ignores it. */
function warn(ctx: ReadContext, entry: UnitEntry, en: string, vi: string, fix?: string): "ignored" {
  push(ctx, entry, "warning", "line", "warning", en, vi, fix);
  return "ignored";
}

/**
 * What a fatal line does: in a unit's own file, systemd stops reading and the
 * unit fails to load; in a drop-in, it stops reading that drop-in, and the
 * unit loads without the rest of it.
 */
function stopped(dropIn: boolean): Both {
  return dropIn
    ? both("systemd stops reading this drop-in here: the unit still loads, without the rest of the drop-in.", "systemd ngừng đọc drop-in này tại đây: unit vẫn nạp được, nhưng thiếu phần còn lại của drop-in.")
    : both("systemd stops reading the file here, and the unit fails to load.", "systemd ngừng đọc file tại đây, và unit không nạp được.");
}

/** systemd stops reading the file at this line; the unit fails to load. */
function fatal(ctx: ReadContext, entry: UnitEntry, en: string, vi: string, fix?: string): "fatal" {
  push(ctx, entry, "error", "line", "error", `${en} ${stopped(ctx.dropIn).en}`, `${vi} ${stopped(ctx.dropIn).vi}`, fix);
  return "fatal";
}

/** This page's advice about the line; systemd itself says nothing. */
function advise(ctx: ReadContext, entry: UnitEntry, severity: Severity, en: string, vi: string, fix?: string): void {
  push(ctx, entry, severity, "advice", null, en, vi, fix);
}

const REPLACED: Readonly<Record<string, Both>> = {
  MemoryLimit: both("Use MemoryMax=, which takes the same values.", "Hãy dùng MemoryMax=, nhận cùng kiểu giá trị."),
  CPUShares: both("Use CPUWeight=, from 1 to 10000 with 100 as the default.", "Hãy dùng CPUWeight=, từ 1 đến 10000, mặc định 100."),
  StartupCPUShares: both("Use StartupCPUWeight=.", "Hãy dùng StartupCPUWeight=."),
  CPUAccounting: both("CPU accounting is always on now; delete the line.", "Giờ việc thống kê CPU luôn bật; hãy xoá dòng này."),
  BlockIOAccounting: both("Use IOAccounting=.", "Hãy dùng IOAccounting=."),
  BlockIOWeight: both("Use IOWeight=.", "Hãy dùng IOWeight=."),
  StartupBlockIOWeight: both("Use StartupIOWeight=.", "Hãy dùng StartupIOWeight=."),
  BlockIODeviceWeight: both("Use IODeviceWeight=.", "Hãy dùng IODeviceWeight=."),
  BlockIOReadBandwidth: both("Use IOReadBandwidthMax=.", "Hãy dùng IOReadBandwidthMax=."),
  BlockIOWriteBandwidth: both("Use IOWriteBandwidthMax=.", "Hãy dùng IOWriteBandwidthMax=."),
  Capabilities: both("Use AmbientCapabilities= and CapabilityBoundingSet=.", "Hãy dùng AmbientCapabilities= và CapabilityBoundingSet=."),
  NetClass: both("Delete the line; there is no replacement.", "Hãy xoá dòng này; không có thiết lập thay thế."),
};

/** Old names systemd still reads without a word, and what to write instead. */
const RENAMED: Readonly<Record<string, Both>> = {
  BindTo: both("BindTo= is the old spelling of BindsTo=; systemd still reads it.", "BindTo= là cách viết cũ của BindsTo=; systemd vẫn đọc được."),
  PropagateReloadTo: both("PropagateReloadTo= is the old name of PropagatesReloadTo=.", "PropagateReloadTo= là tên cũ của PropagatesReloadTo=."),
  PropagateReloadFrom: both("PropagateReloadFrom= is the old name of ReloadPropagatedFrom=.", "PropagateReloadFrom= là tên cũ của ReloadPropagatedFrom=."),
  OnFailureIsolate: both("OnFailureIsolate= is the old form of OnFailureJobMode=isolate.", "OnFailureIsolate= là dạng cũ của OnFailureJobMode=isolate."),
  ReadWriteDirectories: both("ReadWriteDirectories= is the old name of ReadWritePaths=.", "ReadWriteDirectories= là tên cũ của ReadWritePaths=."),
  ReadOnlyDirectories: both("ReadOnlyDirectories= is the old name of ReadOnlyPaths=.", "ReadOnlyDirectories= là tên cũ của ReadOnlyPaths=."),
  InaccessibleDirectories: both("InaccessibleDirectories= is the old name of InaccessiblePaths=.", "InaccessibleDirectories= là tên cũ của InaccessiblePaths=."),
  PermissionsStartOnly: both(
    "PermissionsStartOnly= is deprecated: prefix the commands that need root with + instead.",
    "PermissionsStartOnly= đã lỗi thời: thay vào đó hãy thêm dấu + trước các lệnh cần quyền root.",
  ),
};

/** The [Service] settings that moved to [Unit] and are still read in the old place. */
const MOVED_TO_UNIT = new Set(["StartLimitInterval", "StartLimitBurst", "StartLimitAction", "FailureAction", "RebootArgument"]);

/** Settings read as a tristate: empty is a legal "back to the default". */
const TRISTATE = new Set(["SetLoginEnvironment", "PrivateMounts", "MountAPIVFS", "BindLogSockets", "MemoryKSM"]);

const BOOLEAN_WORDS = ["yes", "no", "true", "false", "on", "off", "1", "0", "y", "n", "t", "f"];

interface Choice {
  readonly words: readonly string[];
  /** It takes yes and no too. */
  readonly bool?: boolean;
  /** An empty value is a legal reset. */
  readonly empty?: boolean;
  /** It takes numbers up to this too. */
  readonly numbers?: number;
}

/** The words each fixed-choice setting takes, from systemd 259's string tables. */
const CHOICES: Readonly<Record<string, Choice>> = (() => {
  const jobModes = ["fail", "lenient", "replace", "replace-irreversibly", "isolate", "flush", "ignore-dependencies", "ignore-requirements", "triggering", "restart-dependencies"];
  const emergency = ["none", "exit", "exit-force", "reboot", "reboot-force", "reboot-immediate", "poweroff", "poweroff-force", "poweroff-immediate", "soft-reboot", "soft-reboot-force", "kexec", "kexec-force", "halt", "halt-force", "halt-immediate"];
  const levels = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];
  return {
    Type: { words: ["simple", "exec", "forking", "oneshot", "dbus", "notify", "notify-reload", "idle"] },
    Restart: { words: ["no", "on-success", "on-failure", "on-abnormal", "on-watchdog", "on-abort", "always"] },
    RestartMode: { words: ["normal", "direct", "debug"] },
    ExitType: { words: ["main", "cgroup"] },
    TimeoutStartFailureMode: { words: ["terminate", "abort", "kill"] },
    TimeoutStopFailureMode: { words: ["terminate", "abort", "kill"] },
    KillMode: { words: ["control-group", "process", "mixed", "none"], empty: true },
    NotifyAccess: { words: ["none", "main", "exec", "all"] },
    CollectMode: { words: ["inactive", "inactive-or-failed"] },
    OOMPolicy: { words: ["continue", "stop", "kill"] },
    OnSuccessJobMode: { words: jobModes },
    OnFailureJobMode: { words: jobModes },
    FailureAction: { words: emergency },
    SuccessAction: { words: emergency },
    StartLimitAction: { words: emergency },
    JobTimeoutAction: { words: emergency },
    ProtectSystem: { words: ["full", "strict"], bool: true },
    ProtectHome: { words: ["read-only", "tmpfs"], bool: true },
    PrivateTmp: { words: ["connected", "disconnected"], bool: true },
    RuntimeDirectoryPreserve: { words: ["restart"], bool: true },
    FileDescriptorStorePreserve: { words: ["restart"], bool: true },
    DevicePolicy: { words: ["auto", "closed", "strict"] },
    KeyringMode: { words: ["inherit", "private", "shared"] },
    ProtectProc: { words: ["default", "noaccess", "invisible", "ptraceable"] },
    ProcSubset: { words: ["all", "pid"] },
    SyslogLevel: { words: levels, numbers: 7 },
    LogLevelMax: { words: levels, numbers: 7 },
    SyslogFacility: {
      words: ["kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news", "uucp", "cron", "authpriv", "ftp", ...Array.from({ length: 8 }, (_, i) => `local${i}`)],
      numbers: 127,
    },
    IOSchedulingClass: { words: ["none", "realtime", "best-effort", "idle"], numbers: 7, empty: true },
    CPUSchedulingPolicy: { words: ["other", "batch", "idle", "fifo", "rr"], numbers: 2147483647, empty: true },
    UtmpMode: { words: ["init", "login", "user"] },
    MountFlags: { words: ["shared", "slave", "private"], empty: true },
    PrivateUsers: { words: ["self", "identity", "full"], bool: true },
    PrivatePIDs: { words: [], bool: true },
    PrivateBPF: { words: [], bool: true },
    ProtectControlGroups: { words: ["private", "strict"], bool: true },
    ProtectHostname: { words: ["private"], bool: true, empty: true },
  };
})();

/** The capabilities Linux has, by number; systemd takes them by name, in any case, or by number up to 62. */
const CAPABILITIES = [
  "CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL", "CAP_SETGID", "CAP_SETUID", "CAP_SETPCAP",
  "CAP_LINUX_IMMUTABLE", "CAP_NET_BIND_SERVICE", "CAP_NET_BROADCAST", "CAP_NET_ADMIN", "CAP_NET_RAW", "CAP_IPC_LOCK", "CAP_IPC_OWNER",
  "CAP_SYS_MODULE", "CAP_SYS_RAWIO", "CAP_SYS_CHROOT", "CAP_SYS_PTRACE", "CAP_SYS_PACCT", "CAP_SYS_ADMIN", "CAP_SYS_BOOT", "CAP_SYS_NICE",
  "CAP_SYS_RESOURCE", "CAP_SYS_TIME", "CAP_SYS_TTY_CONFIG", "CAP_MKNOD", "CAP_LEASE", "CAP_AUDIT_WRITE", "CAP_AUDIT_CONTROL", "CAP_SETFCAP",
  "CAP_MAC_OVERRIDE", "CAP_MAC_ADMIN", "CAP_SYSLOG", "CAP_WAKE_ALARM", "CAP_BLOCK_SUSPEND", "CAP_AUDIT_READ", "CAP_PERFMON", "CAP_BPF",
  "CAP_CHECKPOINT_RESTORE",
];

/** How each resource limit's value is read: a count, a size, seconds, microseconds or a nice level. */
const RLIMIT_KIND: Readonly<Record<string, "u64" | "size" | "sec" | "usec" | "nice">> = {
  LimitCPU: "sec",
  LimitFSIZE: "size",
  LimitDATA: "size",
  LimitSTACK: "size",
  LimitCORE: "size",
  LimitRSS: "size",
  LimitNOFILE: "u64",
  LimitAS: "size",
  LimitNPROC: "u64",
  LimitMEMLOCK: "size",
  LimitLOCKS: "u64",
  LimitSIGPENDING: "u64",
  LimitMSGQUEUE: "size",
  LimitNICE: "nice",
  LimitRTPRIO: "u64",
  LimitRTTIME: "usec",
};

/** rlimit_parse_one(): the limit as a number, MAX_U64 for infinity, or null. */
function rlimitValue(kind: "u64" | "size" | "sec" | "usec" | "nice", text: string): bigint | null {
  if (kind === "nice") {
    if (text.startsWith("+")) {
      const n = safeAtou(text.slice(1), 64);
      return n === null || n >= 20n ? null : 20n - n;
    }
    if (text.startsWith("-")) {
      const n = safeAtou(text.slice(1), 64);
      return n === null || n > 20n ? null : 20n + n;
    }
    const n = safeAtou(text, 64);
    return n === null || n > 40n ? null : n;
  }
  if (kind === "sec" || kind === "usec") {
    const us = parseTimespan(text);
    if (us === null) return null;
    if (us === Number.POSITIVE_INFINITY) return MAX_U64;
    return kind === "sec" ? BigInt(Math.ceil(us / 1e6)) : BigInt(us);
  }
  if (text === "infinity") return MAX_U64;
  const n = kind === "size" ? parseSize(text) : safeAtou(text, 64);
  return n === null || n >= MAX_U64 ? null : n;
}

/** hostname_is_valid(): letters, digits and hyphens in dot-separated labels, at most 64 characters. */
function hostnameIsValid(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/** Where each directory setting puts its directories. */
const DIRECTORY_BASE: Readonly<Record<string, string>> = {
  RuntimeDirectory: "/run/",
  StateDirectory: "/var/lib/",
  CacheDirectory: "/var/cache/",
  LogsDirectory: "/var/log/",
  ConfigurationDirectory: "/etc/",
};

/** Kinds whose whole value systemd runs through the specifier expander first. */
const WHOLE_VALUE_SPECIFIERS = new Set(["s", "p", "F", "P", "f", "c", "d", "Q"]);

/** Checks one value as systemd's parser for it would. */
function checkValue(entry: UnitEntry, info: DirectiveInfo, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  const kind = info.kind;

  if (kind === "r") {
    push(
      ctx,
      entry,
      "warning",
      "line",
      "info",
      `${key}= was removed from systemd, which now ignores it — so whatever it was meant to do, it does not.${REPLACED[key] ? ` ${REPLACED[key]!.en}` : ""}`,
      `${key}= đã bị loại khỏi systemd, giờ nó bỏ qua thiết lập này — nên điều nó định làm sẽ không xảy ra.${REPLACED[key] ? ` ${REPLACED[key]!.vi}` : ""}`,
    );
    return "ignored";
  }
  const renamed = RENAMED[key];
  if (renamed) advise(ctx, entry, "note", renamed.en, renamed.vi);

  // A comment after a value, or quotes around it, are part of the value to systemd.
  const comment = /\s#/.test(value);
  const quoted = /^(["']).*\1$/.test(value) && value.length >= 2;
  const reject = (en: string, vi: string, fix?: string): "ignored" =>
    warn(
      ctx,
      entry,
      comment ? `${en} systemd has no comments after a value: put the comment on a line of its own.` : quoted ? `${en} systemd does not strip the quotes here.` : en,
      comment ? `${vi} systemd không có chú thích sau giá trị: hãy đặt chú thích trên một dòng riêng.` : quoted ? `${vi} systemd không bỏ dấu nháy ở đây.` : vi,
      fix ?? (comment ? `${key}=${value.replace(/\s+#.*$/, "")}` : quoted ? `${key}=${value.slice(1, -1)}` : undefined),
    );

  if (WHOLE_VALUE_SPECIFIERS.has(kind)) {
    const expanded = expandSpecifiers(value, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) {
      const en = `“${expanded.bad}” is not a specifier systemd knows: in a unit file a percent sign starts one, so a literal % is written %%.`;
      const vi = `“${expanded.bad}” không phải specifier systemd biết: trong file unit, dấu phần trăm mở đầu một specifier, nên dấu % thật phải viết là %%.`;
      const fix = `${key}=${doublePercents(value, expanded.bad.slice(1))}`;
      if (kind === "F") return fatal(ctx, entry, en, vi, fix);
      return warn(ctx, entry, `${en} systemd ignores the whole line.`, `${vi} systemd bỏ qua cả dòng.`, fix);
    }
  }

  if (key === "BusName") {
    const name = (expandSpecifiers(value, FULL_SPECIFIERS, ctx.unit) as { text: string }).text;
    if (busNameIsValid(name)) return "ok";
    return warn(
      ctx,
      entry,
      `“${name}” is not a D-Bus name: it needs at least two parts separated by dots, such as org.example.App, each made of letters, digits, _ and - and not starting with a digit. systemd ignores the line.`,
      `“${name}” không phải tên D-Bus: nó cần ít nhất hai phần cách nhau bằng dấu chấm, như org.example.App, mỗi phần gồm chữ cái, chữ số, _ và - và không bắt đầu bằng chữ số. systemd bỏ qua dòng này.`,
    );
  }

  switch (kind) {
    case "b": {
      if (value === "" && TRISTATE.has(key)) return "ok";
      if (parseBoolean(value) !== null) return "ok";
      const en = `“${value}” is not a yes or no: systemd takes yes, no, true, false, on, off, 1 or 0.`;
      const vi = `“${value}” không phải có hoặc không: systemd nhận yes, no, true, false, on, off, 1 hoặc 0.`;
      if (key === "DynamicUser") return fatal(ctx, entry, en, vi);
      return reject(`${en} It ignores this line.`, `${vi} Nó bỏ qua dòng này.`);
    }
    case "t":
    case "T": {
      if (value === "" && (key === "CPUQuotaPeriodSec" || key === "TimeoutAbortSec")) return "ok";
      if (parseTimespan(value, kind === "T" ? "ns" : "us") !== null) return "ok";
      const units = /\d\s*[A-Z]/.test(value) || /\d\s*(?:mins?\b|minuts?|secs?\b|hrs?\b|hours?\b|days?\b)/i.test(value);
      return reject(
        `systemd cannot read “${value}” as a time span, and ignores this line.${units ? " Units come from a fixed list — us, ms, s, min, h, d, w, M for months, y — and case matters: 5Min reads M as months, then fails." : " Write a number with a unit, such as 30s, 5min or 1h 30min, or infinity."}`,
        `systemd không đọc được “${value}” là một khoảng thời gian, và bỏ qua dòng này.${units ? " Đơn vị lấy từ một danh sách cố định — us, ms, s, min, h, d, w, M là tháng, y — và có phân biệt hoa thường: 5Min bị đọc M là tháng, rồi lỗi." : " Hãy viết một số kèm đơn vị, như 30s, 5min hay 1h 30min, hoặc infinity."}`,
      );
    }
    case "n":
      if (safeAtou(value) !== null) return "ok";
      return reject(`“${value}” is not a whole number systemd can read here, and it ignores this line.`, `“${value}” không phải số nguyên mà systemd đọc được ở đây, và nó bỏ qua dòng này.`);
    case "i":
      if (safeAtoi(value, key.startsWith("MessageQueue") ? 64 : 32) !== null) return "ok";
      return reject(`“${value}” is not a whole number systemd can read here, and it ignores this line.`, `“${value}” không phải số nguyên mà systemd đọc được ở đây, và nó bỏ qua dòng này.`);
    case "N": {
      if (value === "") return "ok";
      const nice = safeAtoi(value);
      if (nice !== null && nice >= -20n && nice <= 19n) return "ok";
      return reject(`Nice= runs from -20, the most favoured, to 19; systemd ignores “${value}”.`, `Nice= chạy từ -20, ưu tiên cao nhất, đến 19; systemd bỏ qua “${value}”.`);
    }
    case "%": {
      if (value === "") return "ok";
      const quota = parsePermyriad(value, false);
      if (quota !== null && quota > 0) return "ok";
      const number = /^\d+(?:\.\d+)?$/.test(value);
      return reject(
        number ? `${key}= needs a percentage — ${value}% rather than ${value} — and systemd ignores the line.` : `systemd cannot read “${value}” as a CPU share above 0%, such as 50% or 200%, and ignores the line.`,
        number ? `${key}= cần giá trị phần trăm — ${value}% thay vì ${value} — và systemd bỏ qua dòng này.` : `systemd không đọc được “${value}” là phần CPU lớn hơn 0%, như 50% hay 200%, và bỏ qua dòng này.`,
        number ? `${key}=${value}%` : undefined,
      );
    }
    case "m":
      if (parseMode(value) !== null) return "ok";
      return reject(`“${value}” is not an octal file mode such as 0022 or 0750, and systemd ignores the line.`, `“${value}” không phải quyền tệp dạng bát phân như 0022 hay 0750, và systemd bỏ qua dòng này.`);
    case "z":
      return checkMemory(entry, reject);
    case "Z":
      if (parseSize(value) !== null) return "ok";
      return reject(sizeAdvice(value).en, sizeAdvice(value).vi, sizeFix(key, value));
    case "g":
      if (signalFromString(value)) return "ok";
      return reject(
        `“${value}” is not a signal systemd knows — write SIGTERM, TERM or 15, in capitals — and it ignores the line.`,
        `“${value}” không phải tín hiệu systemd biết — hãy viết SIGTERM, TERM hoặc 15, bằng chữ in hoa — và nó bỏ qua dòng này.`,
        value !== value.toUpperCase() && signalFromString(value.toUpperCase()) ? `${key}=${value.toUpperCase()}` : undefined,
      );
    case "E":
      return checkChoice(entry, ctx, reject);
    case "O":
    case "I":
      return checkStdio(entry, ctx);
    case "x":
      return checkExec(entry, ctx);
    case "u":
    case "o":
      return checkDependency(entry, ctx);
    case "U":
      return checkTrigger(entry, ctx);
    case "e":
      return checkEnvironment(entry, ctx);
    case "f": {
      if (value === "") return "ok";
      const expanded = expandSpecifiers(value, FULL_SPECIFIERS, ctx.unit) as { text: string };
      const path = expanded.text.replace(/^-/, "");
      const problem = pathProblem(path);
      return problem === null ? "ok" : warn(ctx, entry, ...pathWords(problem, key, path));
    }
    case "w":
      return checkWorkingDirectory(entry, ctx);
    case "p":
    case "F": {
      if (value === "") return "ok";
      const expanded = expandSpecifiers(value, FULL_SPECIFIERS, ctx.unit) as { text: string };
      const problem = pathProblem(expanded.text);
      if (problem === null) return "ok";
      if (kind === "F") return fatal(ctx, entry, ...pathWords(problem, key, expanded.text, false));
      return warn(ctx, entry, ...pathWords(problem, key, expanded.text));
    }
    case "a":
      return checkPaths(entry, ctx);
    case "q":
      return checkConditionPath(entry, ctx);
    case "d":
      return checkDocumentation(entry, ctx);
    case "k":
    case "K":
      return checkUsers(entry, ctx, kind === "K");
    case "c":
      return checkTimerValue(entry, ctx);
    case "l":
      return checkRlimit(entry, ctx, reject);
    case "D":
      return checkDirectories(entry, ctx);
    case "R":
      return checkNamespacePaths(entry, ctx);
    case "X": {
      if (value === "" || value === "infinity" || parsePermyriad(value, true) !== null) return "ok";
      const tasks = safeAtou(value, 64);
      if (tasks === null) return reject(`“${value}” is not a number of tasks, a percentage or infinity, and systemd ignores the line.`, `“${value}” không phải số tác vụ, phần trăm hay infinity, và systemd bỏ qua dòng này.`);
      if (tasks === 0n || tasks >= MAX_U64) return reject(`TasksMax=${value} is out of range — a limit of no tasks at all would stop the unit — and systemd ignores the line.`, `TasksMax=${value} nằm ngoài khoảng cho phép — giới hạn không tác vụ nào thì unit không chạy nổi — và systemd bỏ qua dòng này.`);
      return "ok";
    }
    case "W": {
      if (value === "" || (value === "idle" && key.includes("CPU"))) return "ok";
      const weight = safeAtou(value, 64);
      if (weight !== null && weight >= 1n && weight <= 10000n) return "ok";
      return reject(
        `${key}= runs from 1 to 10000, with 100 as the default${key.includes("CPU") ? ", or idle" : ""}; systemd ignores “${value}”.`,
        `${key}= chạy từ 1 đến 10000, mặc định là 100${key.includes("CPU") ? ", hoặc idle" : ""}; systemd bỏ qua “${value}”.`,
      );
    }
    case "C":
      checkCapabilities(entry, ctx);
      return "ok";
    default:
      return "ok";
  }
}

function checkRlimit(entry: UnitEntry, ctx: ReadContext, reject: (en: string, vi: string, fix?: string) => "ignored"): Outcome {
  const { key, value } = entry;
  const kind = RLIMIT_KIND[key];
  if (!kind) return "ok";
  const parts = value.split(":");
  const soft = parts.length <= 2 ? rlimitValue(kind, parts[0]!) : null;
  const hard = parts.length === 2 ? rlimitValue(kind, parts[1]!) : soft;
  if (soft === null || hard === null) {
    const what: Record<typeof kind, Both> = {
      u64: both("a count such as 65536, or infinity", "một con số như 65536, hoặc infinity"),
      size: both("a size such as 64M, or infinity", "một dung lượng như 64M, hoặc infinity"),
      sec: both("a time such as 30s or 1h, or infinity", "một khoảng thời gian như 30s hay 1h, hoặc infinity"),
      usec: both("a time such as 500ms, or infinity", "một khoảng thời gian như 500ms, hoặc infinity"),
      nice: both("a nice level from -20 to 19 with its sign, such as -5 or +10, or a raw value up to 40", "một mức nice từ -20 đến 19 kèm dấu, như -5 hay +10, hoặc giá trị thô tới 40"),
    };
    return reject(
      `systemd cannot read “${value}” as ${key}=, which takes ${what[kind].en} — optionally a soft and a hard limit, as in 1024:4096 — and ignores the line.`,
      `systemd không đọc được “${value}” cho ${key}=, vốn nhận ${what[kind].vi} — có thể kèm giới hạn mềm và cứng, như 1024:4096 — và bỏ qua dòng này.`,
    );
  }
  if (soft > hard) {
    return warn(
      ctx,
      entry,
      `The soft limit ${parts[0]} is above the hard limit ${parts[1]} — soft comes first, as in ${parts[1]}:${parts[0]} — and systemd ignores the line.`,
      `Giới hạn mềm ${parts[0]} lớn hơn giới hạn cứng ${parts[1]} — giới hạn mềm đứng trước, như ${parts[1]}:${parts[0]} — và systemd bỏ qua dòng này.`,
      `${key}=${parts[1]}:${parts[0]}`,
    );
  }
  return "ok";
}

function checkDirectories(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") return "ok";
  const tuples = splitWords(value);
  if (tuples === null) return warn(ctx, entry, "A quote in this line is never closed, and systemd ignores the line.", "Một dấu nháy trong dòng này không được đóng lại, và systemd bỏ qua dòng này.");
  const base = DIRECTORY_BASE[key] ?? "/";
  let kept = 0;
  for (const tuple of tuples) {
    const [source = "", destination = "", flags = ""] = tuple.split(":");
    const relative = (path: string): boolean => {
      const expanded = expandSpecifiers(path, FULL_SPECIFIERS, ctx.unit);
      if ("bad" in expanded) {
        warn(ctx, entry, `“${expanded.bad}” is not a specifier systemd knows, so it drops ${tuple} from the line.`, `“${expanded.bad}” không phải specifier systemd biết, nên nó bỏ ${tuple} khỏi dòng.`);
        return false;
      }
      if (expanded.text.startsWith("/")) {
        const inside = expanded.text.startsWith(base) ? expanded.text.slice(base.length) : null;
        warn(
          ctx,
          entry,
          `${key}= takes a name inside ${base}, not an absolute path, so systemd drops ${path}.${inside ? ` Write ${inside}.` : ""}`,
          `${key}= nhận tên thư mục bên trong ${base}, không phải đường dẫn tuyệt đối, nên systemd bỏ ${path}.${inside ? ` Hãy viết ${inside}.` : ""}`,
          inside ? `${key}=${value.replace(path, inside)}` : undefined,
        );
        return false;
      }
      if (pathSimplify(expanded.text).split("/").includes("..")) {
        warn(ctx, entry, `systemd does not take “..” in ${key}=, so it drops ${path}.`, `systemd không nhận “..” trong ${key}=, nên nó bỏ ${path}.`);
        return false;
      }
      return true;
    };
    if (!relative(source)) continue;
    const simple = pathSimplify(source);
    if (simple === "private" || simple.startsWith("private/")) {
      warn(ctx, entry, `${key}= cannot use the name private, which systemd keeps for itself; it drops ${tuple}.`, `${key}= không được dùng tên private, vốn dành riêng cho systemd; nó bỏ ${tuple}.`);
      continue;
    }
    if (destination !== "" && key === "ConfigurationDirectory") {
      warn(ctx, entry, `ConfigurationDirectory= takes no second path after a colon; systemd drops ${tuple}.`, `ConfigurationDirectory= không nhận đường dẫn thứ hai sau dấu hai chấm; systemd bỏ ${tuple}.`);
      continue;
    }
    if (destination !== "" && !relative(destination)) continue;
    if (flags !== "" && flags !== "ro") {
      warn(ctx, entry, `“${flags}” is not a flag systemd knows here — the only one is ro — so it drops ${tuple}.`, `“${flags}” không phải cờ systemd biết ở đây — chỉ có ro — nên nó bỏ ${tuple}.`);
      continue;
    }
    kept += 1;
  }
  return tuples.length > 0 && kept === 0 ? "ignored" : "ok";
}

function checkNamespacePaths(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") return "ok";
  const words = splitWords(value);
  if (words === null) return warn(ctx, entry, "A quote in this line is never closed, and systemd ignores the line.", "Một dấu nháy trong dòng này không được đóng lại, và systemd bỏ qua dòng này.");
  let kept = 0;
  for (const word of words) {
    let path = word;
    if (path.startsWith("-")) path = path.slice(1);
    if (path.startsWith("+")) path = path.slice(1);
    const expanded = expandSpecifiers(path, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) {
      warn(ctx, entry, `“${expanded.bad}” is not a specifier systemd knows, so it drops ${word} from the line.`, `“${expanded.bad}” không phải specifier systemd biết, nên nó bỏ ${word} khỏi dòng.`);
      continue;
    }
    const problem = pathProblem(expanded.text);
    if (problem === null) {
      kept += 1;
      continue;
    }
    const prefixes = /^\+-/.test(word);
    warn(
      ctx,
      entry,
      prefixes ? `In ${word} the prefixes are the wrong way round: - comes before +, as in -+${word.slice(2)}. systemd drops it from the line.` : pathWords(problem, key, expanded.text)[0],
      prefixes ? `Trong ${word} các tiền tố bị đảo ngược: - đứng trước +, như -+${word.slice(2)}. systemd bỏ nó khỏi dòng.` : pathWords(problem, key, expanded.text)[1],
      prefixes ? `${key}=${value.replace(word, `-+${word.slice(2)}`)}` : undefined,
    );
  }
  return words.length > 0 && kept === 0 ? "ignored" : "ok";
}

/** capability_set_from_string() drops names it does not know, with nothing in the log above debug level. */
function checkCapabilities(entry: UnitEntry, ctx: ReadContext): void {
  const { key, value } = entry;
  const words = splitWords(value.startsWith("~") ? value.slice(1) : value) ?? value.replace(/^~/, "").split(/\s+/);
  for (const word of words) {
    if (word === "") continue;
    const number = safeAtoi(word, 64);
    if (number !== null ? number >= 0n && number <= 62n : CAPABILITIES.includes(word.toUpperCase())) continue;
    const upper = word.toUpperCase();
    const near = closest(upper.startsWith("CAP_") ? upper : `CAP_${upper}`, CAPABILITIES) ?? CAPABILITIES.find((cap) => cap.startsWith(upper.startsWith("CAP_") ? upper : `CAP_${upper}`)) ?? null;
    advise(
      ctx,
      entry,
      "warning",
      `${word} is not a capability systemd knows, and it leaves it out without a word in the log — so ${key}= ${key === "AmbientCapabilities" ? "does not grant it" : "does not keep it"}.${near ? ` Did you mean ${near}?` : ""}`,
      `${word} không phải capability mà systemd biết, và nó lặng lẽ bỏ qua, không ghi gì vào log — nên ${key}= ${key === "AmbientCapabilities" ? "không cấp quyền đó" : "không giữ quyền đó"}.${near ? ` Có phải ý bạn là ${near}?` : ""}`,
      near ? `${key}=${value.replace(word, near)}` : undefined,
    );
  }
}

function pathWords(problem: PathProblem, key: string, path: string, ignoring = true): [string, string] {
  const en = ignoring ? ", and systemd ignores the line." : ".";
  const vi = ignoring ? ", và systemd bỏ qua dòng này." : ".";
  if (problem === "relative") return [`${key}= needs an absolute path, starting with /, and “${path}” is not one${en}`, `${key}= cần đường dẫn tuyệt đối, bắt đầu bằng /, mà “${path}” không phải${vi}`];
  if (problem === "dotdot") return [`systemd does not take “..” in a ${key}= path: write “${path}” without it${en}`, `systemd không nhận “..” trong đường dẫn của ${key}=: hãy viết “${path}” không có nó${vi}`];
  return [`The path in ${key}= is too long${en}`, `Đường dẫn trong ${key}= quá dài${vi}`];
}

function sizeFix(key: string, value: string): string | undefined {
  const unit = /^(\d+(?:\.\d+)?)\s*([kmgtpe])(?:i?b)$/i.exec(value) ?? /^(\d+(?:\.\d+)?)\s*([kmgtpe])$/.exec(value);
  return unit ? `${key}=${unit[1]}${unit[2]!.toUpperCase()}` : undefined;
}

function sizeAdvice(value: string): Both {
  return both(
    `systemd cannot read “${value}” as a size, and ignores the line. A size is a number with K, M, G, T, P or E after it — powers of 1024 — in capitals and nothing more: 512M, 1G, 1.5G.`,
    `systemd không đọc được “${value}” là dung lượng, và bỏ qua dòng này. Dung lượng là một số kèm K, M, G, T, P hoặc E phía sau — luỹ thừa của 1024 — viết hoa và không thêm gì khác: 512M, 1G, 1.5G.`,
  );
}

function checkMemory(entry: UnitEntry, reject: (en: string, vi: string, fix?: string) => "ignored"): Outcome {
  const { key, value } = entry;
  if (value === "" || value === "infinity") return "ok";
  const permyriad = parsePermyriad(value, true);
  let bytes: bigint;
  if (permyriad !== null) {
    bytes = BigInt(permyriad);
  } else {
    const size = parseSize(value);
    if (size === null) {
      const advice = sizeAdvice(value);
      return reject(
        `${advice.en} Memory limits also take a percentage of RAM, or infinity.`,
        `${advice.vi} Giới hạn bộ nhớ còn nhận phần trăm RAM, hoặc infinity.`,
        sizeFix(key, value),
      );
    }
    bytes = size;
  }
  const zeroOk = ["MemorySwapMax", "StartupMemorySwapMax", "MemoryZSwapMax", "StartupMemoryZSwapMax", "MemoryLow", "StartupMemoryLow", "MemoryMin", "DefaultMemoryLow", "DefaultMemoryMin"];
  if (bytes >= MAX_U64 || (bytes === 0n && !zeroOk.includes(key))) {
    return reject(
      `${value} is out of range for ${key}=: a limit of nothing would stop the unit outright, so systemd ignores the line.`,
      `${value} nằm ngoài khoảng cho phép của ${key}=: giới hạn bằng 0 thì unit không chạy nổi, nên systemd bỏ qua dòng này.`,
    );
  }
  return "ok";
}

function checkChoice(entry: UnitEntry, ctx: ReadContext, reject: (en: string, vi: string, fix?: string) => "ignored"): Outcome {
  const { key, value } = entry;
  const choice = CHOICES[key];
  if (!choice) return "ok";
  if (value === "" && choice.empty) return "ok";
  if (key === "ProtectHostname" && value.includes(":")) {
    const colon = value.indexOf(":");
    const host = expandSpecifiers(value.slice(colon + 1), FULL_SPECIFIERS, ctx.unit);
    if ("bad" in host) return warn(ctx, entry, `“${host.bad}” is not a specifier systemd knows, and it ignores the line.`, `“${host.bad}” không phải specifier systemd biết, và nó bỏ qua dòng này.`);
    if (!hostnameIsValid(host.text)) {
      return warn(
        ctx,
        entry,
        `“${host.text}” is not a valid host name — letters, digits and hyphens, in parts separated by dots — and systemd ignores the line.`,
        `“${host.text}” không phải tên máy hợp lệ — chữ cái, chữ số và dấu gạch ngang, theo từng phần cách nhau bằng dấu chấm — và systemd bỏ qua dòng này.`,
      );
    }
    const mode = value.slice(0, colon);
    if (mode === "private" || parseBoolean(mode) === true) return "ok";
    return reject(
      `ProtectHostname= takes a host name only after yes or private, as in private:${host.text}; systemd ignores the line.`,
      `ProtectHostname= chỉ nhận tên máy sau yes hoặc private, như private:${host.text}; systemd bỏ qua dòng này.`,
      `ProtectHostname=private:${host.text}`,
    );
  }
  const number = choice.numbers !== undefined ? safeAtou(value) : null;
  const accepted =
    choice.words.includes(value) || (choice.bool === true && parseBoolean(value) !== null) || (number !== null && number <= BigInt(choice.numbers ?? 0));
  if (!accepted) {
    const list = [...(choice.bool ? ["yes", "no"] : []), ...choice.words];
    const near = closest(value, [...choice.words, ...(choice.bool ? BOOLEAN_WORDS : [])]);
    return reject(
      `${key}= does not take “${value}”, and systemd ignores the line. It takes ${list.join(", ")}.${near ? ` Did you mean ${near}?` : ""}`,
      `${key}= không nhận “${value}”, và systemd bỏ qua dòng này. Giá trị hợp lệ: ${list.join(", ")}.${near ? ` Có phải ý bạn là ${near}?` : ""}`,
      near ? `${key}=${near}` : undefined,
    );
  }
  if (key === "KillMode" && value === "none") {
    push(
      ctx,
      entry,
      "warning",
      "line",
      "warning",
      "KillMode=none is unsafe and deprecated: systemd stops managing the service's processes, which can outlive it. Use mixed or control-group.",
      "KillMode=none không an toàn và đã lỗi thời: systemd thôi quản lý các tiến trình của service, khiến chúng có thể sống sót sau khi service dừng. Hãy dùng mixed hoặc control-group.",
      "KillMode=mixed",
    );
  }
  return "ok";
}

function checkStdio(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  const output = entry.info!.kind === "O";
  const words = output
    ? ["inherit", "null", "tty", "journal", "kmsg", "journal+console", "kmsg+console", "socket", "fd", "file", "append", "truncate"]
    : ["null", "tty", "tty-force", "tty-fail", "socket", "fd", "data", "file"];
  const named = ["fd", "file", "append", "truncate"];
  const badSpecifier = (bad: string) =>
    warn(ctx, entry, `“${bad}” is not a specifier systemd knows, and it ignores the line. Write %% for a literal %.`, `“${bad}” không phải specifier systemd biết, và nó bỏ qua dòng này. Dấu % thật phải viết là %%.`);

  const fd = /^fd:(.*)$/.exec(value);
  if (fd) {
    const name = expandSpecifiers(fd[1]!, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in name) return badSpecifier(name.bad);
    if (/[\u0000-\u001f\u007f-\uffff:]/.test(name.text) || name.text.length > 255) {
      return warn(ctx, entry, `“${name.text}” is not a valid file descriptor name — no colons or control characters — and systemd ignores the line.`, `“${name.text}” không phải tên file descriptor hợp lệ — không có dấu hai chấm hay ký tự điều khiển — và systemd bỏ qua dòng này.`);
    }
    return "ok";
  }
  if (output && (value === "syslog" || value === "syslog+console")) {
    push(
      ctx,
      entry,
      "note",
      "line",
      "notice",
      `${value} is obsolete: systemd reads it as ${value.replace("syslog", "journal")}, which is the default anyway — the line can go.`,
      `${value} đã lỗi thời: systemd đọc nó như ${value.replace("syslog", "journal")}, vốn là mặc định — có thể bỏ dòng này.`,
      `${key}=${value.replace("syslog", "journal")}`,
    );
    return "ok";
  }
  const file = /^(file|append|truncate):(.*)$/.exec(value);
  if (file && (output || file[1] === "file")) {
    const expanded = expandSpecifiers(file[2]!, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) return badSpecifier(expanded.bad);
    const problem = pathProblem(expanded.text);
    if (problem === null) return "ok";
    const [en, vi] = pathWords(problem, `${key}=${file[1]}:`, expanded.text);
    push(ctx, entry, "warning", "line", "error", en.replace(`${key}=${file[1]}:=`, `${key}=${file[1]}:`), vi.replace(`${key}=${file[1]}:=`, `${key}=${file[1]}:`));
    return "ignored";
  }
  if (words.includes(value)) return "ok";
  const near = closest(value, words);
  const listed = words.filter((word) => !named.includes(word)).join(", ");
  return warn(
    ctx,
    entry,
    `${key}= does not take “${value}”, and systemd ignores the line. It takes ${listed}, fd:name or file:/path${output ? ", append:/path or truncate:/path" : ""}.${near ? ` Did you mean ${near}?` : ""}`,
    `${key}= không nhận “${value}”, và systemd bỏ qua dòng này. Giá trị hợp lệ: ${listed}, fd:tên hoặc file:/đường-dẫn${output ? ", append:/đường-dẫn hoặc truncate:/đường-dẫn" : ""}.${near ? ` Có phải ý bạn là ${near}?` : ""}`,
    near ? `${key}=${near}` : undefined,
  );
}

/** Targets people write without their suffix. */
const BARE_TARGETS = new Set(["network", "network-online", "multi-user", "graphical", "timers", "sockets", "default", "basic", "sysinit", "local-fs", "remote-fs", "time-sync", "nss-lookup", "paths", "shutdown", "rescue", "emergency"]);

function guessUnitName(name: string, key: string): string | null {
  if (!/^[A-Za-z0-9:_.@-]+$/.test(name) || /\.[a-z]+$/.test(name)) return null;
  if (BARE_TARGETS.has(name)) return `${name}.target`;
  return `${name}.${key === "Sockets" ? "socket" : "service"}`;
}

function checkDependency(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (entry.info!.kind === "o") {
    const now = key.replace("Overridable", "");
    push(ctx, entry, "warning", "line", "warning", `${key}= is obsolete: systemd reads it as ${now}=, and says so in the log.`, `${key}= đã lỗi thời: systemd đọc nó như ${now}=, và ghi chú điều đó vào log.`, `${now}=${value}`);
  }
  const words = splitWords(value);
  if (words === null) return warn(ctx, entry, "A quote in this line is never closed, and systemd ignores the line.", "Một dấu nháy trong dòng này không được đóng lại, và systemd bỏ qua dòng này.");
  let kept = 0;
  for (const word of words) {
    const expanded = expandSpecifiers(word, NAME_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) {
      warn(
        ctx,
        entry,
        `“${expanded.bad}” cannot be used in a unit name — only specifiers such as %i, %n and %p can — so systemd drops ${word} from the line.`,
        `“${expanded.bad}” không dùng được trong tên unit — chỉ các specifier như %i, %n và %p — nên systemd bỏ ${word} khỏi dòng.`,
      );
      continue;
    }
    const valid = unitNameIsValid(expanded.text);
    if (valid && key === "Sockets" && !expanded.text.endsWith(".socket")) {
      warn(ctx, entry, `Sockets= takes .socket units, and ${word} is not one; systemd drops it from the line.`, `Sockets= chỉ nhận unit .socket, mà ${word} không phải; systemd bỏ nó khỏi dòng.`);
      continue;
    }
    if (valid) {
      kept += 1;
      continue;
    }
    const guess = guessUnitName(word, key);
    warn(
      ctx,
      entry,
      `“${word}” is not a unit name — a unit name ends in its type, such as .service or .target — so systemd drops it from the line.${guess ? ` Did you mean ${guess}?` : ""}`,
      `“${word}” không phải tên unit — tên unit phải có phần đuôi chỉ loại, như .service hay .target — nên systemd bỏ nó khỏi dòng.${guess ? ` Có phải ý bạn là ${guess}?` : ""}`,
      guess ? `${key}=${value.replace(word, guess)}` : undefined,
    );
  }
  return words.length > 0 && kept === 0 ? "ignored" : "ok";
}

function checkTrigger(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  const expanded = expandSpecifiers(value, NAME_SPECIFIERS, ctx.unit);
  if ("bad" in expanded) return warn(ctx, entry, `“${expanded.bad}” cannot be used in a unit name, and systemd ignores the line.`, `“${expanded.bad}” không dùng được trong tên unit, và systemd bỏ qua dòng này.`);
  const name = expanded.text;
  if (key === "Slice") {
    if (unitNameIsValid(name) && name.endsWith(".slice")) return "ok";
    return warn(
      ctx,
      entry,
      `Slice= takes a .slice unit, such as system.slice or my-app.slice, and “${value}” is not one; systemd ignores the line.`,
      `Slice= nhận một unit .slice, như system.slice hay my-app.slice, mà “${value}” không phải; systemd bỏ qua dòng này.`,
      /^[A-Za-z0-9:_.@-]+$/.test(name) && !name.includes(".") ? `Slice=${name}.slice` : undefined,
    );
  }
  const dot = name.lastIndexOf(".");
  if (dot < 0 || !(UNIT_TYPES as readonly string[]).includes(name.slice(dot + 1))) {
    const guess = guessUnitName(name, key);
    return warn(
      ctx,
      entry,
      `“${value}” is not a unit name with its type, such as backup.service, and systemd ignores the line.${guess ? ` Did you mean ${guess}?` : ""}`,
      `“${value}” không phải tên unit có phần đuôi chỉ loại, như backup.service, và systemd bỏ qua dòng này.${guess ? ` Có phải ý bạn là ${guess}?` : ""}`,
      guess ? `${key}=${guess}` : undefined,
    );
  }
  if (name === ctx.unit) return warn(ctx, entry, "A unit cannot trigger itself, and systemd ignores the line.", "Một unit không thể tự kích hoạt chính nó, và systemd bỏ qua dòng này.");
  if (!unitNameIsValid(name)) return warn(ctx, entry, `“${value}” is not a valid unit name, and systemd ignores the line.`, `“${value}” không phải tên unit hợp lệ, và systemd bỏ qua dòng này.`);
  return "ok";
}

function checkEnvironment(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { value } = entry;
  if (value === "") return "ok";
  let kept = 0;
  for (let p = 0; ; ) {
    const next = extractWord(value, p);
    if (next === "einval") {
      warn(
        ctx,
        entry,
        "systemd cannot split this line into assignments — a quote is never closed, or a backslash starts a sequence it does not know — and it ignores the rest of the line.",
        "systemd không tách được dòng này thành các phép gán — một dấu nháy không được đóng, hoặc dấu gạch chéo ngược mở đầu một chuỗi nó không biết — và nó bỏ qua phần còn lại của dòng.",
      );
      return kept === 0 ? "ignored" : "ok";
    }
    if (next === null) break;
    p = next.next;
    const expanded = expandSpecifiers(next.word, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) {
      warn(ctx, entry, `“${expanded.bad}” in ${next.word} is not a specifier systemd knows, so it skips that assignment. Write %% for a literal %.`, `“${expanded.bad}” trong ${next.word} không phải specifier systemd biết, nên nó bỏ qua phép gán đó. Dấu % thật phải viết là %%.`);
      continue;
    }
    const assignment = expanded.text;
    const eq = assignment.indexOf("=");
    const name = eq >= 0 ? assignment.slice(0, eq) : assignment;
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      const spaced = eq < 0 && kept > 0;
      warn(
        ctx,
        entry,
        `“${assignment}” is not a NAME=value assignment, so systemd skips it.${spaced ? " Assignments are separated by spaces: a value with a space in it needs the whole assignment in quotes, as in Environment=\"GREETING=hello world\"." : eq > 0 ? " A name is letters, digits and _, not starting with a digit." : ""}`,
        `“${assignment}” không phải phép gán NAME=value, nên systemd bỏ qua nó.${spaced ? " Các phép gán cách nhau bằng dấu cách: giá trị có dấu cách thì cả phép gán phải nằm trong ngoặc kép, như Environment=\"GREETING=hello world\"." : eq > 0 ? " Tên biến gồm chữ cái, chữ số và _, không bắt đầu bằng chữ số." : ""}`,
      );
      continue;
    }
    kept += 1;
  }
  return kept === 0 ? "ignored" : "ok";
}

function checkWorkingDirectory(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") return "ok";
  const missingOk = value.startsWith("-");
  const path = missingOk ? value.slice(1) : value;
  if (path === "~") return "ok";
  const expanded = expandSpecifiers(path, FULL_SPECIFIERS, ctx.unit);
  if ("bad" in expanded) {
    const en = `“${expanded.bad}” is not a specifier systemd knows.`;
    const vi = `“${expanded.bad}” không phải specifier systemd biết.`;
    if (!missingOk) return fatal(ctx, entry, en, vi);
    return warn(ctx, entry, `${en} The - in front makes systemd ignore the line instead.`, `${vi} Dấu - phía trước khiến systemd bỏ qua dòng này thay vì báo lỗi.`);
  }
  const problem = pathProblem(expanded.text);
  if (problem === null) return "ok";
  if (missingOk) return warn(ctx, entry, ...pathWords(problem, key, expanded.text));
  const [en, vi] = pathWords(problem, key, expanded.text, false);
  return problem === "relative"
    ? fatal(ctx, entry, `${en.slice(0, -1)} — or ~ for the user's home.`, `${vi.slice(0, -1)} — hoặc ~ cho thư mục nhà của người dùng.`)
    : fatal(ctx, entry, en, vi);
}

function checkPaths(entry: UnitEntry, ctx: ReadContext): Outcome {
  const words = splitWords(entry.value);
  if (words === null) return warn(ctx, entry, "A quote in this line is never closed, and systemd ignores the line.", "Một dấu nháy trong dòng này không được đóng lại, và systemd bỏ qua dòng này.");
  let kept = 0;
  for (const word of words) {
    const expanded = expandSpecifiers(word, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) {
      warn(ctx, entry, `“${expanded.bad}” is not a specifier systemd knows, so it drops ${word} from the line.`, `“${expanded.bad}” không phải specifier systemd biết, nên nó bỏ ${word} khỏi dòng.`);
      continue;
    }
    const problem = pathProblem(expanded.text);
    if (problem === null) kept += 1;
    else warn(ctx, entry, ...pathWords(problem, entry.key, expanded.text));
  }
  return words.length > 0 && kept === 0 ? "ignored" : "ok";
}

function checkConditionPath(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") return "ok";
  let rest = value;
  if (rest.startsWith("|")) rest = rest.slice(1);
  if (rest.startsWith("!")) rest = rest.slice(1);
  const expanded = expandSpecifiers(rest, FULL_SPECIFIERS, ctx.unit);
  if ("bad" in expanded) return warn(ctx, entry, `“${expanded.bad}” is not a specifier systemd knows, and it ignores the line.`, `“${expanded.bad}” không phải specifier systemd biết, và nó bỏ qua dòng này.`);
  const problem = pathProblem(expanded.text);
  return problem === null ? "ok" : warn(ctx, entry, ...pathWords(problem, key, expanded.text));
}

function checkDocumentation(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") return "ok";
  const words = splitWords(value);
  if (words === null) return warn(ctx, entry, "A quote in this line is never closed, and systemd ignores the line.", "Một dấu nháy trong dòng này không được đóng lại, và systemd bỏ qua dòng này.");
  let kept = 0;
  for (const url of words) {
    if (documentationUrlIsValid(url)) {
      kept += 1;
      continue;
    }
    const web = /^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/.test(url) ? `https://${url}` : null;
    warn(
      ctx,
      entry,
      `“${url}” is not a link systemd accepts — it wants http://, https://, file:/, info: or man: — so it drops it.${web ? ` Write ${web}.` : ""}`,
      `“${url}” không phải liên kết systemd chấp nhận — nó cần http://, https://, file:/, info: hoặc man: — nên nó bỏ liên kết này.${web ? ` Hãy viết ${web}.` : ""}`,
      web ? `${key}=${value.replace(url, web)}` : undefined,
    );
  }
  return kept === 0 ? "ignored" : "ok";
}

function checkUsers(entry: UnitEntry, ctx: ReadContext, many: boolean): Outcome {
  const { key, value } = entry;
  if (value === "") return "ok";
  for (const word of many ? value.split(/[ \t\n\r]+/).filter((part) => part !== "") : [value]) {
    const expanded = expandSpecifiers(word, FULL_SPECIFIERS, ctx.unit);
    if ("bad" in expanded) return fatal(ctx, entry, `“${expanded.bad}” is not a specifier systemd knows.`, `“${expanded.bad}” không phải specifier systemd biết.`);
    const validity = userNameValidity(expanded.text);
    const specifiers = word.includes("%");
    if (validity === null) {
      if (specifiers && expanded.text === "") {
        return fatal(
          ctx,
          entry,
          `${word} comes out empty in this unit — %i is the instance, the part after @ in a name like app@1.service, and ${ctx.unit} has none — and an empty name is not a user.`,
          `${word} thành chuỗi rỗng trong unit này — %i là phần instance, phần sau @ trong tên như app@1.service, mà ${ctx.unit} không có — và tên rỗng không phải người dùng.`,
        );
      }
      return fatal(
        ctx,
        entry,
        `“${expanded.text}”${specifiers ? `, which ${word} becomes here,` : ""} is not a user or group name systemd accepts — no colons, slashes or spaces at either end, and a number must be a real ID.`,
        `“${expanded.text}”${specifiers ? `, giá trị của ${word} ở đây,` : ""} không phải tên người dùng hay nhóm mà systemd chấp nhận — không có dấu hai chấm, gạch chéo hay dấu cách ở hai đầu, và số thì phải là ID thật.`,
      );
    }
    if (specifiers) continue;
    if (validity === "relaxed") {
      advise(
        ctx,
        entry,
        "note",
        `“${expanded.text}” is not a portable user or group name — letters, digits, _ and -, starting with a letter or _, at most 31 characters. systemd accepts it, with a notice in the log.`,
        `“${expanded.text}” không phải tên người dùng hay nhóm chuẩn — chữ cái, chữ số, _ và -, bắt đầu bằng chữ cái hoặc _, tối đa 31 ký tự. systemd vẫn nhận, kèm một ghi chú trong log.`,
      );
    }
    if (key === "User" && expanded.text === "nobody") {
      push(
        ctx,
        entry,
        "warning",
        "line",
        "notice",
        "User=nobody is not safe: nobody owns files that other services may share, so a compromised service can reach them. Use DynamicUser=yes, or a user of the service's own.",
        "User=nobody không an toàn: nobody là chủ của những file mà các service khác có thể dùng chung, nên một service bị chiếm quyền có thể chạm tới chúng. Hãy dùng DynamicUser=yes, hoặc một người dùng riêng cho service.",
        "DynamicUser=yes",
      );
    }
  }
  return "ok";
}

const SHELL_WORDS = new Set(["|", "||", "&&", ">", ">>", "<", "2>&1", "&>", "1>&2", "&", "2>", "2>>", "<<<"]);

/** config_parse_exec(): what systemd keeps of a command line, and what it says about it. */
function checkExec(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") {
    if (ctx.dropIn) {
      advise(ctx, entry, "note", `An empty ${key}= clears the commands set before it — what a drop-in does before setting its own.`, `${key}= để trống sẽ xoá các lệnh đặt trước đó — việc một drop-in làm trước khi đặt lệnh của riêng nó.`);
    }
    return "ok";
  }
  let commands = 0;
  let separators = 0;
  const finish = (stop: "fatal" | "dropped" | null): Outcome => {
    entry.commands = commands;
    if (stop === "fatal") return "fatal";
    if (stop === null && separators > 0 && commands > 1) {
      advise(
        ctx,
        entry,
        "note",
        `A lone “;” splits this into ${commands} commands, a form systemd keeps only for old unit files. One command per ${key}= line is clearer${key === "ExecStart" ? " — and only Type=oneshot may have more than one" : ""}.`,
        `Dấu “;” đứng riêng tách dòng này thành ${commands} lệnh, cách viết systemd chỉ giữ cho file unit cũ. Mỗi dòng ${key}= một lệnh sẽ rõ ràng hơn${key === "ExecStart" ? " — và chỉ Type=oneshot mới được có nhiều hơn một lệnh" : ""}.`,
      );
    }
    return commands > 0 ? "ok" : "ignored";
  };
  const unknownEscape = (word: string) =>
    push(
      ctx,
      entry,
      "warning",
      "line",
      "warning",
      `“${word}” has a backslash sequence systemd does not know, so it keeps the backslash as written. Write \\\\ for a literal backslash.`,
      `“${word}” có chuỗi gạch chéo ngược mà systemd không biết, nên nó giữ nguyên dấu gạch chéo ngược. Dấu gạch chéo ngược thật phải viết là \\\\.`,
    );
  const unbalanced = () =>
    push(ctx, entry, "warning", "line", "error", "A quote in this command is never closed, and systemd ignores the line.", "Một dấu nháy trong lệnh này không được đóng lại, và systemd bỏ qua dòng này.");

  let p = 0;
  let semicolon: boolean;
  do {
    semicolon = false;
    const first = extractWordAndWarn(value, p);
    if (first === null) break;
    if (first === "unbalanced") {
      unbalanced();
      return finish("dropped");
    }
    if (first.unknownEscape) unknownEscape(first.word);
    p = first.next;
    if (first.word === ";") {
      semicolon = true;
      separators += 1;
      continue;
    }

    // The prefixes, each at most once, in any order.
    let f = 0;
    let ignore = false;
    let argv0 = false;
    let noEnv = false;
    let shell = false;
    let full = false;
    let noSetuid = false;
    let ambient = false;
    for (;; f += 1) {
      const c = first.word[f];
      if (c === "-" && !ignore) ignore = true;
      else if (c === "@" && !argv0) argv0 = true;
      else if (c === ":" && !noEnv) noEnv = true;
      else if (c === "|" && !shell) shell = true;
      else if (c === "+" && !full && !noSetuid && !ambient) full = true;
      else if (c === "!" && !full && !noSetuid && !ambient) noSetuid = true;
      else if (c === "!" && !full && !ambient) {
        noSetuid = false;
        ambient = true;
        push(ctx, entry, "note", "line", "notice", "The !! prefix is no longer supported, and systemd ignores it; remove it.", "Tiền tố !! không còn được hỗ trợ, và systemd bỏ qua nó; hãy xoá đi.", `${key}=${value.replace("!!", "")}`);
      } else break;
    }
    const refuse = (en: string, vi: string, fix?: string): Outcome => {
      if (!ignore) {
        fatal(ctx, entry, en, vi, fix);
        return finish("fatal");
      }
      push(ctx, entry, "warning", "line", "warning", `${en} The - in front makes systemd skip the command instead.`, `${vi} Dấu - phía trước khiến systemd bỏ qua lệnh này thay vì báo lỗi.`, fix);
      return finish("dropped");
    };
    const rest = first.word.slice(f);
    const args: string[] = [];
    let path: string;
    if (shell) {
      path = "/bin/sh";
      args.push(argv0 ? "-sh" : "sh");
      if (rest !== "") args.push(rest);
    } else {
      const expanded = expandSpecifiers(rest, FULL_SPECIFIERS, ctx.unit);
      if ("bad" in expanded) {
        return refuse(
          `“${expanded.bad}” in ${rest} is not a specifier systemd knows: a percent sign in a unit file starts one. Write %% for a literal %.`,
          `“${expanded.bad}” trong ${rest} không phải specifier systemd biết: trong file unit, dấu phần trăm mở đầu một specifier. Dấu % thật phải viết là %%.`,
        );
      }
      path = expanded.text;
      if (path === "") return refuse("The command is empty after its prefixes.", "Lệnh trống sau phần tiền tố.");
      if (/[\u0000-\u001f\u007f'"\\]/.test(path)) {
        return refuse(`The program path ${path} has a character systemd refuses there — a quote, a backslash or a control character.`, `Đường dẫn chương trình ${path} có ký tự systemd không nhận ở đó — dấu nháy, gạch chéo ngược hoặc ký tự điều khiển.`);
      }
      if (path === "." || path === ".." || /\/(?:\.\.?)?$/.test(path)) return refuse(`${path} is a directory, not a program.`, `${path} là thư mục, không phải chương trình.`);
      const valid = path.startsWith("/") ? path.length < 4096 && path.split("/").every((part) => part.length <= 255) : !path.includes("/") && path.length <= 255;
      if (!valid) {
        const program = path.slice(path.lastIndexOf("/") + 1);
        return refuse(
          `${path} is a relative path, which systemd does not take: write the program's absolute path, such as /usr/local/bin/${program}, or its bare name for systemd to look up.`,
          `${path} là đường dẫn tương đối, systemd không chấp nhận: hãy viết đường dẫn tuyệt đối của chương trình, như /usr/local/bin/${program}, hoặc chỉ tên chương trình để systemd tự tìm.`,
        );
      }
      if (!argv0) args.push(path);
    }

    const words: string[] = [];
    while (p < value.length) {
      if (value[p] === ";" && (p + 1 === value.length || isWhitespace(value[p + 1]))) {
        p += 1;
        while (isWhitespace(value[p])) p += 1;
        semicolon = true;
        separators += 1;
        break;
      }
      if (value[p] === "\\" && value[p + 1] === ";" && (p + 2 === value.length || isWhitespace(value[p + 2]))) {
        p += 2;
        while (isWhitespace(value[p])) p += 1;
        args.push(";");
        continue;
      }
      const start = p;
      const word = extractWordAndWarn(value, p);
      if (word === "unbalanced") {
        if (!ignore) {
          fatal(ctx, entry, "A quote in this command is never closed.", "Một dấu nháy trong lệnh này không được đóng lại.");
          return finish("fatal");
        }
        unbalanced();
        return finish("dropped");
      }
      if (word === null) break;
      if (word.unknownEscape) unknownEscape(word.word);
      p = word.next;
      const raw = value.slice(start, word.next).trim();
      const expanded = expandSpecifiers(word.word, FULL_SPECIFIERS, ctx.unit);
      if ("bad" in expanded) {
        return refuse(
          `“${expanded.bad}” in ${raw} is not a specifier systemd knows: a percent sign in a unit file starts one. Write %% for a literal %, as in date +%%F.`,
          `“${expanded.bad}” trong ${raw} không phải specifier systemd biết: trong file unit, dấu phần trăm mở đầu một specifier. Dấu % thật phải viết là %%, như date +%%F.`,
          `${key}=${value.replace(raw, doublePercents(raw))}`,
        );
      }
      args.push(expanded.text);
      words.push(raw);
    }
    if (args.length === 0) {
      return refuse("The command has no program name: @ takes the next word as the name the program sees, and there is none.", "Lệnh không có tên chương trình: @ lấy từ kế tiếp làm tên mà chương trình thấy, và không có từ nào.");
    }
    commands += 1;
    adviseCommand(entry, ctx, { shell, ignore, path, firstWord: first.word, words });
  } while (semicolon);

  return finish(null);
}

/** Things that parse but rarely do what was meant: shell syntax, date formats, sudo. */
function adviseCommand(entry: UnitEntry, ctx: ReadContext, command: { shell: boolean; ignore: boolean; path: string; firstWord: string; words: readonly string[] }): void {
  const { key, value } = entry;
  const program = command.path.slice(command.path.lastIndexOf("/") + 1);

  // Specifiers that look like date formats are replaced before the program runs.
  for (const raw of [command.firstWord, ...command.words]) {
    const letters = specifierLetters(raw).filter((letter) => letter in DATE_LOOKALIKES);
    if (letters.length === 0) continue;
    const datey = program === "date" || /^["']?\+/.test(raw) || specifierLetters(raw).filter((letter) => "YmdHMS".includes(letter)).length >= 2;
    if (!datey) continue;
    const list = (lang: "en" | "vi") => letters.map((letter) => `%${letter} ${lang === "en" ? "becomes" : "thành"} ${DATE_LOOKALIKES[letter]![lang]}`).join(", ");
    const doubled = doublePercents(raw);
    advise(
      ctx,
      entry,
      "warning",
      `${raw} looks like a date format, but systemd expands those letters itself before the command runs: ${list("en")}. Double each % — ${doubled} — to pass them through.`,
      `${raw} trông như định dạng ngày, nhưng systemd tự thay các chữ đó trước khi lệnh chạy: ${list("vi")}. Hãy nhân đôi từng dấu % — ${doubled} — để giữ nguyên.`,
      `${key}=${value.replace(raw, doubled)}`,
    );
  }

  if (!command.shell) {
    const shellish = command.words.filter((raw) => !/^["']/.test(raw) && (SHELL_WORDS.has(raw) || /^(?:\d?>>?|<|&>)\S/.test(raw) || /\$\(|`/.test(raw)));
    if (shellish.length > 0) {
      const background = command.words[command.words.length - 1] === "&";
      const words = command.words.slice(0, background ? -1 : undefined);
      advise(
        ctx,
        entry,
        "warning",
        `“${shellish.join(" ")}” is shell syntax, but no shell runs this command: systemd passes it to ${program} as plain arguments. Run it through a shell — /bin/sh -c '…' — or send output with StandardOutput= instead.${background ? " A trailing & does not put the program in the background either: leave it in the foreground, as keeping it running is systemd's job." : ""}`,
        `“${shellish.join(" ")}” là cú pháp shell, nhưng không có shell nào chạy lệnh này: systemd truyền nó cho ${program} như tham số thường. Hãy chạy qua shell — /bin/sh -c '…' — hoặc chuyển đầu ra bằng StandardOutput=.${background ? " Dấu & ở cuối cũng không đưa chương trình chạy nền: hãy để nó chạy ở foreground, vì giữ nó chạy là việc của systemd." : ""}`,
        `${key}=${command.ignore ? "-" : ""}${words.length > 0 && words.every((raw) => !SHELL_WORDS.has(raw) && !/^(?:\d?>>?|<|&>)\S/.test(raw) && !/\$\(|`/.test(raw)) ? [command.path, ...words].join(" ") : `/bin/sh -c '${[command.path, ...words].join(" ").replace(/'/g, `'\\''`)}'`}`,
      );
    }
    if (!command.path.startsWith("/") && program !== "sudo") {
      advise(
        ctx,
        entry,
        "note",
        `${command.path} is a bare name: systemd looks it up in its own fixed search path (/usr/local/sbin, /usr/local/bin, /usr/sbin, /usr/bin), not in your PATH. An absolute path is clearer.`,
        `${command.path} chỉ là tên chương trình: systemd tìm nó trong đường dẫn tìm kiếm cố định của riêng mình (/usr/local/sbin, /usr/local/bin, /usr/sbin, /usr/bin), không phải PATH của bạn. Viết đường dẫn tuyệt đối sẽ rõ ràng hơn.`,
      );
    }
  }
  if (program === "sudo") {
    advise(
      ctx,
      entry,
      "note",
      "sudo is not needed here: a system service runs as root unless User= says otherwise, and sudo may want a terminal or a password it will never get. To run one command as root in a service with User=, prefix it with +.",
      "Không cần sudo ở đây: service hệ thống chạy với quyền root trừ khi User= đặt khác, và sudo có thể đòi terminal hay mật khẩu mà nó không bao giờ có. Muốn một lệnh chạy bằng root trong service có User=, hãy thêm dấu + phía trước.",
    );
  }
}

function checkTimerValue(entry: UnitEntry, ctx: ReadContext): Outcome {
  const { key, value } = entry;
  if (value === "") {
    advise(ctx, entry, "note", `An empty ${key}= clears every trigger set above it, OnCalendar= and the rest alike.`, `${key}= để trống sẽ xoá mọi mốc kích hoạt đặt phía trên, cả OnCalendar= lẫn các loại khác.`);
    return "ok";
  }
  const expanded = (expandSpecifiers(value, FULL_SPECIFIERS, ctx.unit) as { text: string }).text;
  if (key === "OnCalendar") {
    try {
      const spec = parseCalendar(expanded);
      const bounded = boundedForm(spec);
      if (bounded !== null) {
        advise(
          ctx,
          entry,
          "warning",
          `${value} has a step with no end, which systemd 259 mishandles past the end of its field: it can skip runs, or give up at a clock change so the timer stops. ${bounded} means the same times and is read correctly.`,
          `${value} có bước nhảy không có điểm cuối, loại mà systemd 259 xử lý sai khi vượt quá cuối trường: nó có thể bỏ sót lần chạy, hoặc bỏ cuộc khi đổi giờ khiến timer dừng. ${bounded} vẫn đúng những thời điểm đó và được đọc đúng.`,
          `OnCalendar=${bounded}`,
        );
      }
    } catch (failure) {
      if (!(failure instanceof CalendarError)) throw failure;
      return warn(ctx, entry, `systemd cannot read this calendar event, and ignores the line: ${failure.text.en}`, `systemd không đọc được biểu thức lịch này, và bỏ qua dòng: ${failure.text.vi}`);
    }
    return "ok";
  }
  if (parseTimespan(expanded) === null) {
    const clock = /^\d{1,2}:\d{2}/.test(value) || /[*~]/.test(value);
    return warn(
      ctx,
      entry,
      `systemd cannot read “${value}” as a time span, and ignores the line. Write a number with a unit, such as 15min or 1h 30min.${clock ? " For a time of day, use OnCalendar=." : ""}`,
      `systemd không đọc được “${value}” là khoảng thời gian, và bỏ qua dòng này. Hãy viết một số kèm đơn vị, như 15min hay 1h 30min.${clock ? " Muốn chạy vào một giờ cố định trong ngày, hãy dùng OnCalendar=." : ""}`,
    );
  }
  return "ok";
}

/* ----------------------------------------------------------- whole units */

/** One unit's settings after its own file and drop-ins, as systemd ends up with them. */
class Settings {
  private readonly values = new Map<string, { value: string; line: number }[]>();

  /** An empty value puts a setting back to its default; for a list, it empties it. */
  add(key: string, value: string, line: number, list: boolean): void {
    if (value === "") this.values.delete(key);
    else if (list) this.values.set(key, [...(this.values.get(key) ?? []), { value, line }]);
    else this.values.set(key, [{ value, line }]);
  }

  clear(keys: readonly string[]): void {
    for (const key of keys) this.values.set(key, []);
  }

  all(key: string): readonly { value: string; line: number }[] {
    return this.values.get(key) ?? [];
  }

  last(key: string): { value: string; line: number } | null {
    const all = this.all(key);
    return all.length > 0 ? all[all.length - 1]! : null;
  }

  has(key: string): boolean {
    return this.all(key).length > 0;
  }
}

const TIMER_KEYS = ["OnCalendar", "OnActiveSec", "OnBootSec", "OnStartupSec", "OnUnitActiveSec", "OnUnitInactiveSec"];
const LIST_KEYS = new Set(["Environment", "EnvironmentFile", "LoadCredential", "LoadCredentialEncrypted", "SetCredential", "SetCredentialEncrypted", "ImportCredential", "WantedBy", "RequiredBy", "UpheldBy", "Also", "Alias"]);

function settingsOf(files: readonly UnitFile[]): Settings {
  const settings = new Settings();
  for (const file of files) {
    for (const entry of file.entries) {
      if (entry.ignored || entry.info === null) continue;
      const kind = entry.info.kind;
      if (kind === "c") {
        if (entry.value === "") settings.clear(TIMER_KEYS);
        else settings.add(entry.key, entry.value, entry.line, true);
        continue;
      }
      if (kind === "x") {
        if (entry.value === "") settings.add(entry.key, "", entry.line, true);
        // Commands before a fatal one on the same line stay: systemd added them before it stopped.
        for (let n = 0; n < entry.commands; n += 1) settings.add(entry.key, entry.value, entry.line, true);
        continue;
      }
      if (entry.fatal) continue;
      // Only the first Unit= of a timer or path unit counts.
      if (kind === "U" && entry.key === "Unit" && settings.has("Unit")) continue;
      settings.add(entry.key, entry.value, entry.line, LIST_KEYS.has(entry.key) || kind === "u" || kind === "o");
    }
  }
  return settings;
}

const words = (settings: Settings, key: string): string[] => settings.all(key).flatMap(({ value }) => splitWords(value) ?? []);

function unitFinding(findings: Finding[], severity: Severity, source: FindingSource, line: number | null, en: string, vi: string, fix?: string): void {
  findings.push({
    severity,
    source,
    level: source === "unit" ? (severity === "error" ? "error" : "warning") : null,
    line,
    systemdLine: null,
    text: both(en, vi),
    ...(fix ? { fix } : {}),
  });
}

const TYPE_MEANING: Readonly<Record<string, Both>> = {
  simple: both("started as soon as the program has been forked off", "được coi là đã chạy ngay khi chương trình được tách ra chạy"),
  exec: both("started once the program has actually been executed", "được coi là đã chạy khi chương trình thực sự được thực thi"),
  forking: both("the program forks a daemon and exits; the daemon is the service", "chương trình fork ra một daemon rồi thoát; daemon đó chính là service"),
  oneshot: both("runs to completion; systemd waits for it to exit", "chạy đến khi xong; systemd chờ nó thoát"),
  dbus: both("ready once it takes its D-Bus name", "sẵn sàng khi đã lấy được tên D-Bus"),
  notify: both("the program reports when it is ready, through sd_notify()", "chương trình tự báo khi sẵn sàng, qua sd_notify()"),
  "notify-reload": both("like notify, and reloads by signal", "giống notify, và nạp lại cấu hình bằng tín hiệu"),
  idle: both("like simple, but waits until other start-up jobs are done", "giống simple, nhưng chờ các tác vụ khởi động khác xong"),
};

/** service_verify(), in its order, and the advice around it. True when systemd refuses the service. */
function checkService(settings: Settings, findings: Finding[], facts: UnitFact[], loaded: boolean, dropInLines: ReadonlySet<number>): boolean {
  const start = settings.all("ExecStart");
  const stop = settings.all("ExecStop");
  const success = settings.last("SuccessAction")?.value ?? "none";
  const remain = parseBoolean(settings.last("RemainAfterExit")?.value ?? "no") === true;
  const busName = settings.last("BusName");
  const declared = settings.last("Type")?.value ?? null;
  const type = declared ?? (busName ? "dbus" : start.length > 0 ? "simple" : "oneshot");
  const restart = settings.last("Restart")?.value ?? "no";
  const credentials = ["LoadCredential", "LoadCredentialEncrypted", "SetCredential", "SetCredentialEncrypted", "ImportCredential"].some((key) => settings.has(key));
  let refused = false;

  // systemd checks these only for a unit whose files it read in full, and stops at the first.
  if (loaded) {
    const refusal = ((): [number | null, string, string, string?] | null => {
      if (start.length === 0 && stop.length === 0 && success === "none") {
        return [null, "The service has no ExecStart=, no ExecStop= and no SuccessAction=: nothing to run.", "Service không có ExecStart=, ExecStop= hay SuccessAction=: không có gì để chạy."];
      }
      if (type !== "oneshot" && start.length === 0) {
        return [settings.last("Type")?.line ?? null, `Type=${type} needs an ExecStart=; only Type=oneshot may do without one.`, `Type=${type} cần có ExecStart=; chỉ Type=oneshot mới được không có.`];
      }
      if (!remain && start.length === 0 && success === "none") {
        return [null, "With no ExecStart= and no SuccessAction=, the service needs RemainAfterExit=yes.", "Không có ExecStart= và SuccessAction=, service cần RemainAfterExit=yes."];
      }
      if (type !== "oneshot" && start.length > 1) {
        const lines = [...new Set(start.map((item) => item.line))];
        const last = start[start.length - 1]!;
        const fromDropIn = dropInLines.has(last.line) && start.some((item) => !dropInLines.has(item.line));
        return [
          lines[lines.length - 1]!,
          `There are ${start.length} ExecStart= commands (line ${lines.join(", ")}), and only Type=oneshot may have more than one. Put set-up commands in ExecStartPre=; in a drop-in, clear the old command first with an empty ExecStart= line.`,
          `Có ${start.length} lệnh ExecStart= (dòng ${lines.join(", ")}), mà chỉ Type=oneshot mới được có nhiều hơn một. Hãy đưa các lệnh chuẩn bị vào ExecStartPre=; trong drop-in, xoá lệnh cũ trước bằng một dòng ExecStart= để trống.`,
          fromDropIn ? `ExecStart=
ExecStart=${last.value}` : undefined,
        ];
      }
      if (type === "oneshot" && (restart === "always" || restart === "on-success")) {
        return [settings.last("Restart")!.line, `Restart=${restart} is not allowed with Type=oneshot; on-failure is.`, `Restart=${restart} không được dùng với Type=oneshot; on-failure thì được.`];
      }
      if (type === "oneshot" && settings.last("ExitType")?.value === "cgroup") {
        return [settings.last("ExitType")!.line, "ExitType=cgroup is not allowed with Type=oneshot.", "ExitType=cgroup không được dùng với Type=oneshot."];
      }
      if (type === "dbus" && !busName) {
        return [settings.last("Type")?.line ?? null, "Type=dbus needs BusName=, the name the service takes on the bus.", "Type=dbus cần BusName=, tên mà service dùng trên bus."];
      }
      const privatePids = settings.last("PrivatePIDs");
      if (type === "forking" && privatePids !== null && parseBoolean(privatePids.value) === true) {
        return [privatePids.line, "Type=forking cannot be combined with PrivatePIDs=yes.", "Type=forking không dùng chung được với PrivatePIDs=yes."];
      }
      return null;
    })();
    if (refusal) {
      unitFinding(findings, "error", "unit", refusal[0], `${refusal[1]} systemd refuses to load the service.`, `${refusal[2]} systemd từ chối nạp service.`, refusal[3]);
      refused = true;
    } else {
      const ignored = (line: number | null, en: string, vi: string) => unitFinding(findings, "warning", "unit", line, en, vi);
      const runtimeMax = settings.last("RuntimeMaxSec");
      const runtimeMaxSet = runtimeMax !== null && parseTimespan(runtimeMax.value) !== Number.POSITIVE_INFINITY;
      if (settings.has("USBFunctionDescriptors") !== settings.has("USBFunctionStrings")) {
        ignored(null, "USBFunctionDescriptors= and USBFunctionStrings= only work together; with one alone, systemd ignores it.", "USBFunctionDescriptors= và USBFunctionStrings= chỉ có tác dụng khi đi cùng nhau; thiếu một trong hai thì systemd bỏ qua thiết lập còn lại.");
      }
      if (runtimeMaxSet && type === "oneshot") {
        ignored(runtimeMax!.line, "RuntimeMaxSec= has no effect on a Type=oneshot service, and systemd ignores it.", "RuntimeMaxSec= không có tác dụng với service Type=oneshot, và systemd bỏ qua nó.");
      }
      const extra = settings.last("RuntimeRandomizedExtraSec");
      if (!runtimeMaxSet && extra !== null && (parseTimespan(extra.value) ?? 0) !== 0) {
        ignored(extra.line, "RuntimeRandomizedExtraSec= does nothing without RuntimeMaxSec=, and systemd ignores it.", "RuntimeRandomizedExtraSec= không có tác dụng nếu thiếu RuntimeMaxSec=, và systemd bỏ qua nó.");
      }
      if (type === "simple" && settings.has("ExecStartPost") && credentials) {
        ignored(settings.last("ExecStartPost")!.line, "Type=simple with ExecStartPost= and credentials can race: the post command may run before the credentials are in place.", "Type=simple cùng ExecStartPost= và credentials có thể tranh chấp: lệnh post có thể chạy trước khi credentials sẵn sàng.");
      }
      const steps = settings.last("RestartSteps");
      const stepsSet = steps !== null && (safeAtou(steps.value) ?? 0n) > 0n;
      const maxDelay = settings.last("RestartMaxDelaySec");
      const maxDelayUs = maxDelay === null ? Number.POSITIVE_INFINITY : (parseTimespan(maxDelay.value) ?? Number.POSITIVE_INFINITY);
      if (stepsSet && maxDelayUs === Number.POSITIVE_INFINITY) ignored(steps!.line, "RestartSteps= does nothing without RestartMaxDelaySec=, and systemd ignores it.", "RestartSteps= không có tác dụng nếu thiếu RestartMaxDelaySec=, và systemd bỏ qua nó.");
      if (maxDelayUs !== Number.POSITIVE_INFINITY && !stepsSet) ignored(maxDelay!.line, "RestartMaxDelaySec= does nothing without RestartSteps=, and systemd ignores it.", "RestartMaxDelaySec= không có tác dụng nếu thiếu RestartSteps=, và systemd bỏ qua nó.");
      const restartUs = parseTimespan(settings.last("RestartSec")?.value ?? "100ms") ?? 100_000;
      if (maxDelayUs < restartUs) {
        ignored(maxDelay!.line, "RestartMaxDelaySec= is shorter than RestartSec=, so systemd lowers RestartSec= to match it.", "RestartMaxDelaySec= ngắn hơn RestartSec=, nên systemd hạ RestartSec= xuống bằng nó.");
      }
    }
  }

  // Advice: things that work but rarely as intended.
  if (restart !== "no" && !settings.has("RestartSec")) {
    unitFinding(
      findings,
      "note",
      "advice",
      settings.last("Restart")!.line,
      `Restart=${restart} with the default RestartSec= of 100ms restarts almost at once: a service that keeps failing reaches the start limit — 5 starts in 10 seconds — within a second, and then stays failed. RestartSec=5s gives it room.`,
      `Restart=${restart} với RestartSec= mặc định 100ms sẽ khởi động lại gần như ngay lập tức: service lỗi liên tục sẽ chạm giới hạn khởi động — 5 lần trong 10 giây — chỉ trong một giây, rồi nằm ở trạng thái failed. RestartSec=5s cho nó thời gian.`,
      "RestartSec=5s",
    );
  }
  if (type === "forking" && !settings.has("PIDFile")) {
    unitFinding(
      findings,
      "note",
      "advice",
      settings.last("Type")?.line ?? null,
      "Type=forking without PIDFile= leaves systemd to guess which process is the daemon. Set PIDFile=, or run the program in the foreground with Type=simple or notify.",
      "Type=forking mà không có PIDFile= thì systemd phải tự đoán tiến trình nào là daemon. Hãy đặt PIDFile=, hoặc chạy chương trình ở chế độ foreground với Type=simple hay notify.",
    );
  }
  if (type === "oneshot" && !remain && settings.has("ExecStop")) {
    unitFinding(
      findings,
      "note",
      "advice",
      settings.last("ExecStop")!.line,
      "A Type=oneshot service without RemainAfterExit=yes counts as stopped as soon as it finishes, so ExecStop= runs right after ExecStart=. Add RemainAfterExit=yes if the stop command should wait for systemctl stop.",
      "Service Type=oneshot không có RemainAfterExit=yes được coi là đã dừng ngay khi chạy xong, nên ExecStop= chạy ngay sau ExecStart=. Hãy thêm RemainAfterExit=yes nếu lệnh dừng phải chờ tới khi systemctl stop.",
      "RemainAfterExit=yes",
    );
  }
  facts.push({ label: both("Type", "Kiểu"), value: both(`${type}${declared ? "" : " (default)"} — ${TYPE_MEANING[type]?.en ?? ""}`, `${type}${declared ? "" : " (mặc định)"} — ${TYPE_MEANING[type]?.vi ?? ""}`) });
  if (start.length > 0) {
    const commands = [...new Set(start.map((item) => item.value))].join("  ·  ");
    facts.push({ label: both("Runs", "Chạy lệnh"), value: both(commands, commands) });
  }
  const user = settings.last("User")?.value;
  const dynamic = parseBoolean(settings.last("DynamicUser")?.value ?? "no") === true;
  facts.push({
    label: both("As user", "Dưới quyền"),
    value: dynamic
      ? both(`a temporary user${user ? ` named ${user}` : ""}, created for each run`, `một người dùng tạm${user ? ` tên ${user}` : ""}, được tạo cho mỗi lần chạy`)
      : user
        ? both(user, user)
        : both("root — no User= is set", "root — không đặt User="),
  });
  const directory = settings.last("WorkingDirectory")?.value;
  if (directory) facts.push({ label: both("In", "Thư mục"), value: both(directory, directory) });
  const restartSec = settings.last("RestartSec")?.value;
  facts.push({
    label: both("Restarts", "Khởi động lại"),
    value: restart === "no" ? both("never — Restart=no", "không bao giờ — Restart=no") : both(`${restart}, after ${restartSec ?? "100ms"}`, `${restart}, sau ${restartSec ?? "100ms"}`),
  });
  return refused;
}

/** timer_verify(), and the advice around it. True when systemd refuses the timer. */
function checkTimer(name: string | null, settings: Settings, findings: Finding[], facts: UnitFact[], loaded: boolean): boolean {
  const triggers = TIMER_KEYS.flatMap((key) => settings.all(key).map((item) => ({ key, ...item })));
  const clock = parseBoolean(settings.last("OnClockChange")?.value ?? "no") === true || parseBoolean(settings.last("OnTimezoneChange")?.value ?? "no") === true;
  let refused = false;
  if (loaded && triggers.length === 0 && !clock) {
    unitFinding(
      findings,
      "error",
      "unit",
      null,
      "The timer has no OnCalendar=, OnBootSec= or other trigger left, so systemd refuses to load it.",
      "Timer không còn OnCalendar=, OnBootSec= hay mốc kích hoạt nào khác, nên systemd từ chối nạp nó.",
    );
    refused = true;
  }
  const relative = triggers.filter((t) => t.key === "OnUnitActiveSec" || t.key === "OnUnitInactiveSec");
  if (relative.length > 0 && relative.length === triggers.length) {
    unitFinding(
      findings,
      "warning",
      "advice",
      relative[0]!.line,
      `${relative[0]!.key}= counts from the last time the service ran, and nothing starts it the first time: the timer can wait for ever. Add OnBootSec= or OnActiveSec= to start the cycle.`,
      `${relative[0]!.key}= tính từ lần chạy trước của service, mà không có gì khởi động nó lần đầu: timer có thể chờ mãi. Hãy thêm OnBootSec= hoặc OnActiveSec= để bắt đầu chu kỳ.`,
      "OnBootSec=1min",
    );
  }
  const persistent = settings.last("Persistent");
  if (persistent && parseBoolean(persistent.value) === true && !settings.has("OnCalendar")) {
    unitFinding(findings, "note", "advice", persistent.line, "Persistent= only affects OnCalendar= triggers, and this timer has none.", "Persistent= chỉ có tác dụng với OnCalendar=, mà timer này không có.");
  }

  const target = settings.last("Unit")?.value ?? (name ? `${name.replace(/\.timer$/, "")}.service` : null);
  facts.push({
    label: both("Starts", "Khởi động"),
    value: target ? both(target, target) : both("the .service with the timer's own name", "file .service cùng tên với timer"),
  });
  for (const trigger of triggers) {
    if (trigger.key === "OnCalendar") {
      try {
        const spec = parseCalendar(trigger.value);
        facts.push({
          label: both("On the calendar", "Theo lịch"),
          value: both(`${spec.normalized} — ${describeCalendar(spec, "en")}`, `${spec.normalized} — ${describeCalendar(spec, "vi")}`),
        });
      } catch {
        // Named on its own line already.
      }
    } else {
      const span = parseTimespan(trigger.value);
      const length = span === null ? trigger.value : formatTimespan(span);
      const when: Record<string, Both> = {
        OnActiveSec: both(`${length} after the timer starts`, `${length} sau khi timer khởi động`),
        OnBootSec: both(`${length} after boot`, `${length} sau khi máy khởi động`),
        OnStartupSec: both(`${length} after the service manager starts`, `${length} sau khi trình quản lý dịch vụ khởi động`),
        OnUnitActiveSec: both(`${length} after the service last started`, `${length} sau lần service khởi động gần nhất`),
        OnUnitInactiveSec: both(`${length} after the service last finished`, `${length} sau lần service kết thúc gần nhất`),
      };
      facts.push({ label: both("Elapses", "Chạy lúc"), value: when[trigger.key]! });
    }
  }
  if (persistent && parseBoolean(persistent.value) === true) {
    facts.push({ label: both("Missed runs", "Lần chạy bị lỡ"), value: both("caught up once at start-up — Persistent=true", "được chạy bù một lần khi khởi động — Persistent=true") });
  }
  const accuracy = settings.last("AccuracySec")?.value;
  facts.push({ label: both("Accuracy", "Độ chính xác"), value: both(`within ${accuracy ?? "1min, the default"}`, `trong vòng ${accuracy ?? "1min, mặc định"}`) });
  const random = settings.last("RandomizedDelaySec")?.value;
  if (random) facts.push({ label: both("Random delay", "Trễ ngẫu nhiên"), value: both(`up to ${random}`, `tối đa ${random}`) });
  return refused;
}

function checkDependencies(settings: Settings, findings: Finding[]): void {
  const after = words(settings, "After");
  const wanted = [...words(settings, "Wants"), ...words(settings, "Requires")];
  const lineOf = (key: string, word: string) => settings.all(key).find((item) => (splitWords(item.value) ?? []).includes(word))?.line ?? null;
  const advice = (severity: Severity, line: number | null, en: string, vi: string, fix?: string) => unitFinding(findings, severity, "advice", line, en, vi, fix);

  if (wanted.includes("network-online.target") && !after.includes("network-online.target")) {
    advice(
      "warning",
      lineOf("Wants", "network-online.target") ?? lineOf("Requires", "network-online.target"),
      "Wanting network-online.target without ordering after it does nothing useful: the unit can still start before the network is up. Add After=network-online.target.",
      "Kéo theo network-online.target mà không xếp sau nó thì chẳng có ích gì: unit vẫn có thể khởi động trước khi mạng sẵn sàng. Hãy thêm After=network-online.target.",
      "After=network-online.target",
    );
  } else if (after.includes("network.target") && !after.includes("network-online.target")) {
    advice(
      "note",
      lineOf("After", "network.target"),
      "network.target only means the network stack has started, not that an address is configured. If the service needs a working network when it starts, use Wants=network-online.target and After=network-online.target.",
      "network.target chỉ có nghĩa là bộ phận mạng đã khởi động, chưa chắc đã có địa chỉ IP. Nếu service cần mạng hoạt động ngay khi khởi động, hãy dùng Wants=network-online.target và After=network-online.target.",
    );
  } else if (after.includes("network-online.target") && !wanted.includes("network-online.target")) {
    advice(
      "note",
      lineOf("After", "network-online.target"),
      "After=network-online.target orders the unit after it but does not pull it in; add Wants=network-online.target so it is actually started.",
      "After=network-online.target chỉ xếp unit sau nó chứ không kéo nó theo; hãy thêm Wants=network-online.target để nó thực sự được khởi động.",
      "Wants=network-online.target",
    );
  }
  for (const required of words(settings, "Requires")) {
    if (required.endsWith(".target") || after.includes(required) || !unitNameIsValid(required)) continue;
    advice(
      "note",
      lineOf("Requires", required),
      `Requires=${required} without After=${required} starts both at the same time; if this unit needs ${required} running first, add After=${required}.`,
      `Requires=${required} mà không có After=${required} thì hai unit khởi động cùng lúc; nếu unit này cần ${required} chạy trước, hãy thêm After=${required}.`,
      `After=${required}`,
    );
  }
}

/** [Install], which systemd reads only when systemctl enable runs. */
function checkInstall(group: readonly UnitFile[], findings: Finding[]): void {
  for (const file of group) {
    for (const entry of file.entries) {
      if (entry.section !== "Install" || entry.info === null || entry.key === "DefaultInstance") continue;
      for (const word of splitWords(entry.value) ?? []) {
        const expanded = expandSpecifiers(word, NAME_SPECIFIERS, file.name ?? "unit.service");
        if ("bad" in expanded || unitNameIsValid(expanded.text)) continue;
        const guess = guessUnitName(word, entry.key);
        findings.push({
          severity: "warning",
          source: "advice",
          level: null,
          line: entry.line,
          systemdLine: null,
          text: both(
            `“${word}” is not a unit name — it needs its suffix — and systemctl enable will fail on it.${guess ? ` Write ${guess}.` : ""}`,
            `“${word}” không phải tên unit — thiếu phần đuôi — và systemctl enable sẽ báo lỗi.${guess ? ` Hãy viết ${guess}.` : ""}`,
          ),
          ...(guess ? { fix: `${entry.key}=${entry.value.replace(word, guess)}` } : {}),
        });
      }
    }
  }
}

/** A second Unit= in a timer or path unit, from the file or a drop-in, is refused: the first one stays. */
function checkTriggers(group: readonly UnitFile[], findings: Finding[]): void {
  let seen = false;
  for (const file of group) {
    for (const entry of file.entries) {
      if (entry.info?.kind !== "U" || entry.key !== "Unit") continue;
      if (seen && !entry.ignored) {
        entry.ignored = true;
        findings.push({
          severity: "warning",
          source: "line",
          level: "warning",
          line: entry.line,
          systemdLine: entry.systemdLine,
          text: both(
            "There is already a Unit= above, and systemd keeps the first one: it ignores this line. To change the unit in a drop-in, edit the timer itself instead.",
            "Phía trên đã có một Unit=, và systemd giữ cái đầu tiên: nó bỏ qua dòng này. Muốn đổi unit trong drop-in, hãy sửa chính file timer.",
          ),
        });
      }
      if (!entry.ignored) seen = true;
    }
  }
}

/* --------------------------------------------------------------- the entry */

/**
 * Reads a pasted unit file — one file, several pasted one after another, or
 * `systemctl cat` output with drop-ins — and names everything systemd would
 * do wrong. `fileName`, such as backup.service, names a paste that is a
 * single file without a `systemctl cat` header, which sets its type.
 */
export function analyzeUnits(text: string, fileName: string | null = null): UnitAnalysis {
  const lineCount = text.split(/\r\n|\n|\r/).length;
  if (lineCount > UNIT_LINE_LIMIT) throw new RangeError(`${lineCount}`);
  const name = fileName !== null && fileName.trim() !== "" ? fileName.trim().replace(/^.*\//, "") : null;
  const findings: Finding[] = [];
  const raws = splitFiles(text, name);
  const files: UnitFile[] = [];
  const broken = new Set<string>();
  for (const raw of raws.filter((candidate) => !candidate.dropIn)) {
    const file = readFile(raw, findings);
    files.push(file);
    if (file.stoppedAt !== null && file.name !== null) broken.add(file.name);
  }
  for (const raw of raws.filter((candidate) => candidate.dropIn)) {
    if (raw.name === null || !broken.has(raw.name)) {
      files.push(readFile(raw, findings));
      continue;
    }
    const first = raw.lines[0]?.number ?? raw.header ?? 1;
    files.push({ path: raw.path, name: raw.name, type: unitTypeOf(raw.name), dropIn: true, firstLine: first, lastLine: raw.lines[raw.lines.length - 1]?.number ?? first, sections: [], entries: [], stoppedAt: null });
    findings.push({
      severity: "note",
      source: "advice",
      level: null,
      line: raw.header ?? first,
      systemdLine: null,
      text: both(
        `systemd never reads this drop-in: ${raw.name} itself already failed to load. Fix the unit file first.`,
        `systemd không bao giờ đọc drop-in này: bản thân ${raw.name} đã không nạp được. Hãy sửa file unit trước.`,
      ),
    });
  }
  files.sort((a, b) => a.firstLine - b.firstLine);

  // A unit is its own file and its drop-ins, matched by name.
  const groups = new Map<string, UnitFile[]>();
  for (const file of files) {
    const key = file.name ?? `#${file.firstLine}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  const units: UnitSummary[] = [];
  for (const [, group] of groups) {
    const own = group.find((file) => !file.dropIn) ?? group[0]!;
    const type = own.type ?? group.find((file) => file.type !== null)?.type ?? null;
    checkTriggers(group, findings);
    const settings = settingsOf(group);
    const facts: UnitFact[] = [];
    const brokenFile = group.some((file) => !file.dropIn && file.stoppedAt !== null);
    let refused = brokenFile;
    const sawInstall = group.some((file) => file.sections.some((section) => section.name === "Install" && section.known));

    const dropInLines = new Set(group.filter((file) => file.dropIn).flatMap((file) => file.entries.map((entry) => entry.line)));
    if (type === "service") refused = checkService(settings, findings, facts, !brokenFile, dropInLines) || refused;
    if (type === "timer") refused = checkTimer(own.name, settings, findings, facts, !brokenFile) || refused;
    checkDependencies(settings, findings);
    checkInstall(group, findings);

    for (const file of group) {
      for (const entry of file.entries) {
        if (entry.section === "Service" && MOVED_TO_UNIT.has(entry.key) && !entry.ignored) {
          unitFinding(
            findings,
            "note",
            "advice",
            entry.line,
            `${entry.key}= belongs in [Unit] now${entry.key === "StartLimitInterval" ? ", as StartLimitIntervalSec=" : ""}; systemd still reads it in [Service] for old unit files.`,
            `${entry.key}= giờ thuộc mục [Unit]${entry.key === "StartLimitInterval" ? ", với tên StartLimitIntervalSec=" : ""}; systemd vẫn đọc nó trong [Service] cho file unit cũ.`,
          );
        }
      }
    }

    // [Install]: what enabling does, and the usual targets.
    const enabledBy = [...words(settings, "WantedBy"), ...words(settings, "RequiredBy")];
    if (!own.dropIn) {
      if (type === "timer" && !sawInstall) {
        unitFinding(
          findings,
          "warning",
          "advice",
          null,
          "The timer has no [Install] section, so systemctl enable cannot enable it: it will not start at boot, and after a reboot it stays stopped until someone starts it by hand. Add [Install] with WantedBy=timers.target.",
          "Timer không có mục [Install], nên systemctl enable không enable được: nó sẽ không chạy khi khởi động, và sau khi khởi động lại máy nó nằm im cho tới khi có người tự tay start. Hãy thêm mục [Install] với WantedBy=timers.target.",
          "[Install]\nWantedBy=timers.target",
        );
      } else if (type === "timer" && enabledBy.includes("multi-user.target") && !enabledBy.includes("timers.target")) {
        unitFinding(
          findings,
          "note",
          "advice",
          settings.last("WantedBy")?.line ?? null,
          "Timers usually go in timers.target. multi-user.target works too, but timers.target is where timers belong, beside the distribution's own.",
          "Timer thường được đặt vào timers.target. multi-user.target cũng chạy được, nhưng timers.target mới là nơi chuẩn cho timer, cạnh các timer của chính bản phân phối.",
          "WantedBy=timers.target",
        );
      } else if (type === "service" && !sawInstall) {
        unitFinding(
          findings,
          "note",
          "advice",
          null,
          "systemd finds no [Install] section, so systemctl enable has nothing to do: the service will not start at boot by itself. That is right for a service a timer or socket starts; otherwise add [Install] with WantedBy=multi-user.target.",
          "systemd không thấy mục [Install] nào, nên systemctl enable không có gì để làm: service sẽ không tự chạy khi khởi động. Như vậy là đúng nếu service do timer hay socket khởi động; nếu không, hãy thêm mục [Install] với WantedBy=multi-user.target.",
        );
      }
    }
    if (type !== null && sawInstall) {
      facts.push({
        label: both("At boot", "Khi khởi động"),
        value:
          enabledBy.length > 0
            ? both(`started by ${enabledBy.join(", ")} once enabled`, `được ${enabledBy.join(", ")} khởi động sau khi enable`)
            : both("nothing — [Install] names no target", "không — mục [Install] không nêu target nào"),
      });
    }

    units.push({ name: own.name, type, files: group, facts, refused });
  }

  // A timer and the service it starts, pasted together.
  for (const timer of units.filter((unit) => unit.type === "timer")) {
    const target = settingsOf(timer.files).last("Unit")?.value ?? (timer.name ? `${timer.name.replace(/\.timer$/, "")}.service` : null);
    const service = units.find((unit) => unit.name !== null && unit.name === target);
    if (!service) continue;
    const serviceSettings = settingsOf(service.files);
    const boot = words(serviceSettings, "WantedBy");
    if (boot.length > 0) {
      unitFinding(
        findings,
        "note",
        "advice",
        serviceSettings.last("WantedBy")?.line ?? null,
        `${service.name} also has WantedBy=${boot.join(" ")}, so enabling it starts it at every boot as well as on the timer. A service a timer starts usually has no [Install] section; enable the timer instead.`,
        `${service.name} cũng có WantedBy=${boot.join(" ")}, nên enable nó sẽ khiến nó chạy mỗi lần khởi động máy, ngoài lịch của timer. Service do timer khởi động thường không có mục [Install]; hãy enable timer thay vì service.`,
      );
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
  findings.sort((a, b) => (a.line ?? Number.POSITIVE_INFINITY) - (b.line ?? Number.POSITIVE_INFINITY) || order[a.severity] - order[b.severity]);
  const counts = { error: 0, warning: 0, note: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { files, units, findings, counts };
}
