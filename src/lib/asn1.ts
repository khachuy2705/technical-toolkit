/**
 * DER: just enough ASN.1 to build and read X.509.
 *
 * Certificates, CSRs and keystores are all DER underneath, so this is the floor
 * the rest of the certificate code stands on. It is deliberately small — DER
 * only (never BER), definite lengths only, and no schema machinery. Values are
 * plain `Uint8Array`s and every builder returns a complete TLV, so structures
 * nest by ordinary function calls.
 */

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  bmpString: 0x1e,
  sequence: 0x30,
  set: 0x31,
} as const;

/** Context-specific class bit, as used by the `[n]` tags all over X.509. */
export const CONTEXT = 0x80;
export const CONSTRUCTED = 0x20;

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * DER length: short form below 128, otherwise a byte count followed by
 * big-endian bytes. Certificates routinely exceed 255 bytes, keystores exceed
 * 65,535, so the long form has to be general rather than the usual two cases.
 */
function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One tag-length-value. Every builder below funnels through here. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), encodeLength(content.length), content);
}

export function sequence(...items: readonly Uint8Array[]): Uint8Array {
  return tlv(TAG.sequence, concat(...items));
}

/**
 * A DER SET is sorted by its members' encodings. Only SET OF needs the sort and
 * our sets have one member (an RDN's single attribute), but sorting keeps the
 * output valid if that ever changes.
 */
export function set(...items: readonly Uint8Array[]): Uint8Array {
  const sorted = [...items].sort(compareBytes);
  return tlv(TAG.set, concat(...sorted));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * INTEGER from a non-negative magnitude. DER integers are signed two's
 * complement, so a leading byte of 0x80 or more needs a zero in front or it
 * reads as negative — the reason serial numbers are sometimes 17 bytes long.
 */
export function integerFromBytes(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  const trimmed = magnitude.subarray(start);
  const content = trimmed[0]! & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
  return tlv(TAG.integer, content);
}

export function integer(value: number | bigint): Uint8Array {
  const big = BigInt(value);
  if (big < 0n) throw new Error("Negative integers are not needed here");
  if (big === 0n) return tlv(TAG.integer, Uint8Array.of(0));
  const bytes: number[] = [];
  for (let rest = big; rest > 0n; rest >>= 8n) bytes.unshift(Number(rest & 0xffn));
  return integerFromBytes(Uint8Array.from(bytes));
}

export function bitString(content: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(TAG.bitString, concat(Uint8Array.of(unusedBits), content));
}

/**
 * A BIT STRING carrying named bits, KeyUsage being the one that matters here.
 * DER requires the minimum number of bytes and the trailing zero bits counted,
 * so KeyUsage with only digitalSignature set is one byte with seven unused.
 */
export function namedBits(bits: readonly number[]): Uint8Array {
  if (bits.length === 0) return bitString(new Uint8Array(0), 0);
  const highest = Math.max(...bits);
  const bytes = new Uint8Array(Math.floor(highest / 8) + 1);
  for (const bit of bits) bytes[Math.floor(bit / 8)]! |= 0x80 >> bit % 8;
  return bitString(bytes, 7 - (highest % 8));
}

export function octetString(content: Uint8Array): Uint8Array {
  return tlv(TAG.octetString, content);
}

export function nullValue(): Uint8Array {
  return tlv(TAG.null, new Uint8Array(0));
}

export function boolean(value: boolean): Uint8Array {
  return tlv(TAG.boolean, Uint8Array.of(value ? 0xff : 0x00));
}

/**
 * OBJECT IDENTIFIER from dotted decimal. The first two arcs share one byte as
 * `40 * a + b`; the rest are base-128 with a continuation bit.
 */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0) throw new Error(`Bad OID: ${dotted}`);
    return value;
  });
  if (arcs.length < 2) throw new Error(`Bad OID: ${dotted}`);

  const out: number[] = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const base128: number[] = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      base128.unshift((rest % 128) | 0x80);
    }
    out.push(...base128);
  }
  return tlv(TAG.oid, Uint8Array.from(out));
}

const utf8Encoder = new TextEncoder();

export function utf8String(text: string): Uint8Array {
  return tlv(TAG.utf8String, utf8Encoder.encode(text));
}

export function printableString(text: string): Uint8Array {
  return tlv(TAG.printableString, utf8Encoder.encode(text));
}

export function ia5String(text: string): Uint8Array {
  return tlv(TAG.ia5String, utf8Encoder.encode(text));
}

/** PKCS#12 friendly names are BMPString: UTF-16BE, no BOM. */
export function bmpString(text: string): Uint8Array {
  return tlv(TAG.bmpString, utf16be(text));
}

export function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

/** The PrintableString repertoire; anything outside it has to be UTF8String. */
const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;

