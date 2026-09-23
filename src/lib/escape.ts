/**
 * Backslash escape sequences, both directions.
 *
 * The decoder reads what JSON, JavaScript, Java, C# and Python all write:
 * `\uXXXX` code units (surrogate pairs included), `\u{XXXXX}` code points,
 * `\xNN` bytes and the one-letter shorthands. The encoder writes the same
 * syntax back out, so a string with accents or emoji can be pasted into source
 * that only tolerates ASCII.
 */

export const ESCAPE_INPUT_LIMIT = 200_000;

/** `\n` and friends, in both directions. `\0` is handled separately. */
const SHORTHAND: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  // No `\a`: it is a bell in C and Python but a plain "a" in JavaScript, and
  // decoding "\already" into a control character would be a trap.
  ["\\", "\\"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["/", "/"],
]);

/** The shorthand an escaper should prefer over `\u00XX` for a control character. */
const CONTROL_SHORTHAND: ReadonlyMap<string, string> = new Map([
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\v", "\\v"],
]);

const HEX = /^[0-9a-fA-F]+$/;

export interface UnescapeOptions {
  /** Drop one matching pair of surrounding quotes, as copied out of a log line. */
  trimQuotes: boolean;
  /**
   * Leave a sequence that means nothing — `\d`, `\s` — exactly as written
   * instead of refusing the input. JSON itself allows neither.
   */
  keepUnknown: boolean;
}

export const DEFAULT_UNESCAPE_OPTIONS: UnescapeOptions = {
  trimQuotes: true,
  keepUnknown: true,
};

export interface UnescapeResult {
  output: string;
  /** Sequences turned into characters. */
  decoded: number;
  /** Sequences left as written because they mean nothing. */
  unknown: number;
  quotesTrimmed: boolean;
  /**
   * Unpaired surrogates produced by the decode. They are valid in a JavaScript
   * string but cannot be encoded as UTF-8, so a file or a fetch body built from
   * this output would carry U+FFFD instead.
   */
  loneSurrogates: number;
}

export interface EscapeResult {
  output: string;
  /** Characters written as an escape sequence. */
  escaped: number;
}

/** `\uXXXX` code units, or `\u{XXXXX}` code points for anything above the BMP. */
export type EscapeStyle = "unit" | "codepoint";

export interface EscapeOptions {
  style: EscapeStyle;
  /** Escape `"`, `'` and `\` too, so the result can sit inside a string literal. */
  quotes: boolean;
  /** Wrap the result in double quotes. */
  wrap: boolean;
}

export const DEFAULT_ESCAPE_OPTIONS: EscapeOptions = {
  style: "unit",
  quotes: true,
  wrap: false,
};

export class EscapeError extends Error {
  /** Zero-based offset into the text the caller passed in. */
  readonly index: number;

  constructor(message: string, index: number) {
    super(message);
    this.name = "EscapeError";
    this.index = index;
  }
}

function guardLength(text: string): void {
  if (text.length > ESCAPE_INPUT_LIMIT) {
    throw new EscapeError(
      `Use at most ${ESCAPE_INPUT_LIMIT.toLocaleString("en-US")} characters. The input has not been truncated.`,
      0,
    );
  }
}

/**
 * Removes one pair of matching quotes, and only that: a string that merely
 * starts with a quote keeps it, because dropping it would change the text.
 */
function unquote(text: string): { text: string; trimmed: boolean } {
  const trimmedText = text.trim();
  if (trimmedText.length < 2) return { text, trimmed: false };
  const first = trimmedText[0]!;
  const last = trimmedText[trimmedText.length - 1]!;
  if (first !== last || (first !== '"' && first !== "'" && first !== "`")) {
    return { text, trimmed: false };
  }
  // A closing quote that is itself escaped is part of the string, not its end.
  let backslashes = 0;
  for (let i = trimmedText.length - 2; i >= 0 && trimmedText[i] === "\\"; i -= 1) backslashes += 1;
  if (backslashes % 2 === 1) return { text, trimmed: false };
  return { text: trimmedText.slice(1, -1), trimmed: true };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Unpaired surrogates in `text`; they survive in JS but not in UTF-8. */
function countLoneSurrogates(text: string): number {
  let lone = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(text.charCodeAt(i + 1))) i += 1;
      else lone += 1;
    } else if (isLowSurrogate(code)) lone += 1;
  }
  return lone;
}

/**
 * Turns escape sequences back into the characters they stand for.
 *
 * Text outside a sequence is copied through untouched, so a document with a
 * handful of escapes in it decodes without being reformatted around them.
 */
