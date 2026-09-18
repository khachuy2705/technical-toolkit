/**
 * The same certificate, as OpenSSL commands.
 *
 * The page builds certificates itself; this module says what you would have
 * typed instead. It exists for three reasons, in order of how much they matter:
 *
 *   1. **A CA key that matters should not be pasted into a web page.** The
 *      honest advice is to run the commands on a machine you control, and the
 *      tool should hand them over rather than pretend otherwise.
 *   2. **It shows its working.** Every extension the form produces appears in
 *      the script, so what the page is doing is legible rather than asserted.
 *   3. **It is the part people actually want to keep** — pasted into a runbook,
 *      a Makefile or a ticket.
 *
 * The commands are checked by running them: `npm run verify` executes the
 * script against a real OpenSSL and compares the certificate that comes out
 * with the one the page builds from the same form. A command that does not run
 * is worse than no command at all.
 *
 * POSIX shell only. The extensions have to reach `openssl x509` through a file,
 * a heredoc is the readable way to write one, and PowerShell has no heredoc.
 */

import { fileBaseFor, type GenerateInput } from "./certgen";
import { keyAlgoById } from "./keys";
import {
  DN_FIELDS,
  resolveUsage,
  type Dn,
  type KeyUsageName,
  type San,
} from "./x509";

export interface CommandStep {
  readonly title: string;
  /** Why this step exists, when that is not obvious from the command. */
  readonly note?: string;
  readonly command: string;
}

/** OpenSSL's own spelling of each key usage, for an `extendedKeyUsage` line. */
const USAGE_NAMES: Record<KeyUsageName, string> = {
  digitalSignature: "digitalSignature",
  nonRepudiation: "nonRepudiation",
  keyEncipherment: "keyEncipherment",
  dataEncipherment: "dataEncipherment",
  keyAgreement: "keyAgreement",
  keyCertSign: "keyCertSign",
  cRLSign: "cRLSign",
};

/**
 * Short names OpenSSL knows for the extended key usages this tool offers. An
 * OID with no short name is emitted as the OID, which OpenSSL accepts.
 */
const EKU_NAMES: Record<string, string> = {
  "1.3.6.1.5.5.7.3.1": "serverAuth",
  "1.3.6.1.5.5.7.3.2": "clientAuth",
  "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection",
  "1.3.6.1.5.5.7.3.8": "timeStamping",
};

const SAN_PREFIX = { dns: "DNS", ip: "IP", email: "email", uri: "URI" } as const;

/** Curve names `genpkey` takes. The `P-256` aliases are newer and less portable. */
const CURVE_NAMES: Record<string, string> = {
  "ec-p256": "prime256v1",
  "ec-p384": "secp384r1",
  "ec-p521": "secp521r1",
};

/** Wraps a value for `sh`, which single quotes do completely except for `'`. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Git Bash rewrites any argument beginning with `/` into a Windows path, so
 * `-subj '/CN=example.com'` arrives at OpenSSL as `C:/Program Files/Git/CN=...`
 * and the command fails with a message that does not mention the shell at all.
 *
 * The script stays correct POSIX rather than being contorted for one shell;
 * this is the line that tells a Windows user what to do about it. It is stated
 * here because the failure is otherwise impossible to attribute.
 */
export const GIT_BASH_NOTE =
  "On Git Bash for Windows, prefix the commands with `MSYS_NO_PATHCONV=1` — it rewrites `-subj '/CN=…'` into a file path otherwise. Linux, macOS and WSL need nothing.";

/**
 * `-subj` is read as Latin-1 unless `-utf8` says otherwise, so a subject holding
 * anything outside ASCII — which for this tool's audience is most of them —
 * lands in the certificate as mojibake. Easy to miss, because the command
 * succeeds and the certificate is valid; it just has the wrong name in it.
 */
const UTF8_NOTE =
  "`-utf8` is not optional: without it OpenSSL reads the subject as Latin-1, and `Công ty` becomes `CÃ´ng ty` in the certificate.";

/**
 * A DN as `-subj` wants it. OpenSSL splits on `/` and `=`, so a value holding
 * either has to escape it — a common name like `O=A/B Ltd` otherwise silently
 * becomes two attributes.
 */
