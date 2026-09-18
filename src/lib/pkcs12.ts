/**
 * PKCS#12 (.p12 / .pfx) — RFC 7292.
 *
 * One file holding a private key, its certificate and the chain above it, all
 * under one password. It is what `openssl pkcs12` writes, what a modern JVM
 * uses as a keystore, and what Windows and macOS import.
 *
 * Two different key derivations live in here, which is the format's oddest
 * feature and worth stating plainly:
 *
 *   - the private key is encrypted with **PBES2** — PBKDF2-HMAC-SHA256 into
 *     AES-256-CBC — all of which WebCrypto does natively;
 *   - the integrity MAC uses **PKCS#12's own KDF** from RFC 7292 appendix B.2,
 *     which nothing implements for us and so is written out below.
 *
 * The alternative to B.2 is PBMAC1 (RFC 9579), which is PBKDF2 and much nicer,
 * but it is from 2024 and nothing old enough to still ask for a .p12 can read
 * it. So: B.2.
 */

import {
  bmpString,
  concat,
  explicit,
  integer,
  nullValue,
  octetString,
  oid,
  sequence,
  set,
  utf16be,
} from "./asn1";

const OID = {
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  keyBag: "1.2.840.113549.1.12.10.1.1",
  pkcs8ShroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  friendlyName: "1.2.840.113549.1.9.20",
  localKeyId: "1.2.840.113549.1.9.21",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  hmacWithSha256: "1.2.840.113549.2.9",
  aes256Cbc: "2.16.840.1.101.3.4.1.42",
  sha256: "2.16.840.1.101.3.4.2.1",
} as const;

/**
 * PBKDF2 rounds for the private key. Well above OpenSSL's traditional 2048,
 * because this number is the only thing between a stolen .p12 and the key
 * inside it, and WebCrypto does it in milliseconds.
 */
const KEY_ITERATIONS = 200_000;

/** MAC rounds. Left at the customary 2048: it is an integrity check, and the
 * B.2 KDF below runs one hash per round in JavaScript. */
const MAC_ITERATIONS = 2048;

/* --------------------------------------------------- RFC 7292 appendix B.2 */

/** SHA-256: 32-byte output, 64-byte block. */
const HASH_LENGTH = 32;
const BLOCK_LENGTH = 64;

/**
 * The password as PKCS#12 wants it: UTF-16BE with the BMPString's two
 * terminating zero bytes. Feeding it UTF-8 produces a file that every other
 * implementation rejects, and is the classic way to get this wrong.
 */
function passwordBytes(password: string): Uint8Array {
  return concat(utf16be(password), Uint8Array.of(0, 0));
}

/** `source` repeated to fill a whole number of v-byte blocks. */
function fillBlocks(source: Uint8Array): Uint8Array {
  if (source.length === 0) return new Uint8Array(0);
  const length = BLOCK_LENGTH * Math.ceil(source.length / BLOCK_LENGTH);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = source[i % source.length]!;
  return out;
}

/** `block = (block + addend + 1) mod 2^(8*len)`, big-endian, in place. */
function addWithCarry(block: Uint8Array, at: number, addend: Uint8Array): void {
  let carry = 1;
  for (let i = BLOCK_LENGTH - 1; i >= 0; i -= 1) {
    const sum = block[at + i]! + addend[i]! + carry;
    block[at + i] = sum & 0xff;
    carry = sum >> 8;
  }
}

/**
 * The PKCS#12 key derivation function (RFC 7292 B.2).
 *
 * `id` selects what is being derived: 1 a key, 2 an IV, 3 a MAC key. Only the
 * MAC key is needed here, since PBES2 handles the encryption side.
 */
async function pkcs12Kdf(
  password: string,
  salt: Uint8Array,
  id: number,
  iterations: number,
  size: number,
): Promise<Uint8Array> {
  const diversifier = new Uint8Array(BLOCK_LENGTH).fill(id);
  const expandedSalt = fillBlocks(salt);
  const expandedPassword = fillBlocks(passwordBytes(password));
  const material = concat(expandedSalt, expandedPassword);

  const out = new Uint8Array(Math.ceil(size / HASH_LENGTH) * HASH_LENGTH);
  for (let chunk = 0; chunk * HASH_LENGTH < size; chunk += 1) {
    let a = concat(diversifier, material);
    for (let round = 0; round < iterations; round += 1) {
      a = new Uint8Array(await crypto.subtle.digest("SHA-256", a.slice().buffer));
    }
    out.set(a, chunk * HASH_LENGTH);

    // Fold this round's output back into the material for the next chunk.
    const b = fillBlocks(a).subarray(0, BLOCK_LENGTH);
    for (let at = 0; at < material.length; at += BLOCK_LENGTH) addWithCarry(material, at, b);
  }
  return out.subarray(0, size);
}

