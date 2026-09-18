/**
 * PEM: base64 DER between BEGIN/END lines (RFC 7468).
 *
 * The encoder is trivial. The decoder is where the care goes, because what a
 * user pastes has been through a terminal, a ticket system and a chat window
 * first: CRLFs, leading whitespace, smart quotes around the dashes, a copied
 * "Bag Attributes" preamble from `openssl pkcs12`.
 */

/** Line width every PEM in the wild uses, from RFC 7468's 64-character rule. */
const LINE = 64;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a
  // keystore-sized array.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodePem(label: string, der: Uint8Array): string {
  const body = toBase64(der);
  const lines: string[] = [];
  for (let at = 0; at < body.length; at += LINE) lines.push(body.slice(at, at + LINE));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export interface PemBlock {
  readonly label: string;
  readonly der: Uint8Array;
  /** RFC 1421 headers, present only on OpenSSL's traditional encrypted keys. */
  readonly headers: Record<string, string>;
}

const BLOCK = /-{3,}\s*BEGIN\s+([A-Z0-9 ]+?)\s*-{3,}([\s\S]*?)-{3,}\s*END\s+\1\s*-{3,}/g;

/** `Name: value` lines at the top of a block, terminated by a blank line. */
const HEADER = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;

/**
 * Splits RFC 1421 headers from the base64 body.
 *
 * Only OpenSSL's traditional encrypted keys carry these — `Proc-Type: 4,ENCRYPTED`
 * and `DEK-Info: AES-256-CBC,<iv>`. They matter because the body cannot simply
 * have its non-base64 characters stripped: the letters in `ProcType` and
 * `ENCRYPTED` survive that and corrupt the key beyond recognition.
 */
function splitHeaders(body: string): { headers: Record<string, string>; base64: string } {
  const headers: Record<string, string> = {};
  const lines = body.replace(/\r\n/g, "\n").split("\n");

  let at = 0;
  while (at < lines.length && lines[at]!.trim().length === 0) at += 1;

  while (at < lines.length) {
    const match = HEADER.exec(lines[at]!);
    if (!match) break;
    let value = match[2]!.trim();
    // A header may be continued by a trailing backslash, per RFC 1421.
    while (value.endsWith("\\") && at + 1 < lines.length) {
      at += 1;
      value = value.slice(0, -1) + lines[at]!.trim();
    }
    headers[match[1]!] = value;
    at += 1;
  }

  // Headers are only headers when a blank line closes them; otherwise what was
  // matched is base64 that happens to contain a colon, so nothing is consumed.
  if (at === 0 || at >= lines.length || lines[at]!.trim().length !== 0) {
    return { headers: {}, base64: body.replace(/[^A-Za-z0-9+/=]/g, "") };
  }
  return {
    headers,
    base64: lines.slice(at).join("\n").replace(/[^A-Za-z0-9+/=]/g, ""),
  };
}

/**
 * Every PEM block in a blob, in order. A file may legitimately hold several —
 * a fullchain, or a key and its certificate in one bundle — so the caller
 * picks by label rather than this function guessing.
 */
export function decodePem(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  // Unicode dashes are what a word processor or chat client leaves behind.
  const normalised = text.replace(/[‐-―−]/g, "-");
  for (const match of normalised.matchAll(BLOCK)) {
    const label = match[1]!.trim();
    const { headers, base64 } = splitHeaders(match[2]!);
    try {
      blocks.push({ label, der: fromBase64(base64), headers });
    } catch {
      throw new Error(`The ${label} block is not valid base64.`);
    }
  }
  return blocks;
}

/**
 * The first block whose label matches one of `labels`, or bare DER if the input
 * has no BEGIN line at all — people do paste raw base64, and refusing it on a
 * technicality helps nobody.
 */
export function findPem(text: string, labels: readonly string[]): PemBlock {
  const blocks = decodePem(text);
  const match = blocks.find((block) => labels.includes(block.label));
  if (match) return match;

  if (blocks.length > 0) {
    throw new Error(
      `Expected ${labels[0]}, found ${blocks.map((b) => b.label).join(", ")}.`,
    );
  }

  const bare = text.replace(/\s+/g, "");
  if (bare.length > 0 && /^[A-Za-z0-9+/=]+$/.test(bare)) {
    try {
      return { label: labels[0]!, der: fromBase64(bare), headers: {} };
    } catch {
      // Falls through to the message below.
    }
  }
  throw new Error(`No ${labels[0]} block found.`);
}

/**
 * Reads a file the user picked, as PEM text.
 *
 * A certificate arrives as often in binary DER — a `.crt` or `.cer` straight
 * from Windows or a device — as it does in PEM, and the two are told apart by
 * the first byte: DER always opens with a SEQUENCE tag, and PEM is text. A DER
 * file is converted so that everything downstream only ever sees PEM.
 */
export function bytesToPemText(bytes: Uint8Array, derLabel: string): string {
  if (bytes[0] === 0x30) return encodePem(derLabel, bytes);
  return new TextDecoder().decode(bytes);
}
