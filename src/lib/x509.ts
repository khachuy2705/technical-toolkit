/**
 * X.509 certificates and PKCS#10 requests.
 *
 * Builds a TBSCertificate or CertificationRequestInfo, has WebCrypto sign it,
 * and wraps the result. It also reads just enough of an existing certificate to
 * sign against it: an issuer's name, key and identifier.
 *
 * The naming follows RFC 5280 rather than anything friendlier, so the structures
 * here can be read next to the specification.
 */

import {
  boolean,
  bitString,
  directoryString,
  explicit,
  ia5String,
  implicit,
  implicitSequence,
  integer,
  integerFromBytes,
  namedBits,
  octetString,
  oid,
  readBitString,
  readChildren,
  readDer,
  readInteger,
  readOid,
  readString,
  sequence,
  set,
  time,
  type DerNode,
} from "./asn1";
import { toHex } from "./hash";
import { parseIpv4 } from "./ipv4";
import { parseIpv6 } from "./ipv6";
import { encodePem, findPem } from "./pem";
import {
  publicKeyBits,
  signatureAlgorithmId,
  signData,
  type HashName,
  type KeyAlgo,
} from "./keys";

/* ------------------------------------------------------------ the subject */

/** Subject attributes, in the order a DN conventionally lists them. */
export const DN_FIELDS = [
  { id: "CN", oid: "2.5.4.3", label: "Common name", placeholder: "example.com" },
  { id: "O", oid: "2.5.4.10", label: "Organisation", placeholder: "Example Ltd" },
  { id: "OU", oid: "2.5.4.11", label: "Organisational unit", placeholder: "IT" },
  { id: "L", oid: "2.5.4.7", label: "City / locality", placeholder: "Ha Noi" },
  { id: "ST", oid: "2.5.4.8", label: "State / province", placeholder: "Ha Noi" },
  { id: "C", oid: "2.5.4.6", label: "Country code", placeholder: "VN" },
  { id: "emailAddress", oid: "1.2.840.113549.1.9.1", label: "Email", placeholder: "admin@example.com" },
] as const;

export type DnFieldId = (typeof DN_FIELDS)[number]["id"];
export type Dn = Partial<Record<DnFieldId, string>>;

/**
 * A DN as RDNSequence. Empty fields are dropped, and the country code is
 * upper-cased because X.509 defines it as an ISO 3166 alpha-2 code and
 * verifiers do compare it literally.
 */
export function encodeDn(dn: Dn): Uint8Array {
  const rdns: Uint8Array[] = [];
  for (const field of DN_FIELDS) {
    const raw = dn[field.id]?.trim();
    if (!raw) continue;
    const value = field.id === "C" ? raw.toUpperCase() : raw;
    // emailAddress is a PKCS#9 attribute and is always IA5String, never a
    // directory string — encoding it as UTF8String makes OpenSSL grumble.
    const encoded = field.id === "emailAddress" ? ia5String(value) : directoryString(value);
    rdns.push(set(sequence(oid(field.oid), encoded)));
  }
  return sequence(...rdns);
}

const DN_LABEL_BY_OID = new Map(DN_FIELDS.map((f) => [f.oid as string, f.id as string]));

/** A DN rendered the way OpenSSL prints one, for display only. */
export function describeDn(node: DerNode): string {
  const parts: string[] = [];
  for (const rdn of readChildren(node)) {
    for (const attribute of readChildren(rdn)) {
      const pair = readChildren(attribute);
      const key = DN_LABEL_BY_OID.get(readOid(pair[0]!)) ?? readOid(pair[0]!);
      parts.push(`${key}=${readString(pair[1]!)}`);
    }
  }
  return parts.join(", ");
}

/* ----------------------------------------------------- subject alt names */

export type SanKind = "dns" | "ip" | "email" | "uri";

export interface San {
  readonly kind: SanKind;
  readonly value: string;
  /** IP addresses go into the certificate as bytes, not text. */
  readonly bytes?: Uint8Array;
}