export function unescapeText(input: string, options: UnescapeOptions): UnescapeResult {
  guardLength(input);

  const { text, trimmed } = options.trimQuotes ? unquote(input) : { text: input, trimmed: false };
  // Offsets are reported against the caller's string, not the unquoted one.
  const shift = trimmed ? input.indexOf(text) : 0;

  const out: string[] = [];
  let decoded = 0;
  let unknown = 0;
  let index = 0;

  const refuse = (message: string, at: number): never => {
    throw new EscapeError(message, at + shift);
  };

  const keepOrRefuse = (sequence: string, at: number, message: string): void => {
    if (!options.keepUnknown) refuse(message, at);
    out.push(sequence);
    unknown += 1;
  };

  while (index < text.length) {
    const backslash = text.indexOf("\\", index);
    if (backslash === -1) {
      out.push(text.slice(index));
      break;
    }
    out.push(text.slice(index, backslash));

    const marker = text[backslash + 1];
    if (marker === undefined) {
      keepOrRefuse("\\", backslash, "The input ends with a lone backslash.");
      index = text.length;
      continue;
    }

    if (marker === "u" && text[backslash + 2] === "{") {
      const close = text.indexOf("}", backslash + 3);
      const digits = close === -1 ? "" : text.slice(backslash + 3, close);
      if (close === -1 || digits.length === 0 || !HEX.test(digits)) {
        keepOrRefuse("\\u", backslash, "\\u{…} needs hex digits and a closing brace.");
        index = backslash + 2;
        continue;
      }
      const value = Number.parseInt(digits, 16);
      if (value > 0x10ffff) {
        refuse(`\\u{${digits}} is above the highest code point, U+10FFFF.`, backslash);
      }
      out.push(String.fromCodePoint(value));
      decoded += 1;
      index = close + 1;
      continue;
    }

    if (marker === "u" || marker === "x") {
      const width = marker === "u" ? 4 : 2;
      const digits = text.slice(backslash + 2, backslash + 2 + width);
      if (digits.length < width || !HEX.test(digits)) {
        keepOrRefuse(
          `\\${marker}`,
          backslash,
          `\\${marker} needs ${width} hex digits; found "${digits.replace(/\n/g, "\\n")}".`,
        );
        index = backslash + 2;
        continue;
      }
      // fromCharCode, not fromCodePoint: a `😀` pair has to meet as
      // two code units for the emoji to come back out whole.
      out.push(String.fromCharCode(Number.parseInt(digits, 16)));
      decoded += 1;
      index = backslash + 2 + width;
      continue;
    }

    // `\0` is NUL only on its own. Followed by a digit it is a legacy octal
    // escape, which nothing here claims to read.
    if (marker === "0" && !/[0-9]/.test(text[backslash + 2] ?? "")) {
      out.push("\0");
      decoded += 1;
      index = backslash + 2;
      continue;
    }

    const shorthand = SHORTHAND.get(marker);
    if (shorthand !== undefined) {
      out.push(shorthand);
      decoded += 1;
      index = backslash + 2;
      continue;
    }

    keepOrRefuse(`\\${marker}`, backslash, `\\${marker} is not an escape sequence.`);
    index = backslash + 2;
  }

  const output = out.join("");
  return { output, decoded, unknown, quotesTrimmed: trimmed, loneSurrogates: countLoneSurrogates(output) };
}

/**
 * Writes every non-ASCII and control character as an escape sequence, leaving
 * printable ASCII as it is.
 */
export function escapeText(input: string, options: EscapeOptions): EscapeResult {
  guardLength(input);

  const out: string[] = [];
  let escaped = 0;

  const unit = (code: number): string => `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;

  for (const char of input) {
    const code = char.codePointAt(0)!;

    const control = CONTROL_SHORTHAND.get(char);
    if (control !== undefined) {
      out.push(control);
      escaped += 1;
      continue;
    }

    if (options.quotes && (char === "\\" || char === '"' || char === "'")) {
      out.push(`\\${char}`);
      escaped += 1;
      continue;
    }

    if (code >= 0x20 && code <= 0x7e) {
      out.push(char);
      continue;
    }

    if (code > 0xffff && options.style === "codepoint") {
      out.push(`\\u{${code.toString(16).toUpperCase()}}`);
    } else if (code > 0xffff) {
      // Back to the surrogate pair JavaScript stores, one escape each.
      for (let i = 0; i < char.length; i += 1) out.push(unit(char.charCodeAt(i)));
    } else {
      out.push(unit(code));
    }
    escaped += 1;
  }

  const body = out.join("");
  return { output: options.wrap ? `"${body}"` : body, escaped };
}