/* ----------------------------------------------------------------- PBES2 */

interface Pbes2 {
  readonly algorithmId: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** PBES2 AlgorithmIdentifier: PBKDF2-HMAC-SHA256 feeding AES-256-CBC. */
function pbes2AlgorithmId(salt: Uint8Array, iv: Uint8Array, iterations: number): Uint8Array {
  return sequence(
    oid(OID.pbes2),
    sequence(
      sequence(
        oid(OID.pbkdf2),
        sequence(
          octetString(salt),
          integer(iterations),
          integer(32),
          sequence(oid(OID.hmacWithSha256), nullValue()),
        ),
      ),
      sequence(oid(OID.aes256Cbc), octetString(iv)),
    ),
  );
}

async function pbes2Encrypt(password: string, plaintext: Uint8Array): Promise<Pbes2> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));

  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KEY_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plaintext.slice().buffer),
  );
  return { algorithmId: pbes2AlgorithmId(salt, iv, KEY_ITERATIONS), ciphertext };
}

/* ------------------------------------------------------------------- bags */

function attribute(id: string, value: Uint8Array): Uint8Array {
  return sequence(oid(id), set(value));
}

/**
 * Bag attributes. `localKeyId` is not decoration: a JVM pairs a key with its
 * certificate by matching this value, and a .p12 without it loads as a bare
 * trusted certificate with no key attached.
 */
function bagAttributes(alias: string, localKeyId: Uint8Array | null): Uint8Array[] {
  const attributes = [attribute(OID.friendlyName, bmpString(alias))];
  if (localKeyId) attributes.push(attribute(OID.localKeyId, octetString(localKeyId)));
  return attributes;
}

function certBag(der: Uint8Array, alias: string, localKeyId: Uint8Array | null): Uint8Array {
  return sequence(
    oid(OID.certBag),
    explicit(0, sequence(oid(OID.x509Certificate), explicit(0, octetString(der)))),
    set(...bagAttributes(alias, localKeyId)),
  );
}

function contentInfoData(content: Uint8Array): Uint8Array {
  return sequence(oid(OID.data), explicit(0, octetString(content)));
}

export interface Pkcs12Input {
  readonly password: string;
  readonly alias: string;
  /** PKCS#8 PrivateKeyInfo. */
  readonly pkcs8: Uint8Array;
  /** The leaf certificate, then each issuer above it. */
  readonly chain: readonly Uint8Array[];
  /** Ties the key to its certificate; the subject key identifier serves well. */
  readonly localKeyId: Uint8Array;
}

/**
 * Builds a .p12.
 *
 * The certificates go in unencrypted and the key goes in shrouded. That is a
 * deliberate split, not a shortcut: certificates are public by construction, so
 * encrypting them buys nothing, and leaving them readable means `openssl pkcs12
 * -info -nokeys` can list the file without the password.
 */
export async function buildPkcs12(input: Pkcs12Input): Promise<Uint8Array> {
  if (input.chain.length === 0) throw new Error("A keystore needs at least one certificate.");

  const certBags = input.chain.map((der, index) =>
    index === 0
      ? certBag(der, input.alias, input.localKeyId)
      : certBag(der, `${input.alias}-issuer-${index}`, null),
  );

  const shrouded = await pbes2Encrypt(input.password, input.pkcs8);
  const keyBag = sequence(
    oid(OID.pkcs8ShroudedKeyBag),
    explicit(0, sequence(shrouded.algorithmId, octetString(shrouded.ciphertext))),
    set(...bagAttributes(input.alias, input.localKeyId)),
  );

  const authenticatedSafe = sequence(
    contentInfoData(sequence(...certBags)),
    contentInfoData(sequence(keyBag)),
  );

  // The MAC covers the AuthenticatedSafe bytes, not the ContentInfo wrapping them.
  const macSalt = crypto.getRandomValues(new Uint8Array(20));
  const macKeyBytes = await pkcs12Kdf(input.password, macSalt, 3, MAC_ITERATIONS, HASH_LENGTH);
  const macKey = await crypto.subtle.importKey(
    "raw",
    macKeyBytes.slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", macKey, authenticatedSafe.slice().buffer),
  );

  return sequence(
    integer(3),
    contentInfoData(authenticatedSafe),
    sequence(
      sequence(sequence(oid(OID.sha256), nullValue()), octetString(mac)),
      octetString(macSalt),
      integer(MAC_ITERATIONS),
    ),
  );
}