const TAG_BY_KIND: Record<SanKind, number> = { email: 1, dns: 2, uri: 6, ip: 7 };

function ipv4Bytes(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function ipv6Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Works out what one SAN entry is from its shape.
 *
 * Nobody wants to pick a type from a dropdown for each name, and the four kinds
 * are unambiguous in practice: an `@` is an address, a `://` is a URI, digits
 * and dots are IPv4, colons are IPv6, everything else is a host name.
 */
export function parseSan(raw: string): San {
  const value = raw.trim().replace(/^(DNS|IP|email|URI):/i, "").trim();
  if (value.length === 0) throw new Error("Empty name");

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { kind: "uri", value };
  if (value.includes("@")) return { kind: "email", value };

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return { kind: "ip", value, bytes: ipv4Bytes(parseIpv4(value)) };
  }
  if (value.includes(":")) {
    const parsed = parseIpv6(value);
    return { kind: "ip", value, bytes: ipv6Bytes(parsed.value) };
  }

  // A wildcard is legal in the leftmost label only, which is worth saying now
  // rather than letting a browser reject the certificate later.
  if (value.includes("*") && !/^\*\.[^*]+$/.test(value)) {
    throw new Error(`"${value}" — a wildcard is only allowed as the leftmost label, like *.example.com`);
  }
  if (!/^[a-z0-9*]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i.test(value)) {
    throw new Error(`"${value}" is not a host name, IP address, email address or URL.`);
  }
  return { kind: "dns", value };
}

/**
 * Parses a whole SAN list, one per line or comma-separated, dropping duplicates.
 * The first bad entry stops the lot, naming itself.
 */
export function parseSans(text: string): San[] {
  const seen = new Set<string>();
  const out: San[] = [];
  for (const piece of text.split(/[\n,;]+/)) {
    if (piece.trim().length === 0) continue;
    const san = parseSan(piece);
    const key = `${san.kind}:${san.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(san);
  }
  return out;
}

function encodeSans(sans: readonly San[]): Uint8Array {
  return sequence(
    ...sans.map((san) =>
      san.kind === "ip"
        ? implicit(TAG_BY_KIND.ip, san.bytes!)
        : implicit(TAG_BY_KIND[san.kind], new TextEncoder().encode(san.value)),
    ),
  );
}

/* ------------------------------------------------------------- purposes */

/** KeyUsage bit positions, in the order RFC 5280 §4.2.1.3 defines them. */
export const KEY_USAGE_BITS = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
} as const;

export type KeyUsageName = keyof typeof KEY_USAGE_BITS;

export const KEY_USAGE_LABELS: Record<KeyUsageName, string> = {
  digitalSignature: "Digital Signature",
  nonRepudiation: "Non Repudiation",
  keyEncipherment: "Key Encipherment",
  dataEncipherment: "Data Encipherment",
  keyAgreement: "Key Agreement",
  keyCertSign: "Certificate Sign",
  cRLSign: "CRL Sign",
};

export type PurposeId =
  | "tls-server"
  | "tls-client"
  | "code-signing"
  | "document-signing"
  | "email"
  | "timestamping";

export interface Purpose {
  readonly id: PurposeId;
  readonly label: string;
  readonly vi: string;
  readonly hint: string;
  readonly usage: readonly KeyUsageName[];
  readonly eku: readonly string[];
  readonly ekuLabel: string;
}

/**
 * What the certificate is allowed to do, as a tick list.
 *
 * Each purpose contributes its key usages and its extended key usage OID; the
 * union of the ticked ones becomes the two extensions. Ticking nothing is
 * allowed and means a certificate with no EKU, which is what "valid for
 * anything" looks like — the page says so rather than silently deciding.
 */
export const PURPOSES: readonly Purpose[] = [
  {
    id: "tls-server",
    label: "HTTPS / TLS server",
    vi: "Mã hoá HTTPS",
    hint: "A web server, an API, a load balancer — the usual reason to be here.",
    usage: ["digitalSignature", "keyEncipherment"],
    eku: ["1.3.6.1.5.5.7.3.1"],
    ekuLabel: "TLS Web Server Authentication",
  },
  {
    id: "tls-client",
    label: "TLS client authentication",
    vi: "Xác thực client",
    hint: "Mutual TLS: the certificate identifies the client to the server.",
    usage: ["digitalSignature"],
    eku: ["1.3.6.1.5.5.7.3.2"],
    ekuLabel: "TLS Web Client Authentication",
  },
  {
    id: "document-signing",
    label: "Document signing",
    vi: "Ký số tài liệu",
    hint: "Signing PDFs, invoices and XML. Adds Non Repudiation, which a signature needs and TLS does not.",
    usage: ["digitalSignature", "nonRepudiation"],
    eku: ["1.3.6.1.4.1.311.10.3.12"],
    ekuLabel: "Document Signing",
  },
  {
    id: "code-signing",
    label: "Code signing",
    vi: "Ký phần mềm",
    hint: "Signing binaries and installers. Real platforms only trust a code-signing CA they already know.",
    usage: ["digitalSignature"],
    eku: ["1.3.6.1.5.5.7.3.3"],
    ekuLabel: "Code Signing",
  },
  {
    id: "email",
    label: "Email (S/MIME)",
    vi: "Ký và mã hoá email",
    hint: "Signing and encrypting mail. Put the address in the subject alternative names too.",
    usage: ["digitalSignature", "nonRepudiation", "keyEncipherment"],
    eku: ["1.3.6.1.5.5.7.3.4"],
    ekuLabel: "E-mail Protection",
  },
  {
    id: "timestamping",
    label: "Time stamping",
    vi: "Đóng dấu thời gian",
    hint: "An RFC 3161 timestamp authority.",
    usage: ["digitalSignature", "nonRepudiation"],
    eku: ["1.3.6.1.5.5.7.3.8"],
    ekuLabel: "Time Stamping",
  },
] as const;

export const DEFAULT_PURPOSES: readonly PurposeId[] = ["tls-server"];

export function purposeById(id: string): Purpose {
  const found = PURPOSES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown purpose: ${id}`);
  return found;
}

