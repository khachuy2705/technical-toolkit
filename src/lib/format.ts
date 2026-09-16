/** Shared result shape for the text-transform tools. */

export type FormatResult =
  | { ok: true; output: string; note?: string }
  | { ok: false; message: string };

export function ok(output: string, note?: string): FormatResult {
  return note === undefined ? { ok: true, output } : { ok: true, output, note };
}

export function fail(message: string): FormatResult {
  return { ok: false, message };
}

/** 1-based line and column for a character offset. */
export function lineColumn(text: string, index: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, clamped);
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: clamped - lastBreak };
}

/**
 * Recursively sorts object keys.
 *
 * Arrays keep their order — reordering them would change the data, not just its
 * presentation, which is not what a formatter is allowed to do.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
  return sorted;
}

/** `indent` as the string JSON.stringify and js-yaml expect. */
export type Indent = 2 | 4 | "tab";

export function indentValue(indent: Indent): string | number {
  return indent === "tab" ? "\t" : indent;
}
