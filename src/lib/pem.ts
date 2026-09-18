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
}

const BLOCK = /-{3,}\s*BEGIN\s+([A-Z0-9 ]+?)\s*-{3,}([\s\S]*?)-{3,}\s*END\s+\1\s*-{3,}/g;

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
    const base64 = match[2]!.replace(/[^A-Za-z0-9+/=]/g, "");
    try {
      blocks.push({ label: match[1]!.trim(), der: fromBase64(base64) });
    } catch {
      throw new Error(`The ${match[1]!.trim()} block is not valid base64.`);
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
      return { label: labels[0]!, der: fromBase64(bare) };
    } catch {
      // Falls through to the message below.
    }
  }
  throw new Error(`No ${labels[0]} block found.`);
}
