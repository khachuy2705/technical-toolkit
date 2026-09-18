/**
 * Key pairs and signatures for the certificate tools.
 *
 * Everything goes through WebCrypto — the browser generates the key, the
 * browser signs, and the private key never exists anywhere else. The work here
 * is translation: WebCrypto speaks `RSASSA-PKCS1-v1_5` and `P-256`, X.509
 * speaks OIDs, and ECDSA signatures come out of WebCrypto in a different shape
 * from the one a certificate wants.
 */

import {
  bitString,
  integer,
  integerFromBytes,
  nullValue,
  octetString,
  oid,
  readChildren,
  readDer,
  readOid,
  sequence,
  type DerNode,
} from "./asn1";
import { findPem } from "./pem";

export const OID = {
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  ecdsaWithSha512: "1.2.840.10045.4.3.4",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  p521: "1.3.132.0.35",
} as const;

export type KeyAlgoId = "rsa-2048" | "rsa-3072" | "rsa-4096" | "ec-p256" | "ec-p384" | "ec-p521";
export type HashName = "SHA-256" | "SHA-384" | "SHA-512";

export interface KeyAlgo {
  readonly id: KeyAlgoId;
  readonly kind: "rsa" | "ec";
  readonly label: string;
  /** RSA modulus size, or the EC curve's field size. */
  readonly bits: number;
  /** Rough symmetric-equivalent strength, for the readout on the page. */
  readonly strength: number;
  readonly curve?: "P-256" | "P-384" | "P-521";
  readonly note: string;
  /** Hash that pairs with this key unless the user says otherwise. */
  readonly hash: HashName;
}

export const KEY_ALGOS: readonly KeyAlgo[] = [
  {
    id: "rsa-2048",
    kind: "rsa",
    label: "RSA 2048",
    bits: 2048,
    strength: 112,
    note: "accepted everywhere — the safe default",
    hash: "SHA-256",
  },
  {
    id: "rsa-3072",
    kind: "rsa",
    label: "RSA 3072",
    bits: 3072,
    strength: 128,
    note: "128-bit strength, noticeably slower to generate",
    hash: "SHA-256",
  },
  {
    id: "rsa-4096",
    kind: "rsa",
    label: "RSA 4096",
    bits: 4096,
    strength: 152,
    note: "common for a long-lived root CA; generation takes seconds",
    hash: "SHA-256",
  },
  {
    id: "ec-p256",
    kind: "ec",
    label: "ECDSA P-256",
    bits: 256,
    strength: 128,
    curve: "P-256",
    note: "as strong as RSA 3072, and far smaller",
    hash: "SHA-256",
  },
  {
    id: "ec-p384",
    kind: "ec",
    label: "ECDSA P-384",
    bits: 384,
    strength: 192,
    curve: "P-384",
    note: "the usual choice for an EC root CA",
    hash: "SHA-384",
  },
  {
    id: "ec-p521",
    kind: "ec",
    label: "ECDSA P-521",
    bits: 521,
    strength: 256,
    curve: "P-521",
    note: "rarely required; some load balancers refuse it",
    hash: "SHA-512",
  },
] as const;

export function keyAlgoById(id: string): KeyAlgo {
  const found = KEY_ALGOS.find((algo) => algo.id === id);
  if (!found) throw new Error(`Unknown key algorithm: ${id}`);
  return found;
}

function curveOid(curve: string): string {
  if (curve === "P-256") return OID.p256;
  if (curve === "P-384") return OID.p384;
  if (curve === "P-521") return OID.p521;
  throw new Error(`Unsupported curve: ${curve}`);
}

function curveFromOid(dotted: string): "P-256" | "P-384" | "P-521" {
  if (dotted === OID.p256) return "P-256";
  if (dotted === OID.p384) return "P-384";
  if (dotted === OID.p521) return "P-521";
  throw new Error(
    "That key uses an elliptic curve this tool does not support. Only P-256, P-384 and P-521 work in the browser.",
  );
}

