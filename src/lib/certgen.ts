/**
 * The certificate tool's logic, with no DOM in sight.
 *
 * One entry point, `generate`, turns a filled-in form into everything the page
 * shows and offers for download. The three modes differ only in who signs and
 * what comes out: a root CA signs itself, a leaf is signed by a CA, and a CSR
 * is signed by its own key and asks someone else for a certificate.
 */

import { buildJks, JKS_MIN_PASSWORD } from "./jks";
import {
  generateKeyPair,
  importPrivateKeyPem,
  importSpki,
  keyAlgoById,
  type GeneratedKey,
  type HashName,
  type KeyAlgo,
} from "./keys";
import { decodePem, encodePem } from "./pem";
import { buildPkcs12 } from "./pkcs12";
import {
  buildCertificate,
  buildCsr,
  encodeDn,
  fingerprint,
  keyIdentifier,
  parseCertificate,
  resolveUsage,
  KEY_USAGE_LABELS,
  type CertificateSpec,
  type Dn,
  type Issuer,
  type ParsedCertificate,
  type KeyUsageName,
  type PurposeId,
  type San,
} from "./x509";
import { toHex } from "./hash";

export type Mode = "ca" | "signed" | "csr";

export interface ModeInfo {
  readonly id: Mode;
  readonly label: string;
  readonly blurb: string;
}

export const MODES: readonly ModeInfo[] = [
  {
    id: "ca",
    label: "Root CA",
    blurb:
      "A self-signed certificate authority. Install it once on the machines that need to trust your certificates, then sign as many as you like with it.",
  },
  {
    id: "signed",
    label: "Certificate signed by a CA",
    blurb:
      "A server or client certificate signed by a CA you already have — the one made here a moment ago, or a certificate and key you paste in.",
  },
  {
    id: "csr",
    label: "Certificate request (CSR)",
    blurb:
      "A key and a signed request to send to a real CA. Nothing is issued here; the CA decides what the certificate finally says.",
  },
] as const;

/** Sensible validity per mode, in days. */
export const DEFAULT_DAYS: Record<Mode, number> = { ca: 3650, signed: 825, csr: 825 };

export const VALIDITY_PRESETS = [
  { days: 90, label: "90 days" },
  { days: 398, label: "398 days" },
  { days: 825, label: "825 days" },
  { days: 3650, label: "10 years" },
] as const;

/** Where the issuing key comes from in `signed` mode. */
export type IssuerSource =
  | { readonly kind: "session" }
  | { readonly kind: "upload"; readonly certPem: string; readonly keyPem: string };

export interface GenerateInput {
  readonly mode: Mode;
  readonly subject: Dn;
  readonly sans: readonly San[];
  readonly purposes: readonly PurposeId[];
  readonly keyAlgoId: string;
  readonly hash: HashName;
  readonly days: number;
  /** `null` for no limit; ignored outside CA mode. */
  readonly pathLength: number | null;
  readonly issuer?: IssuerSource;
  /** The CA made earlier in this session, when `issuer` is `session`. */
  readonly sessionCa?: SessionCa | null;
}

/**
 * A CA held for the length of a visit, so the certificate made right after it
 * can be signed without a round trip through the clipboard. It is a plain
 * object in a module variable on the page: nothing writes it to storage, and
 * closing the tab is the end of it.
 */
export interface SessionCa {
  readonly name: string;
  readonly der: Uint8Array;
  readonly pem: string;
  readonly key: GeneratedKey;
  readonly hash: HashName;
  readonly subjectDer: Uint8Array;
  readonly keyId: Uint8Array;
  readonly notAfter: Date;
}

export interface Summary {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  /** Spans the grid: a DN, a SAN list, a fingerprint — anything long. */
  readonly wide?: boolean;
}

export interface Bundle {
  readonly mode: Mode;
  readonly algo: KeyAlgo;
  /** The pair this bundle was built around, so a CA can go on to sign. */
  readonly key: GeneratedKey;
  /** PKCS#8, unencrypted. The file the user must keep. */
  readonly privateKeyPem: string;
  readonly certificatePem: string | null;
  readonly csrPem: string | null;
  /** Leaf first, then each issuer — the order every server wants. */
  readonly chainPem: string | null;
  readonly summary: readonly Summary[];
  /** Warnings that are worth saying but do not stop generation. */
  readonly notes: readonly string[];
  /** Everything a keystore needs; `null` for a CSR, which has no certificate. */
  readonly keystore: KeystoreMaterial | null;
  /** Base name for the downloaded files, from the common name. */
  readonly fileBase: string;
}

