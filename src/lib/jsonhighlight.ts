/**
 * JSON syntax highlighting, as an HTML string for a `<pre>` layer.
 *
 * A hand-written scanner rather than an editor component: JSON has six token
 * kinds, and an editor would be the heaviest asset on the site by an order of
 * magnitude. The scanner is deliberately forgiving — the input pane shows
 * whatever the user has typed so far, which is usually not valid JSON yet — so
 * it never throws and every character lands in exactly one token.
 */

export type TokenKind =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "punct"
  | "space"
  /** Anything JSON does not allow here: a stray word, a comment, a quote that never closes. */
  | "invalid";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

/**
 * Above this many characters the panes fall back to plain text. The input
 * layer is repainted on every keystroke, and a document this size already
 * takes tens of milliseconds to rebuild.
 */
export const HIGHLIGHT_LIMIT = 200_000;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const SPACE = /[ \t\n\r]+/y;

/** End of the string starting at `start` (a `"`), or -1 when it never closes on this line. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    // A raw newline is illegal inside a JSON string; stopping here keeps one
    // missing quote from painting the rest of the document as a string.
    else if (c === "\n") return -1;
    else i += 1;
  }
  return -1;
}

export function tokenizeJson(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (kind: TokenKind, end: number) => {
    tokens.push({ kind, start: i, end });
    i = end;
  };

  const sticky = (pattern: RegExp): number => {
    pattern.lastIndex = i;
    return pattern.test(text) ? pattern.lastIndex : -1;
  };

  while (i < text.length) {
    const c = text[i]!;

    let end = sticky(SPACE);
    if (end > i) {
      push("space", end);
      continue;
    }

    if (c === '"') {
      const close = stringEnd(text, i);
      if (close === -1) {
        const lineEnd = text.indexOf("\n", i);
        push("invalid", lineEnd === -1 ? text.length : lineEnd);
      } else {
        push("string", close);
      }
      continue;
    }

    if ("{}[],:".includes(c)) {
      push("punct", i + 1);
      continue;
    }

    if (c === "-" || (c >= "0" && c <= "9")) {
      end = sticky(NUMBER);
      if (end > i) {
        push("number", end);
        continue;
      }
    }

    end = sticky(WORD);
    if (end > i) {
      const word = text.slice(i, end);
      push(word === "true" || word === "false" ? "boolean" : word === "null" ? "null" : "invalid", end);
      continue;
    }

    push("invalid", i + 1);
  }

  // A string is a key when the next meaningful token is a colon. Decided
  // afterwards, so the scanner itself never needs to track nesting.
  let next: Token | undefined;
  for (let t = tokens.length - 1; t >= 0; t -= 1) {
    const token = tokens[t]!;
    if (token.kind === "space") continue;
    if (token.kind === "string" && next?.kind === "punct" && text[next.start] === ":") {
      token.kind = "key";
    }
    next = token;
  }

  return tokens;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPES[c]!);
}

/**
 * The highlighted document. `errorAt`, when given, wraps that one character in
 * a `<mark>` — or appends an empty marker when it equals the length, which is
 * how "the input ended early" is shown.
 *
 * A trailing newline gets a space after it: a `<pre>` collapses a final empty
 * line that a textarea still shows, and the two layers must stay the same
 * height or the caret drifts away from the text.
 */
export function highlightJson(text: string, errorAt = -1): string {
  let html = "";
  for (const token of tokenizeJson(text)) {
    const cls = token.kind === "space" ? "" : `tok-${token.kind}`;
    const wrap = (part: string) =>
      part.length === 0 ? "" : cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);

    if (errorAt >= token.start && errorAt < token.end) {
      const offset = errorAt - token.start;
      const raw = text.slice(token.start, token.end);
      // A newline cannot carry a visible mark, so it is marked as a space-width
      // cell just before the line break instead.
      const bad = raw[offset] === "\n" ? " " : raw[offset]!;
      const rest = raw[offset] === "\n" ? raw.slice(offset) : raw.slice(offset + 1);
      html += wrap(raw.slice(0, offset));
      html += `<mark class="tok-error">${escapeHtml(bad)}</mark>`;
      html += wrap(rest);
    } else {
      html += wrap(text.slice(token.start, token.end));
    }
  }
  if (errorAt >= text.length && errorAt >= 0) html += `<mark class="tok-error tok-error--end"> </mark>`;
  if (text.endsWith("\n")) html += " ";
  return html;
}