/** WebCrypto parameters for importing or generating a key of this algorithm. */
function importParams(algo: KeyAlgo, hash: HashName): RsaHashedImportParams | EcKeyImportParams {
  return algo.kind === "rsa"
    ? { name: "RSASSA-PKCS1-v1_5", hash }
    : { name: "ECDSA", namedCurve: algo.curve! };
}

export interface GeneratedKey {
  readonly algo: KeyAlgo;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** SubjectPublicKeyInfo, ready to drop into a certificate or CSR. */
  readonly spki: Uint8Array;
  /** PKCS#8 PrivateKeyInfo — what the .key file and both keystores carry. */
  readonly pkcs8: Uint8Array;
}

export async function generateKeyPair(algo: KeyAlgo, hash: HashName): Promise<GeneratedKey> {
  const params: RsaHashedKeyGenParams | EcKeyGenParams =
    algo.kind === "rsa"
      ? {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: algo.bits,
          // 65537. Anything else is a bad idea and some stacks reject it.
          publicExponent: Uint8Array.of(0x01, 0x00, 0x01),
          hash,
        }
      : { name: "ECDSA", namedCurve: algo.curve! };

  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    algo,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    spki: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    pkcs8: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

/** The AlgorithmIdentifier that names the signature in a certificate or CSR. */
export function signatureAlgorithmId(algo: KeyAlgo, hash: HashName): Uint8Array {
  if (algo.kind === "rsa") {
    const byHash = {
      "SHA-256": OID.sha256WithRsa,
      "SHA-384": OID.sha384WithRsa,
      "SHA-512": OID.sha512WithRsa,
    } as const;
    // RSA signature algorithms carry an explicit NULL parameter (RFC 4055);
    // ECDSA ones must omit parameters entirely.
    return sequence(oid(byHash[hash]), nullValue());
  }
  const byHash = {
    "SHA-256": OID.ecdsaWithSha256,
    "SHA-384": OID.ecdsaWithSha384,
    "SHA-512": OID.ecdsaWithSha512,
  } as const;
  return sequence(oid(byHash[hash]));
}

/**
 * Signs `data`, returning the signature exactly as a certificate's BIT STRING
 * wants it.
 *
 * WebCrypto hands back an ECDSA signature as the raw `r || s` pair of IEEE
 * P1363; X.509 wants `SEQUENCE { INTEGER r, INTEGER s }`. Skipping this
 * conversion produces a certificate that looks fine and verifies nowhere.
 */
export async function signData(
  privateKey: CryptoKey,
  algo: KeyAlgo,
  hash: HashName,
  data: Uint8Array,
): Promise<Uint8Array> {
  const params: AlgorithmIdentifier | EcdsaParams =
    algo.kind === "rsa" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash };
  const raw = new Uint8Array(await crypto.subtle.sign(params, privateKey, data.slice().buffer));
  if (algo.kind === "rsa") return raw;

  const half = raw.length / 2;
  return sequence(
    integerFromBytes(raw.subarray(0, half)),
    integerFromBytes(raw.subarray(half)),
  );
}

/* ------------------------------------------------------- reading a key in */

/** The algorithm a PKCS#8 or SPKI blob declares, read from its AlgorithmIdentifier. */
function algoFromAlgorithmId(node: DerNode): KeyAlgo {
  const parts = readChildren(node);
  const algorithm = readOid(parts[0]!);

  if (algorithm === OID.rsaEncryption) {
    // The modulus length is not in the AlgorithmIdentifier, so the size is
    // resolved by the caller once the key is imported. 2048 is a placeholder
    // that only affects the label if that never happens.
    return keyAlgoById("rsa-2048");
  }
  if (algorithm === OID.ecPublicKey) {
    if (!parts[1]) throw new Error("The EC key does not name a curve.");
    const curve = curveFromOid(readOid(parts[1]));
    return keyAlgoById(curve === "P-256" ? "ec-p256" : curve === "P-384" ? "ec-p384" : "ec-p521");
  }
  throw new Error(
    "That key is neither RSA nor ECDSA. Only those two can sign a certificate in a browser.",
  );
}