function subjectArgument(dn: Dn): string {
  const parts: string[] = [];
  for (const field of DN_FIELDS) {
    const raw = dn[field.id]?.trim();
    if (!raw) continue;
    const value = (field.id === "C" ? raw.toUpperCase() : raw).replace(/([\\/+=])/g, "\\$1");
    parts.push(`/${field.id}=${value}`);
  }
  return quote(parts.join("") || "/");
}

/** Joins arguments onto continued lines, so a long command stays readable. */
function multiline(head: string, args: readonly string[]): string {
  if (args.length === 0) return head;
  return [head, ...args].join(" \\\n  ");
}

function sanValue(sans: readonly San[]): string {
  return sans.map((san) => `${SAN_PREFIX[san.kind]}:${san.value}`).join(", ");
}

/** The extension lines both the `-addext` flags and the ext file are built from. */
function extensionLines(input: GenerateInput, isCa: boolean): string[] {
  const algo = keyAlgoById(input.keyAlgoId);
  const usage = resolveUsage(input.purposes, algo.kind);
  const lines: string[] = [];

  if (isCa) {
    const pathlen = input.pathLength === null ? "" : `, pathlen:${input.pathLength}`;
    lines.push(`basicConstraints = critical, CA:TRUE${pathlen}`);
    lines.push("keyUsage = critical, digitalSignature, keyCertSign, cRLSign");
  } else {
    lines.push("basicConstraints = critical, CA:FALSE");
    if (usage.usage.length > 0) {
      lines.push(`keyUsage = critical, ${usage.usage.map((name) => USAGE_NAMES[name]).join(", ")}`);
    }
    if (usage.eku.length > 0) {
      lines.push(
        `extendedKeyUsage = ${usage.eku.map((id) => EKU_NAMES[id] ?? id).join(", ")}`,
      );
    }
  }

  if (input.sans.length > 0) lines.push(`subjectAltName = ${sanValue(input.sans)}`);
  lines.push("subjectKeyIdentifier = hash");
  return lines;
}

function keyCommand(input: GenerateInput, base: string): string {
  const algo = keyAlgoById(input.keyAlgoId);
  return algo.kind === "rsa"
    ? multiline("openssl genpkey -algorithm RSA", [
        `-pkeyopt rsa_keygen_bits:${algo.bits}`,
        `-out ${base}.key`,
      ])
    : multiline("openssl genpkey -algorithm EC", [
        `-pkeyopt ec_paramgen_curve:${CURVE_NAMES[algo.id]}`,
        `-out ${base}.key`,
      ]);
}

const HASH_FLAG: Record<string, string> = {
  "SHA-256": "-sha256",
  "SHA-384": "-sha384",
  "SHA-512": "-sha512",
};

export interface ScriptOptions {
  /** Alias for the keystore steps; omitted when there is no keystore. */
  readonly alias?: string;
  /** True when the issuing CA is the one held in the tab, not a file on disk. */
  readonly caFromSession?: boolean;
}

/**
 * The whole script for one filled-in form, as steps.
 *
 * Deliberately not a single blob: each step is a thing you might run on its own,
 * and the notes are where the reasons live that a bare command cannot carry.
 */