export interface KeystoreMaterial {
  readonly pkcs8: Uint8Array;
  readonly chain: readonly Uint8Array[];
  readonly localKeyId: Uint8Array;
}

const DAY_MS = 86_400_000;

/**
 * Backdated by an hour. Clocks disagree, and a certificate that is not yet
 * valid for the next few minutes is a genuinely confusing failure.
 */
function validityWindow(days: number): { notBefore: Date; notAfter: Date } {
  const now = Date.now();
  const notBefore = new Date(Math.floor((now - 3_600_000) / 1000) * 1000);
  return { notBefore, notAfter: new Date(notBefore.getTime() + days * DAY_MS) };
}

function commonName(subject: Dn): string {
  return subject.CN?.trim() ?? "";
}

/** A file name from the common name: lower case, no separators, never empty. */
export function fileBaseFor(subject: Dn, mode: Mode): string {
  const cn = commonName(subject)
    .toLowerCase()
    .replace(/^\*\./, "wildcard.")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cn || (mode === "ca" ? "ca" : "certificate");
}

/**
 * Checks the form before any key is generated.
 *
 * Generating an RSA 4096 key takes seconds, so refusing a missing common name
 * afterwards would waste the wait. Everything cheap is checked here.
 */
export function validate(input: GenerateInput): string | null {
  if (commonName(input.subject).length === 0) return "A common name is required.";
  if (commonName(input.subject).length > 64) return "A common name is limited to 64 characters.";

  const country = input.subject.C?.trim();
  if (country && country.length !== 2) {
    return "The country must be a two-letter ISO code, such as VN, US or DE.";
  }
  if (!Number.isInteger(input.days) || input.days < 1) return "Validity must be at least one day.";
  if (input.days > 36_500) return "Validity is capped at 100 years.";

  if (input.mode === "signed") {
    if (input.issuer?.kind === "session" && !input.sessionCa) {
      return "No CA has been made in this tab yet. Switch to Root CA and make one, or paste a CA below.";
    }
    if (input.issuer?.kind === "upload") {
      if (input.issuer.certPem.trim().length === 0) return "Paste the CA certificate.";
      if (input.issuer.keyPem.trim().length === 0) return "Paste the CA private key.";
    }
  }
  return null;
}

/**
 * Proves an uploaded certificate and key belong together, by signing with the
 * key and verifying with the certificate's public key.
 *
 * Worth the round trip: pasting last year's key next to this year's certificate
 * is the most common mistake here, and without this check it produces a
 * certificate that verifies against nothing and fails only in production.
 */
async function assertKeyMatchesCertificate(
  cert: ParsedCertificate,
  privateKey: CryptoKey,
  algo: KeyAlgo,
  hash: HashName,
): Promise<void> {
  let publicKey: CryptoKey;
  try {
    publicKey = (await importSpki(cert.spki, hash)).key;
  } catch {
    throw new Error("The CA certificate's public key could not be read.");
  }

  const probe = crypto.getRandomValues(new Uint8Array(32));
  const params: AlgorithmIdentifier | EcdsaParams =
    algo.kind === "rsa" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash };

  let matches = false;
  try {
    const signature = await crypto.subtle.sign(params, privateKey, probe.slice().buffer);
    matches = await crypto.subtle.verify(params, publicKey, signature, probe.slice().buffer);
  } catch {
    matches = false;
  }
  if (!matches) {
    throw new Error("That private key does not belong to that CA certificate.");
  }
}