export interface ResolvedUsage {
  readonly usage: KeyUsageName[];
  readonly eku: string[];
  readonly ekuLabels: string[];
  /** Set when a usage was dropped because the key cannot do it. */
  readonly note: string | null;
}

/**
 * The key usages and EKUs a set of purposes adds up to.
 *
 * Encipherment bits are dropped for an EC key: an ECDSA key cannot encipher
 * anything, so `keyEncipherment` on an EC certificate is a claim the key cannot
 * honour. Public CAs issue ECDSA certificates with `digitalSignature` alone for
 * exactly this reason.
 */
export function resolveUsage(purposes: readonly PurposeId[], kind: "rsa" | "ec"): ResolvedUsage {
  const usage = new Set<KeyUsageName>();
  const eku: string[] = [];
  const ekuLabels: string[] = [];
  let dropped = false;

  for (const purpose of PURPOSES) {
    if (!purposes.includes(purpose.id)) continue;
    for (const name of purpose.usage) {
      if (kind === "ec" && (name === "keyEncipherment" || name === "dataEncipherment")) {
        dropped = true;
        continue;
      }
      usage.add(name);
    }
    for (const id of purpose.eku) {
      if (!eku.includes(id)) {
        eku.push(id);
        ekuLabels.push(purpose.ekuLabel);
      }
    }
  }

  return {
    usage: [...usage].sort((a, b) => KEY_USAGE_BITS[a] - KEY_USAGE_BITS[b]),
    eku,
    ekuLabels,
    note: dropped ? "Key Encipherment was left out: an ECDSA key cannot encipher a key." : null,
  };
}

/* ------------------------------------------------------------ extensions */