/**
 * PKCS#1 `RSA PRIVATE KEY` wrapped as PKCS#8, which is the only form WebCrypto
 * imports. The body is copied verbatim — PKCS#8's privateKey octet string is
 * defined to hold exactly the PKCS#1 structure.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return sequence(
    integer(0),
    sequence(oid(OID.rsaEncryption), nullValue()),
    octetString(pkcs1),
  );
}

/**
 * SEC1 `EC PRIVATE KEY` wrapped as PKCS#8. The curve lives in the SEC1 body's
 * `[0]` parameters and has to be lifted into the AlgorithmIdentifier, where
 * PKCS#8 expects it.
 */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const parts = readChildren(readDer(sec1));
  const parameters = parts.find((part) => part.context && part.tagNumber === 0);
  if (!parameters) {
    throw new Error(
      "That EC key does not name its curve. Re-export it with `openssl pkcs8 -topk8 -nocrypt`.",
    );
  }
  const curve = curveFromOid(readOid(readDer(parameters.content)));
  return sequence(
    integer(0),
    sequence(oid(OID.ecPublicKey), oid(curveOid(curve))),
    octetString(sec1),
  );
}

export interface ImportedKey {
  readonly algo: KeyAlgo;
  readonly privateKey: CryptoKey;
  readonly pkcs8: Uint8Array;
}

const KEY_LABELS = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY"];

/**
 * Imports a private key from whatever PEM the user pasted.
 *
 * `hash` matters only for RSA: WebCrypto binds a hash to the key at import
 * time, so a key imported for SHA-256 cannot later sign with SHA-384.
 */
export async function importPrivateKeyPem(text: string, hash: HashName): Promise<ImportedKey> {
  const block = findPem(text, KEY_LABELS);

  if (block.label === "ENCRYPTED PRIVATE KEY") {
    throw new Error(
      "That key is passphrase-encrypted. Decrypt it first: `openssl pkcs8 -topk8 -nocrypt -in enc.key -out plain.key`.",
    );
  }

  const pkcs8 =
    block.label === "RSA PRIVATE KEY"
      ? pkcs1ToPkcs8(block.der)
      : block.label === "EC PRIVATE KEY"
        ? sec1ToPkcs8(block.der)
        : block.der;

  const parts = readChildren(readDer(pkcs8));
  if (parts.length < 3) throw new Error("That does not look like a private key.");
  let algo = algoFromAlgorithmId(parts[1]!);

  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8.slice().buffer,
      importParams(algo, hash),
      true,
      ["sign"],
    );
  } catch {
    throw new Error("The browser could not read that private key. Check that the PEM is complete.");
  }

  if (algo.kind === "rsa") {
    const modulus = (privateKey.algorithm as RsaHashedKeyAlgorithm).modulusLength;
    algo = KEY_ALGOS.find((a) => a.kind === "rsa" && a.bits === modulus) ?? algo;
  }
  return { algo, privateKey, pkcs8 };
}

/** Imports a SubjectPublicKeyInfo, which is how a CA's public key reaches us. */
export async function importSpki(spki: Uint8Array, hash: HashName): Promise<{ algo: KeyAlgo; key: CryptoKey }> {
  const parts = readChildren(readDer(spki));
  let algo = algoFromAlgorithmId(parts[0]!);
  const key = await crypto.subtle.importKey(
    "spki",
    spki.slice().buffer,
    importParams(algo, hash),
    true,
    ["verify"],
  );
  if (algo.kind === "rsa") {
    const modulus = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
    algo = KEY_ALGOS.find((a) => a.kind === "rsa" && a.bits === modulus) ?? algo;
  }
  return { algo, key };
}

/**
 * The subjectPublicKey bits of an SPKI, which is what a subject key identifier
 * hashes (RFC 5280 §4.2.1.2, method 1).
 */
export function publicKeyBits(spki: Uint8Array): Uint8Array {
  const parts = readChildren(readDer(spki));
  const bits = parts[1]!;
  return bits.content.subarray(1);
}

/** Rebuilds an SPKI from its parts, for the CSR path where only bits are held. */
export function buildSpki(algorithmId: Uint8Array, keyBits: Uint8Array): Uint8Array {
  return sequence(algorithmId, bitString(keyBits));
}
