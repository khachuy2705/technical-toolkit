/**
 * JKS — the legacy Java keystore.
 *
 * Java 9 onwards defaults to PKCS#12 and warns on every JKS it opens, so the
 * only reason this exists is the stack that still insists: a JDK 8 Tomcat, a
 * WebLogic domain, an appliance whose config file says `storetype JKS`.
 *
 * The format is Sun's own, never standardised, and defined only by the source
 * of `sun.security.provider.JavaKeyStore` and `KeyProtector`. It is written out
 * here as that code behaves, quirks included:
 *
 *   - the password is hashed as UTF-16BE with no terminator;
 *   - the private key is protected by a SHA-1 keystream XOR, not a cipher;
 *   - the whole file is sealed with `SHA-1(password || "Mighty Aphrodite" || body)`;
 *   - aliases are lower-cased, because Java lower-cases them on the way in.
 *
 * The key protection is weak by any modern reading — a SHA-1 stream, no
 * iteration count, no MAC over the key itself. Nothing can be done about that
 * from here; it is the format. The .p12 next to it is the one to prefer.
 */

import { concat, nullValue, octetString, oid, sequence } from "./asn1";

/** `0xFEEDFEED`. JCEKS, which this is not, uses `0xCECECECE`. */
const MAGIC = 0xfeedfeed;
const VERSION = 2;
const PRIVATE_KEY_ENTRY = 1;

/** Sun's OID for the proprietary key protector. Nothing else uses it. */
const KEY_PROTECTOR_OID = "1.3.6.1.4.1.42.2.17.1.1";

/** The literal salt in the keystore digest. Yes, really. */
const DIGEST_SALT = "Mighty Aphrodite";

const SALT_LENGTH = 20;
const DIGEST_LENGTH = 20;

/** Java's `Password.toByteArray`: UTF-16BE, and no trailing NUL — unlike PKCS#12. */
function javaPassword(password: string): Uint8Array {
  const out = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i += 1) {
    const code = password.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

async function sha1(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-1", concat(...parts).slice().buffer);
  return new Uint8Array(digest);
}

/**
 * `KeyProtector.protect`: a SHA-1 keystream XORed over the PKCS#8 key, followed
 * by a SHA-1 of the password and the plaintext as an integrity check.
 *
 * The keystream is `W(1) = SHA1(password || salt)`, then
 * `W(n) = SHA1(password || W(n-1))`, concatenated until it covers the key.
 */
async function protectKey(password: string, pkcs8: Uint8Array): Promise<Uint8Array> {
  const passwordBytes = javaPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  const keystream = new Uint8Array(Math.ceil(pkcs8.length / DIGEST_LENGTH) * DIGEST_LENGTH);
  let previous: Uint8Array = salt;
  for (let at = 0; at < keystream.length; at += DIGEST_LENGTH) {
    previous = await sha1(passwordBytes, previous);
    keystream.set(previous, at);
  }

  const encrypted = new Uint8Array(pkcs8.length);
  for (let i = 0; i < pkcs8.length; i += 1) encrypted[i] = pkcs8[i]! ^ keystream[i]!;

  const check = await sha1(passwordBytes, pkcs8);
  const protectedKey = concat(salt, encrypted, check);

  // Wrapped as an EncryptedPrivateKeyInfo. The AlgorithmIdentifier's parameters
  // field is an explicit NULL rather than being omitted: ASN.1 makes it
  // optional and Java itself reads only the OID, but every keystore keytool
  // writes has the NULL there, and readers exist that require it.
  return sequence(
    sequence(oid(KEY_PROTECTOR_OID), nullValue()),
    octetString(protectedKey),
  );
}

/* ------------------------------------------------------ DataOutputStream */

/** Mirrors `java.io.DataOutputStream`, which is what defines the byte order. */
class JavaWriter {
  private readonly parts: Uint8Array[] = [];

  bytes(value: Uint8Array): void {
    this.parts.push(value);
  }

  int(value: number): void {
    this.parts.push(
      Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff),
    );
  }

  long(value: number): void {
    const big = BigInt(value);
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i -= 1) out[i] = Number((big >> BigInt((7 - i) * 8)) & 0xffn);
    this.parts.push(out);
  }

  /**
   * `writeUTF`: a two-byte length and Java's modified UTF-8, in which a NUL is
   * two bytes and anything outside the BMP is written as its two surrogates.
   * Identical to plain UTF-8 for the ASCII aliases this tool produces, but the
   * difference is real for a non-ASCII one.
   */
  utf(text: string): void {
    const body: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0x0001 && code <= 0x007f) {
        body.push(code);
      } else if (code <= 0x07ff) {
        body.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else {
        body.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    if (body.length > 0xffff) throw new Error("That alias is too long for a Java keystore.");
    this.parts.push(Uint8Array.of(body.length >> 8, body.length & 0xff), Uint8Array.from(body));
  }

  result(): Uint8Array {
    return concat(...this.parts);
  }
}

export interface JksInput {
  readonly password: string;
  readonly alias: string;
  /** PKCS#8 PrivateKeyInfo. */
  readonly pkcs8: Uint8Array;
  /** The leaf certificate, then each issuer above it. */
  readonly chain: readonly Uint8Array[];
  /** Entry creation time; defaults to now. */
  readonly created?: Date;
}

/** keytool refuses to open a keystore whose password is shorter than this. */
export const JKS_MIN_PASSWORD = 6;

/**
 * Builds a .jks holding one private key entry and its chain.
 *
 * The trailing digest is taken over the password, the fixed salt and every byte
 * of the body, which is how Java notices both a wrong password and a truncated
 * file — the same check reports both, so a corrupt keystore reports itself as a
 * bad password.
 */
export async function buildJks(input: JksInput): Promise<Uint8Array> {
  if (input.chain.length === 0) throw new Error("A keystore needs at least one certificate.");
  if (input.password.length < JKS_MIN_PASSWORD) {
    throw new Error(`A Java keystore password must be at least ${JKS_MIN_PASSWORD} characters.`);
  }

  const writer = new JavaWriter();
  writer.int(MAGIC);
  writer.int(VERSION);
  writer.int(1); // one entry

  writer.int(PRIVATE_KEY_ENTRY);
  writer.utf(input.alias.toLowerCase());
  writer.long((input.created ?? new Date()).getTime());

  const protectedKey = await protectKey(input.password, input.pkcs8);
  writer.int(protectedKey.length);
  writer.bytes(protectedKey);

  writer.int(input.chain.length);
  for (const der of input.chain) {
    // Version 2 of the format names each certificate's type; version 1 did not.
    writer.utf("X.509");
    writer.int(der.length);
    writer.bytes(der);
  }

  const body = writer.result();
  const digest = await sha1(
    javaPassword(input.password),
    new TextEncoder().encode(DIGEST_SALT),
    body,
  );
  return concat(body, digest);
}
