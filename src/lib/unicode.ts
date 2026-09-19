/** A deliberately small, deterministic homoglyph map; not a Unicode spoof detector. */
const LETTERS = new Map(Object.entries({
  A: "\u0410", B: "\u0412", C: "\u0421", E: "\u0415", H: "\u041d",
  I: "\u0406", J: "\u0408", K: "\u039a", M: "\u041c", N: "\u039d",
  O: "\u041e", P: "\u0420", S: "\u0405", T: "\u0422", X: "\u0425", Y: "\u03a5",
  a: "\u0430", c: "\u0441", e: "\u0435", i: "\u0456", j: "\u0458",
  o: "\u043e", p: "\u0440", s: "\u0455", x: "\u0445", y: "\u0443",
}));
const PUNCTUATION = new Map(Object.entries({
  "!": "\u01c3", ".": "\u2024", ",": "\u201a", ";": "\u037e", "-": "\u2010",
}));

export const UNICODE_INPUT_LIMIT = 100_000;
export const UNICODE_CHANGE_LIMIT = 200;
export interface SpoofOptions {
  letters: boolean;
  punctuation: boolean;
  spaces: boolean;
  zeroWidth: boolean;
}
export const DEFAULT_SPOOF_OPTIONS: SpoofOptions = {
  letters: true, punctuation: false, spaces: false, zeroWidth: false,
};
export interface UnicodeChange {
  /** One-based input grapheme position. Insertions occur after this position. */
  position: number;
  before: string;
  after: string;
  kind: "Letter" | "Punctuation" | "Space" | "Insertion";
}
export interface SpoofResult {
  output: string;
  preview: string;
  changes: UnicodeChange[];
  replacements: number;
  insertions: number;
}

export function unicodeCodePoints(text: string): string {
  return Array.from(text, (char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}

export function spoofUnicode(input: string, options: SpoofOptions): SpoofResult {
  if (input.length > UNICODE_INPUT_LIMIT) {
    throw new Error(`Use at most ${UNICODE_INPUT_LIMIT.toLocaleString("en-US")} UTF-16 code units. The input has not been truncated.`);
  }
  const result: SpoofResult = { output: "", preview: "", changes: [], replacements: 0, insertions: 0 };
  if (!input) return result;
  if (typeof Intl.Segmenter !== "function") {
    throw new Error("This tool needs a browser with Intl.Segmenter support to preserve emoji and combining marks. Please update your browser.");
  }
  const segments = Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(input), (item) => item.segment);
  const output: string[] = [];
  const preview: string[] = [];
  const record = (change: UnicodeChange) => {
    if (result.changes.length < UNICODE_CHANGE_LIMIT) result.changes.push(change);
  };
  const lineBreak = (text: string) => /[\r\n\u2028\u2029]/u.test(text);
  segments.forEach((original, index) => {
    let replacement = original;
    let kind: UnicodeChange["kind"] = "Letter";
    if (options.letters && LETTERS.has(original)) replacement = LETTERS.get(original)!;
    else if (options.punctuation && PUNCTUATION.has(original)) {
      replacement = PUNCTUATION.get(original)!;
      kind = "Punctuation";
    } else if (options.spaces && original === " ") {
      replacement = "\u2005";
      kind = "Space";
    }
    output.push(replacement);
    if (replacement !== original) {
      result.replacements++;
      record({ position: index + 1, before: original, after: replacement, kind });
      preview.push(kind === "Space" ? "[U+2005]" : replacement);
    } else preview.push(lineBreak(original) ? original : "◌");

    // Insert only between complete graphemes, never inside emoji or around line breaks.
    const next = segments[index + 1];
    if (options.zeroWidth && next !== undefined && !lineBreak(original) && !lineBreak(next)) {
      output.push("\u200b");
      preview.push("[U+200B]");
      result.insertions++;
      record({ position: index + 1, before: "", after: "\u200b", kind: "Insertion" });
    }
  });
  result.output = output.join("");
  result.preview = preview.join("");
  return result;
}