/**
 * Directory strings are encoded as PrintableString when they fit, UTF8String
 * otherwise. Both are legal for every attribute we emit, but tools display
 * PrintableString subjects more predictably, and it is what OpenSSL produces.
 */
export function directoryString(text: string): Uint8Array {
  return PRINTABLE.test(text) ? printableString(text) : utf8String(text);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * RFC 5280 dates: UTCTime through 2049, GeneralizedTime from 2050. The two-digit
 * year is the whole reason for the switch, and getting it wrong shifts a
 * certificate a century.
 */
export function time(date: Date): Uint8Array {
  const year = date.getUTCFullYear();
  const body =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  if (year >= 1950 && year <= 2049) {
    return tlv(TAG.utcTime, utf8Encoder.encode(pad(year % 100) + body));
  }
  return tlv(TAG.generalizedTime, utf8Encoder.encode(pad(year, 4) + body));
}

/** `[n]` holding one complete TLV — X.509's `[0] EXPLICIT Version`, and friends. */
export function explicit(tagNumber: number, inner: Uint8Array): Uint8Array {
  return tlv(CONTEXT | CONSTRUCTED | tagNumber, inner);
}

/** `[n]` replacing a primitive type's tag, as in GeneralName's dNSName. */
export function implicit(tagNumber: number, content: Uint8Array): Uint8Array {
  return tlv(CONTEXT | tagNumber, content);
}

/** `[n]` replacing a constructed type's tag, as in GeneralName's directoryName. */
export function implicitSequence(tagNumber: number, ...items: readonly Uint8Array[]): Uint8Array {
  return tlv(CONTEXT | CONSTRUCTED | tagNumber, concat(...items));
}

/* -------------------------------------------------------------- reading DER */

export interface DerNode {
  /** The identifier octet, so `0x30` for SEQUENCE. */
  readonly tag: number;
  /** Tag number with the class and constructed bits stripped. */
  readonly tagNumber: number;
  readonly constructed: boolean;
  readonly context: boolean;
  /** The value octets alone. */
  readonly content: Uint8Array;
  /** The whole TLV, which is what a re-encode needs. */
  readonly raw: Uint8Array;
}

/**
 * Reads one TLV at `offset`. Only ever pointed at files a user hands us, so it
 * refuses indefinite lengths and truncation rather than guessing; a bad PEM
 * should say so, not produce a certificate with silent nonsense in it.
 */
export function readDer(bytes: Uint8Array, offset = 0): DerNode {
  if (offset + 2 > bytes.length) throw new Error("Truncated DER");
  const tag = bytes[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("Multi-byte DER tags are not supported");

  const first = bytes[offset + 1]!;
  let length: number;
  let headerLength: number;
  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new Error("Indefinite DER lengths are not supported");
    if (count > 4) throw new Error("DER length is implausibly large");
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[offset + 2 + i]!;
    headerLength = 2 + count;
  }

  const start = offset + headerLength;
  if (start + length > bytes.length) throw new Error("Truncated DER");
  return {
    tag,
    tagNumber: tag & 0x1f,
    constructed: (tag & CONSTRUCTED) !== 0,
    context: (tag & 0xc0) === CONTEXT,
    content: bytes.subarray(start, start + length),
    raw: bytes.subarray(offset, start + length),
  };
}

/** The direct children of a constructed node, in order. */
export function readChildren(node: DerNode): DerNode[] {
  if (!node.constructed) throw new Error("Not a constructed DER value");
  const out: DerNode[] = [];
  let at = 0;
  while (at < node.content.length) {
    const child = readDer(node.content, at);
    out.push(child);
    at += child.raw.length;
  }
  return out;
}

/** Dotted decimal from an OBJECT IDENTIFIER's content octets. */
export function readOid(node: DerNode): string {
  if (node.tag !== TAG.oid) throw new Error("Expected an OID");
  const bytes = node.content;
  if (bytes.length === 0) throw new Error("Empty OID");
  const arcs = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

export function readInteger(node: DerNode): bigint {
  let value = 0n;
  for (const byte of node.content) value = (value << 8n) | BigInt(byte);
  return value;
}

const utf8Decoder = new TextDecoder();

export function readString(node: DerNode): string {
  if (node.tag === TAG.bmpString) {
    let out = "";
    for (let i = 0; i + 1 < node.content.length; i += 2) {
      out += String.fromCharCode((node.content[i]! << 8) | node.content[i + 1]!);
    }
    return out;
  }
  return utf8Decoder.decode(node.content);
}

/** Strips the unused-bit count from a BIT STRING's content octets. */
export function readBitString(node: DerNode): Uint8Array {
  if (node.tag !== TAG.bitString) throw new Error("Expected a BIT STRING");
  return node.content.subarray(1);
}
