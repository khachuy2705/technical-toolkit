import {
  fail,
  indentValue,
  lineColumn,
  ok,
  sortKeysDeep,
  type FormatResult,
  type Indent,
} from "./format";

export interface JsonOptions {
  indent: Indent;
  minify: boolean;
  sortKeys: boolean;
}

export const DEFAULT_JSON_OPTIONS: JsonOptions = {
  indent: 2,
  minify: false,
  sortKeys: false,
};

/**
 * Inputs above this are reported with the engine's own message instead of a
 * located one. Finding the position costs O(log n) parses of an O(n) prefix,
 * which is cheap until the document is very large.
 */
const LOCATE_LIMIT = 2_000_000;

/**
 * True when the parser consumed all of `text` and merely wants more input.
 *
 * This is the predicate the search below bisects on. It deliberately avoids
 * matching on error wording: V8 rewrote its JSON messages, Firefox and Safari
 * word them differently again, and a check against "unexpected end of input"
 * silently stopped working. Comparing the reported offset against the prefix
 * length is something every engine agrees on.
 */
function consumesAll(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const position = /at position (\d+)/i.exec(raw);
    if (position) return Number(position[1]) >= text.length;
    return /unexpected end/i.test(raw);
  }
}

/**
 * Offset of the first character JSON.parse could not accept, or -1 if the text
 * parses. An offset equal to the length means the input ended early.
 *
 * Bisects on the longest prefix the parser is still happy to continue from.
 */
export function findErrorIndex(text: string): number {
  try {
    JSON.parse(text);
    return -1;
  } catch {
    // Fall through to the search.
  }
  if (consumesAll(text)) return text.length;

  let low = 0;
  let high = text.length;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (consumesAll(text.slice(0, mid))) low = mid;
    else high = mid;
  }
  return low;
}

/** The engine's complaint, stripped of whichever position wording it used. */
function reasonOf(raw: string): string {
  let reason = raw
    .replace(/^JSON\.parse:\s*/i, "")
    .replace(/\s*in JSON at position \d+(?:\s*\(line \d+ column \d+\))?/i, "")
    .replace(/,?\s*\.{0,3}"[\s\S]*"\s*is not valid JSON/i, "")
    .replace(/\s*at line \d+ column \d+ of the JSON data/i, "");
  reason = reason.replace(/[\s.]+$/, "");
  return reason.length > 0 ? reason : "Invalid JSON";
}

function explain(error: unknown, input: string): string {
  const reason = reasonOf(error instanceof Error ? error.message : String(error));
  if (input.length > LOCATE_LIMIT) return `${reason}.`;

  const index = findErrorIndex(input);
  if (index < 0) return `${reason}.`;
  if (index >= input.length) return `${reason} — the input ends before the value is complete.`;

  const { line, column } = lineColumn(input, index);
  return `${reason} — line ${line}, column ${column}.`;
}

export function formatJson(input: string, options: JsonOptions): FormatResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return ok("");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return fail(explain(error, trimmed));
  }

  const value = options.sortKeys ? sortKeysDeep(parsed) : parsed;
  const output = options.minify
    ? JSON.stringify(value)
    : JSON.stringify(value, null, indentValue(options.indent));

  // JSON.stringify returns undefined for `undefined`, which JSON.parse cannot
  // produce — but the guard keeps the return type honest.
  if (output === undefined) return fail("Nothing to output.");

  const saved = trimmed.length - output.length;
  const note = options.minify && saved > 0 ? `${saved.toLocaleString("en-US")} characters smaller` : undefined;
  return ok(output, note);
}