export function opensslSteps(input: GenerateInput, options: ScriptOptions = {}): CommandStep[] {
  const base = fileBaseFor(input.subject, input.mode);
  const isCa = input.mode === "ca" || input.isCa === true;
  const hash = HASH_FLAG[input.hash] ?? "-sha256";
  const algo = keyAlgoById(input.keyAlgoId);
  const steps: CommandStep[] = [];

  steps.push({
    title: "1. Private key",
    note:
      algo.kind === "rsa"
        ? `RSA ${algo.bits}. Add \`-aes256\` to encrypt it with a passphrase.`
        : `${algo.label}. Add \`-aes256\` to encrypt it with a passphrase.`,
    command: keyCommand(input, base),
  });

  /* ------------------------------------------------------------ a root CA */

  if (input.mode === "ca") {
    steps.push({
      title: "2. Self-signed CA certificate",
      note: `${UTF8_NOTE} \`-addext\` needs OpenSSL 1.1.1 or later.`,
      command: multiline("openssl req -x509 -new -utf8", [
        `-key ${base}.key`,
        hash,
        `-days ${input.days}`,
        `-subj ${subjectArgument(input.subject)}`,
        ...extensionLines(input, true).map((line) => `-addext ${quote(line.replace(/ = /, "="))}`),
        `-out ${base}.crt`,
      ]),
    });
    steps.push({
      title: "3. Check it",
      command: `openssl x509 -in ${base}.crt -noout -text`,
    });
    return steps;
  }

  /* -------------------------------------------------------------- a CSR */

  // A request going to someone else's CA states what it wants. A request about
  // to be signed here does not: `openssl x509 -req` takes its extensions from
  // `-extfile` and ignores whatever the CSR asked for, so repeating them would
  // only raise the question of which copy wins. The subject key identifier is
  // left out either way — a request has no issuer to be identified against yet.
  const csrExtensions =
    input.mode === "csr"
      ? extensionLines(input, isCa).filter((line) => !line.startsWith("subjectKeyIdentifier"))
      : [];

  steps.push({
    title: "2. Certificate request",
    note:
      input.mode === "csr"
        ? `${UTF8_NOTE} The extensions here are a request — a public CA will ignore most of them.`
        : UTF8_NOTE,
    command: multiline("openssl req -new -utf8", [
      `-key ${base}.key`,
      hash,
      `-subj ${subjectArgument(input.subject)}`,
      ...csrExtensions.map((line) => `-addext ${quote(line.replace(/ = /, "="))}`),
      `-out ${base}.csr`,
    ]),
  });

  if (input.mode === "csr") {
    steps.push({
      title: "3. Check it before sending",
      note: "`-verify` checks the request's own signature, which is the only thing it asserts.",
      command: `openssl req -in ${base}.csr -noout -text -verify`,
    });
    return steps;
  }

  /* ---------------------------------------------- signing with an existing CA */

  steps.push({
    title: "3. Extensions to put in the certificate",
    note: "`openssl x509` takes extensions from a file — it has no `-addext` of its own.",
    command: [
      `cat > ${base}.ext <<'EOF'`,
      ...extensionLines(input, isCa),
      "authorityKeyIdentifier = keyid",
      "EOF",
    ].join("\n"),
  });

  steps.push({
    title: "4. Sign it with the CA",
    note: options.caFromSession
      ? "`ca.crt` and `ca.key` are the CA made in this tab — download both first, since the page keeps neither."
      : "OpenSSL will prompt for the CA key's passphrase if it has one. Do not put it on the command line.",
    command: multiline("openssl x509 -req", [
      `-in ${base}.csr`,
      "-CA ca.crt",
      "-CAkey ca.key",
      "-CAcreateserial",
      `-days ${input.days}`,
      hash,
      `-extfile ${base}.ext`,
      `-out ${base}.crt`,
    ]),
  });

  steps.push({
    title: "5. Chain, and check it",
    note: "`verify` builds the path the way a client will.",
    command: [
      `cat ${base}.crt ca.crt > ${base}.fullchain.pem`,
      `openssl verify -CAfile ca.crt ${base}.crt`,
    ].join("\n"),
  });

  if (options.alias) {
    steps.push({
      title: "6. Keystores",
      note: "PKCS#12 first; `keytool` converts that to a JKS for a stack that insists on one.",
      command: [
        multiline("openssl pkcs12 -export", [
          `-inkey ${base}.key`,
          `-in ${base}.crt`,
          "-certfile ca.crt",
          `-name ${quote(options.alias)}`,
          `-out ${base}.p12`,
        ]),
        "",
        multiline("keytool -importkeystore", [
          `-srckeystore ${base}.p12`,
          "-srcstoretype PKCS12",
          `-destkeystore ${base}.jks`,
          "-deststoretype JKS",
        ]),
      ].join("\n"),
    });
  }

  return steps;
}

/** The steps as one script, with each title as a comment. Used by Copy. */
export function stepsToScript(steps: readonly CommandStep[]): string {
  return steps.map((step) => `# ${step.title}\n${step.command}`).join("\n\n") + "\n";
}