/** Resolves `signed` mode's issuer into something that can sign, plus its chain. */
async function resolveIssuer(
  input: GenerateInput,
  hash: HashName,
): Promise<{ issuer: Issuer; chain: Uint8Array[]; description: string; notAfter: Date; notes: string[] }> {
  const source = input.issuer ?? { kind: "session" as const };
  const notes: string[] = [];

  if (source.kind === "session") {
    const ca = input.sessionCa!;
    return {
      issuer: {
        nameDer: ca.subjectDer,
        privateKey: ca.key.privateKey,
        algo: ca.key.algo,
        hash: ca.hash,
        keyId: ca.keyId,
      },
      chain: [ca.der],
      description: ca.name,
      notAfter: ca.notAfter,
      notes,
    };
  }

  const cert = parseCertificate(source.certPem);
  if (!cert.isCa) {
    notes.push(
      "The uploaded certificate is not marked as a CA (basicConstraints CA:FALSE). Anything it signs will be rejected by a client that checks, which is all of them.",
    );
  } else if (!cert.canSign) {
    notes.push(
      "The uploaded CA's key usage does not include Certificate Sign. Some verifiers will refuse the chain.",
    );
  }
  if (cert.pathLength === 0 && input.pathLength !== null) {
    notes.push("That CA has pathLenConstraint 0, so it may not issue a certificate that is itself a CA.");
  }

  const key = await importPrivateKeyPem(source.keyPem, hash);
  await assertKeyMatchesCertificate(cert, key.privateKey, key.algo, hash);

  // A pasted fullchain is welcome: the first block issues, the rest ride along.
  const extra = decodePem(source.certPem)
    .filter((block) => block.label.endsWith("CERTIFICATE"))
    .slice(1)
    .map((block) => block.der);

  if (cert.notAfter.getTime() < Date.now()) {
    notes.push(`That CA expired on ${cert.notAfter.toISOString().slice(0, 10)}.`);
  }

  return {
    issuer: {
      nameDer: cert.subjectDer,
      privateKey: key.privateKey,
      algo: key.algo,
      hash,
      keyId: cert.subjectKeyId ?? (await keyIdentifier(cert.spki)),
    },
    chain: [cert.der, ...extra],
    description: cert.subject,
    notAfter: cert.notAfter,
    notes,
  };
}

function describeSubject(subject: Dn): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(subject)) {
    if (value?.trim()) parts.push(`${key}=${value.trim()}`);
  }
  return parts.join(", ");
}

/**
 * Generates everything for one press of the button.
 *
 * Deliberately one call: the key, the certificate and the summary are a single
 * unit, and a half-finished bundle — a key with no certificate, a certificate
 * whose key was regenerated — is worse than no bundle at all.
 */