const EXT = {
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
} as const;

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  // DER omits a field at its default, and criticality defaults to FALSE — so a
  // non-critical extension carries no boolean at all.
  return critical
    ? sequence(oid(id), boolean(true), octetString(value))
    : sequence(oid(id), octetString(value));
}

/**
 * A key identifier: SHA-1 of the public key bits (RFC 5280 §4.2.1.2, method 1).
 *
 * SHA-1 here is not a security claim. The identifier only has to match a
 * certificate to its issuer, every implementation computes it this way, and
 * using anything else would break chain building against real CAs.
 */
export async function keyIdentifier(spki: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-1", publicKeyBits(spki).slice().buffer);
  return new Uint8Array(digest);
}

export interface CertificateSpec {
  readonly subject: Dn;
  readonly sans: readonly San[];
  readonly purposes: readonly PurposeId[];
  readonly isCa: boolean;
  /** Only meaningful when `isCa`; `null` means no limit. */
  readonly pathLength: number | null;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** The issuer side of a signature: who signs, with what, and under what name. */
export interface Issuer {
  /** Issuer DN, as raw DER, so a re-signed certificate matches byte for byte. */
  readonly nameDer: Uint8Array;
  readonly privateKey: CryptoKey;
  readonly algo: KeyAlgo;
  readonly hash: HashName;
  /** Issuer's subject key identifier, if it has one. */
  readonly keyId: Uint8Array | null;
}

/** A serial number: 16 random bytes, positive, as the CA/Browser Forum requires. */
export function randomSerial(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Clearing the top bit keeps the DER INTEGER positive without a leading pad
  // byte, which is what most CAs do and what makes serials 32 hex digits.
  bytes[0]! &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

async function buildExtensions(
  spec: CertificateSpec,
  subjectSpki: Uint8Array,
  issuer: Issuer,
  kind: "rsa" | "ec",
): Promise<Uint8Array[]> {
  const extensions: Uint8Array[] = [];
  const usage = resolveUsage(spec.purposes, kind);

  // Basic constraints first, critical, exactly as RFC 5280 wants for a CA.
  if (spec.isCa) {
    const body = spec.pathLength === null
      ? sequence(boolean(true))
      : sequence(boolean(true), integer(spec.pathLength));
    extensions.push(extension(EXT.basicConstraints, true, body));
  } else {
    extensions.push(extension(EXT.basicConstraints, true, sequence()));
  }

  const bits = spec.isCa
    ? ["digitalSignature", "keyCertSign", "cRLSign"].map((n) => KEY_USAGE_BITS[n as KeyUsageName])
    : usage.usage.map((name) => KEY_USAGE_BITS[name]);
  if (bits.length > 0) extensions.push(extension(EXT.keyUsage, true, namedBits(bits)));

  // A CA gets no EKU: an EKU on a CA constrains every certificate beneath it,
  // which is a decision for someone building a constrained sub-CA, not a
  // default.
  if (!spec.isCa && usage.eku.length > 0) {
    extensions.push(extension(EXT.extKeyUsage, false, sequence(...usage.eku.map(oid))));
  }

  if (spec.sans.length > 0) {
    extensions.push(extension(EXT.subjectAltName, false, encodeSans(spec.sans)));
  }

  extensions.push(
    extension(EXT.subjectKeyIdentifier, false, octetString(await keyIdentifier(subjectSpki))),
  );

  if (issuer.keyId) {
    extensions.push(
      extension(
        EXT.authorityKeyIdentifier,
        false,
        sequence(implicit(0, issuer.keyId)),
      ),
    );
  }
  return extensions;
}

export interface BuiltCertificate {
  readonly der: Uint8Array;
  readonly pem: string;
  readonly serial: Uint8Array;
  readonly subjectKeyId: Uint8Array;
  readonly spki: Uint8Array;
}

/**
 * Builds and signs one certificate.
 *
 * The signature covers the TBSCertificate's own DER, which is why it is encoded
 * once and the same bytes are both signed and embedded — re-encoding could
 * produce a different, equally valid encoding whose signature no longer checks.
 */
export async function buildCertificate(
  spec: CertificateSpec,
  subjectSpki: Uint8Array,
  issuer: Issuer,
  subjectKind: "rsa" | "ec",
): Promise<BuiltCertificate> {
  const serial = randomSerial();
  const algorithmId = signatureAlgorithmId(issuer.algo, issuer.hash);
  const extensions = await buildExtensions(spec, subjectSpki, issuer, subjectKind);

  const tbs = sequence(
    explicit(0, integer(2)), // v3
    integerFromBytes(serial),
    algorithmId,
    issuer.nameDer,
    sequence(time(spec.notBefore), time(spec.notAfter)),
    encodeDn(spec.subject),
    subjectSpki,
    explicit(3, sequence(...extensions)),
  );

  const signature = await signData(issuer.privateKey, issuer.algo, issuer.hash, tbs);
  const der = sequence(tbs, algorithmId, bitString(signature));

  return {
    der,
    pem: encodePem("CERTIFICATE", der),
    serial,
    subjectKeyId: await keyIdentifier(subjectSpki),
    spki: subjectSpki,
  };
}

/* ---------------------------------------------------------------- PKCS#10 */

const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";

export interface BuiltCsr {
  readonly der: Uint8Array;
  readonly pem: string;
}

/**
 * Builds and signs a certification request.
 *
 * A CSR carries the extensions it *wants* inside an extensionRequest attribute.
 * A real CA is free to ignore every one of them, which is why the page says so:
 * the SANs here are a request, not a guarantee.
 */
export async function buildCsr(
  spec: CertificateSpec,
  subjectSpki: Uint8Array,
  privateKey: CryptoKey,
  algo: KeyAlgo,
  hash: HashName,
): Promise<BuiltCsr> {
  const usage = resolveUsage(spec.purposes, algo.kind);
  const requested: Uint8Array[] = [];

  if (spec.sans.length > 0) {
    requested.push(extension(EXT.subjectAltName, false, encodeSans(spec.sans)));
  }
  if (spec.isCa) {
    requested.push(
      extension(
        EXT.basicConstraints,
        true,
        spec.pathLength === null ? sequence(boolean(true)) : sequence(boolean(true), integer(spec.pathLength)),
      ),
    );
  }
  const bits = usage.usage.map((name) => KEY_USAGE_BITS[name]);
  if (bits.length > 0) requested.push(extension(EXT.keyUsage, true, namedBits(bits)));
  if (usage.eku.length > 0) {
    requested.push(extension(EXT.extKeyUsage, false, sequence(...usage.eku.map(oid))));
  }

  const attributes =
    requested.length > 0
      ? [
          sequence(
            oid(OID_EXTENSION_REQUEST),
            set(sequence(...requested)),
          ),
        ]
      : [];

  const info = sequence(
    integer(0), // v1
    encodeDn(spec.subject),
    subjectSpki,
    // The attributes field is [0] IMPLICIT and must be present even when empty.
    implicitSequence(0, ...attributes),
  );

  const algorithmId = signatureAlgorithmId(algo, hash);
  const signature = await signData(privateKey, algo, hash, info);
  const der = sequence(info, algorithmId, bitString(signature));
  return { der, pem: encodePem("CERTIFICATE REQUEST", der) };
}

/* ----------------------------------------------- reading a certificate in */

export interface ParsedCertificate {
  readonly der: Uint8Array;
  /** Subject DN as raw DER — what a certificate signed by this one must copy. */
  readonly subjectDer: Uint8Array;
  readonly subject: string;
  readonly issuer: string;
  readonly serialHex: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly spki: Uint8Array;
  readonly subjectKeyId: Uint8Array | null;
  readonly isCa: boolean;
  /** `null` when the certificate sets no path length limit. */
  readonly pathLength: number | null;
  readonly canSign: boolean;
  readonly selfSigned: boolean;
}

function parseTime(node: DerNode): Date {
  const text = readString(node);
  const long = node.tag === 0x18;
  const year = long ? Number(text.slice(0, 4)) : 1900 + Number(text.slice(0, 2));
  // UTCTime's two-digit year: 50 and above is the twentieth century (RFC 5280).
  const fullYear = long ? year : year < 1950 ? year + 100 : year;
  const at = long ? 4 : 2;
  return new Date(
    Date.UTC(
      fullYear,
      Number(text.slice(at, at + 2)) - 1,
      Number(text.slice(at + 2, at + 4)),
      Number(text.slice(at + 4, at + 6)),
      Number(text.slice(at + 6, at + 8)),
      Number(text.slice(at + 8, at + 10)) || 0,
    ),
  );
}

/**
 * Reads the parts of a certificate needed to sign against it.
 *
 * Not a general parser and not a validator — it does not check the signature,
 * because nothing here trusts the certificate. It only needs the issuer name to
 * copy, the key identifier to reference, and enough of basicConstraints and
 * keyUsage to warn when the file is not a CA at all.
 */
export function parseCertificate(pemText: string): ParsedCertificate {
  const block = findPem(pemText, ["CERTIFICATE", "X509 CERTIFICATE", "TRUSTED CERTIFICATE"]);
  return parseCertificateDer(block.der);
}

export function parseCertificateDer(der: Uint8Array): ParsedCertificate {
  let fields: DerNode[];
  try {
    fields = readChildren(readChildren(readDer(der))[0]!);
  } catch {
    throw new Error("That file is not a certificate — its DER structure does not parse.");
  }

  // The version is an optional [0]; without it the certificate is v1 and the
  // fields that follow shift by one.
  let at = 0;
  if (fields[0]?.context && fields[0].tagNumber === 0) at = 1;

  const serial = fields[at]!;
  const issuerNode = fields[at + 2]!;
  const validity = readChildren(fields[at + 3]!);
  const subjectNode = fields[at + 4]!;
  const spkiNode = fields[at + 5]!;

  let subjectKeyId: Uint8Array | null = null;
  let isCa = false;
  let pathLength: number | null = null;
  let keyUsageBits: Uint8Array | null = null;
  let sawKeyUsage = false;

  const extensionsNode = fields.slice(at + 6).find((f) => f.context && f.tagNumber === 3);
  if (extensionsNode) {
    for (const ext of readChildren(readChildren(extensionsNode)[0]!)) {
      const parts = readChildren(ext);
      const id = readOid(parts[0]!);
      const value = parts[parts.length - 1]!;
      if (id === EXT.subjectKeyIdentifier) {
        subjectKeyId = readDer(value.content).content;
      } else if (id === EXT.basicConstraints) {
        const body = readChildren(readDer(value.content));
        isCa = body[0]?.tag === 0x01 && body[0].content[0] !== 0;
        if (body[1]) pathLength = Number(readInteger(body[1]));
      } else if (id === EXT.keyUsage) {
        sawKeyUsage = true;
        keyUsageBits = readBitString(readDer(value.content));
      }
    }
  }

  // keyCertSign is bit 5: the third-from-top bit of the first byte.
  const canSign = !sawKeyUsage || ((keyUsageBits?.[0] ?? 0) & 0x04) !== 0;
  const issuer = describeDn(issuerNode);
  const subject = describeDn(subjectNode);

  return {
    der,
    subjectDer: subjectNode.raw,
    subject,
    issuer,
    serialHex: toHex(serial.content).replace(/^00/, ""),
    notBefore: parseTime(validity[0]!),
    notAfter: parseTime(validity[1]!),
    spki: spkiNode.raw,
    subjectKeyId,
    isCa,
    pathLength,
    canSign: isCa && canSign,
    selfSigned: issuer === subject,
  };
}

/** SHA-256 fingerprint, colon-separated, as every tool prints it. */
export async function fingerprint(der: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der.slice().buffer));
  return (toHex(digest).match(/../g) ?? []).join(":").toUpperCase();
}