export async function generate(input: GenerateInput): Promise<Bundle> {
  const problem = validate(input);
  if (problem) throw new Error(problem);

  const algo = keyAlgoById(input.keyAlgoId);
  const key = await generateKeyPair(algo, input.hash);
  const { notBefore, notAfter } = validityWindow(input.days);
  const notes: string[] = [];

  const isCa = input.mode === "ca";
  const spec: CertificateSpec = {
    subject: input.subject,
    sans: input.sans,
    purposes: input.purposes,
    isCa,
    pathLength: isCa ? input.pathLength : null,
    notBefore,
    notAfter,
  };

  const usage = resolveUsage(input.purposes, algo.kind);
  if (usage.note) notes.push(usage.note);
  if (!isCa && input.purposes.length === 0) {
    notes.push(
      "No purpose is ticked, so the certificate carries no extended key usage. Most software reads that as “valid for anything”, but some refuses it outright.",
    );
  }
  if (!isCa && input.purposes.includes("tls-server") && input.sans.length === 0) {
    notes.push(
      "No subject alternative names. Every current browser ignores the common name and will reject this for HTTPS.",
    );
  }

  const privateKeyPem = encodePem("PRIVATE KEY", key.pkcs8);
  const summary: Summary[] = [];

  if (input.mode === "csr") {
    const csr = await buildCsr(spec, key.spki, key.privateKey, algo, input.hash);
    summary.push(
      { label: "Subject", value: describeSubject(input.subject), wide: true },
      { label: "Key", value: algo.label, note: `signed with ${input.hash}` },
      {
        label: "Requested names",
        value: input.sans.length > 0 ? input.sans.map(describeSan).join(", ") : "—",
        wide: true,
      },
      {
        label: "Requested usage",
        value: usage.ekuLabels.length > 0 ? usage.ekuLabels.join(", ") : "none",
        note: "a CA may ignore every requested extension",
        wide: true,
      },
    );
    return {
      mode: input.mode,
      algo,
      key,
      privateKeyPem,
      certificatePem: null,
      csrPem: csr.pem,
      chainPem: null,
      summary,
      notes,
      keystore: null,
      fileBase: fileBaseFor(input.subject, input.mode),
    };
  }

  let issuer: Issuer;
  let chain: Uint8Array[];
  let issuerName: string;

  if (isCa) {
    // A root signs itself, so the issuer is the subject and the key is its own.
    issuer = {
      nameDer: encodeDn(input.subject),
      privateKey: key.privateKey,
      algo,
      hash: input.hash,
      keyId: await keyIdentifier(key.spki),
    };
    chain = [];
    issuerName = "itself (self-signed)";
  } else {
    const resolved = await resolveIssuer(input, input.hash);
    issuer = resolved.issuer;
    chain = resolved.chain;
    issuerName = resolved.description;
    notes.push(...resolved.notes);
    if (notAfter.getTime() > resolved.notAfter.getTime()) {
      notes.push(
        `This certificate outlives its CA, which expires on ${resolved.notAfter.toISOString().slice(0, 10)}. Clients will stop trusting it then, whatever its own expiry says.`,
      );
    }
  }

  const certificate = await buildCertificate(spec, key.spki, issuer, algo.kind);
  const fullChain = [certificate.der, ...chain];

  summary.push(
    { label: "Subject", value: describeSubject(input.subject), wide: true },
    { label: "Issuer", value: issuerName, wide: true },
    {
      label: "Serial",
      value: toHex(certificate.serial).toUpperCase().replace(/(..)(?=.)/g, "$1:"),
      wide: true,
    },
    {
      label: "Valid",
      value: `${notBefore.toISOString().slice(0, 10)} → ${notAfter.toISOString().slice(0, 10)}`,
      note: `${input.days} days`,
    },
    { label: "Key", value: algo.label, note: `signed with ${input.hash}` },
    {
      label: "Basic constraints",
      value: isCa
        ? `CA:TRUE${input.pathLength === null ? "" : `, pathlen:${input.pathLength}`}`
        : "CA:FALSE",
    },
    {
      label: "Key usage",
      value: isCa
        ? "Digital Signature, Certificate Sign, CRL Sign"
        : usage.usage.length > 0
          ? usage.usage.map(usageLabel).join(", ")
          : "—",
      wide: true,
    },
    {
      label: "Extended key usage",
      value: isCa ? "none — a root CA is not restricted" : usage.ekuLabels.join(", ") || "—",
      wide: true,
    },
    {
      label: "Subject alt names",
      value: input.sans.length > 0 ? input.sans.map(describeSan).join(", ") : "—",
      wide: true,
    },
    { label: "SHA-256 fingerprint", value: await fingerprint(certificate.der), wide: true },
  );

  return {
    mode: input.mode,
    algo,
    key,
    privateKeyPem,
    certificatePem: certificate.pem,
    csrPem: null,
    chainPem: fullChain.length > 1 ? fullChain.map((der) => encodePem("CERTIFICATE", der)).join("") : null,
    summary,
    notes,
    keystore: {
      pkcs8: key.pkcs8,
      chain: fullChain,
      localKeyId: certificate.subjectKeyId,
    },
    fileBase: fileBaseFor(input.subject, input.mode),
  };
}

function usageLabel(name: KeyUsageName): string {
  return KEY_USAGE_LABELS[name];
}

function describeSan(san: San): string {
  const prefix = { dns: "DNS", ip: "IP", email: "email", uri: "URI" }[san.kind];
  return `${prefix}:${san.value}`;
}

/** Turns a finished bundle into a CA the next certificate can be signed by. */
export async function toSessionCa(input: GenerateInput, bundle: Bundle): Promise<SessionCa> {
  const der = bundle.keystore!.chain[0]!;
  const parsed = parseCertificate(bundle.certificatePem!);
  return {
    name: parsed.subject,
    der,
    pem: bundle.certificatePem!,
    key: bundle.key,
    hash: input.hash,
    subjectDer: parsed.subjectDer,
    keyId: parsed.subjectKeyId ?? (await keyIdentifier(parsed.spki)),
    notAfter: parsed.notAfter,
  };
}

export interface KeystoreOptions {
  readonly password: string;
  readonly alias: string;
}

export async function buildP12(material: KeystoreMaterial, options: KeystoreOptions): Promise<Uint8Array> {
  return buildPkcs12({
    password: options.password,
    alias: options.alias,
    pkcs8: material.pkcs8,
    chain: material.chain,
    localKeyId: material.localKeyId,
  });
}

export async function buildJavaKeystore(
  material: KeystoreMaterial,
  options: KeystoreOptions,
): Promise<Uint8Array> {
  return buildJks({
    password: options.password,
    alias: options.alias,
    pkcs8: material.pkcs8,
    chain: material.chain,
  });
}

export { JKS_MIN_PASSWORD };
