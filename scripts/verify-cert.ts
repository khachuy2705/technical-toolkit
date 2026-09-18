/**
 * Checks for the certificate tools. Driven by scripts/verify.ts, which owns the
 * harness and the exit code.
 *
 * This file is written differently from the rest of the verification, and on
 * purpose. Everywhere else the tool is its own oracle — there is no second
 * implementation of a subnet mask to disagree with. Here there are dozens, they
 * are the entire point, and a certificate that only this code can read is
 * worthless. So the assertions lean on outside readers wherever one exists:
 *
 *   - **Node's `X509Certificate`** parses every certificate and reports its
 *     subject, SANs, validity and key usage. It also verifies signatures, so a
 *     chain built here is checked by something that did not build it.
 *   - **OpenSSL**, when it is on PATH, parses the certificate, the CSR and the
 *     PKCS#12 and is asked to decrypt the keystore with its own PBES2 code.
 *   - The **JKS** has no second reader that can be depended on here: no keytool,
 *     no Java, and pyjks needs a C compiler to install. The checks below undo
 *     the format with the same understanding that wrote it, so they catch a
 *     regression but would not catch a misreading of Sun's source. The files
 *     were read by pyjks during development, which is what caught the missing
 *     NULL parameters pinned below; that gap is recorded in design.md.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPublicKey, createPrivateKey, createHash } from "node:crypto";

import {
  integer,
  integerFromBytes,
  namedBits,
  nullValue,
  octetString,
  oid,
  readChildren,
  readDer,
  readOid,
  sequence,
  time,
  utf16be,
} from "../src/lib/asn1";
import { bytesToPemText, decodePem, encodePem, findPem } from "../src/lib/pem";
import { importPrivateKeyPem, isEncryptedKeyPem, type HashName } from "../src/lib/keys";
import {
  parseCertificate,
  parseSan,
  parseSans,
  resolveUsage,
  type Dn,
} from "../src/lib/x509";
import {
  buildJavaKeystore,
  buildP12,
  bundleIsCa,
  fileBaseFor,
  generate,
  toSessionCa,
  type GenerateInput,
} from "../src/lib/certgen";
import { opensslSteps, stepsToScript } from "../src/lib/openssl";
import { buildJks } from "../src/lib/jks";

type Check = (name: string, condition: boolean, detail?: string) => void;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Runs OpenSSL, or returns null when it is absent or rejects the input.
 *
 * Both streams come back joined: OpenSSL reports a keystore's encryption
 * parameters, and `req -verify`'s verdict, on stderr rather than stdout.
 */
function openssl(args: string[], input?: Buffer): string | null {
  const run = spawnSync("openssl", args, { input, encoding: "utf8" });
  if (run.error || run.status !== 0) return null;
  return `${run.stdout}${run.stderr}`;
}

const OPENSSL_AVAILABLE = openssl(["version"]) !== null;

/** A POSIX shell to run the generated script with. Absent on a bare Windows box. */
function shellAvailable(): boolean {
  const run = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
  return !run.error && run.status === 0;
}

const BASE_INPUT: GenerateInput = {
  mode: "signed",
  subject: { CN: "example.com", O: "Example Ltd", C: "VN" },
  sans: parseSans("example.com, www.example.com, 10.0.0.1, 2001:db8::1"),
  purposes: ["tls-server"],
  keyAlgoId: "ec-p256",
  hash: "SHA-256",
  days: 90,
  pathLength: null,
};

export async function runCertificateChecks(check: Check): Promise<void> {
  console.log("\n-- DER encoding --");
  {
    // Length forms. The boundaries at 127/128 and 255/256 are where a hand-
    // written encoder goes wrong, and a wrong length is a file nothing reads.
    const lengths = [0, 1, 127, 128, 255, 256, 65535, 65536];
    const encoded = lengths.map((n) => readDer(sequence(new Uint8Array(n))).content.length);
    check("sequence lengths round-trip", encoded.join(",") === lengths.join(","), encoded.join(","));

    // INTEGER is signed: a leading byte over 0x7f needs a zero pad, and leading
    // zeros are stripped. Both rules are visible in every certificate serial.
    check("integer pads a high bit", hex(integerFromBytes(Uint8Array.of(0x80))) === "020200 80".replace(" ", ""));
    check("integer strips leading zeros", hex(integerFromBytes(Uint8Array.of(0, 0, 1))) === "020101");
    check("integer 0 is one byte", hex(integer(0)) === "020100");
    check("integer 127/128 boundary", hex(integer(128)) === "02020080", hex(integer(128)));

    // OID: first two arcs share a byte, the rest are base-128.
    check("oid rsaEncryption", hex(oid("1.2.840.113549.1.1.1")) === "06092a864886f70d010101", hex(oid("1.2.840.113549.1.1.1")));
    check("oid secp384r1", hex(oid("1.3.132.0.34")) === "06052b81040022", hex(oid("1.3.132.0.34")));
    check("oid round-trips", readOid(readDer(oid("2.5.29.17"))) === "2.5.29.17");

    // KeyUsage with digitalSignature alone is 0x80 with seven unused bits; with
    // keyCertSign and cRLSign it is 0x06 with one. Getting the unused count
    // wrong shifts every bit and silently changes what the certificate permits.
    check("named bits: digitalSignature", hex(namedBits([0])) === "03020780", hex(namedBits([0])));
    check("named bits: keyCertSign + cRLSign", hex(namedBits([5, 6])) === "03020106", hex(namedBits([5, 6])));
    check("named bits: empty", hex(namedBits([])) === "030100", hex(namedBits([])));

    // UTCTime until 2049, GeneralizedTime from 2050 — RFC 5280's rule, and the
    // difference between a 2050 certificate and a 1950 one.
    check("2026 is UTCTime", readDer(time(new Date("2026-09-18T12:00:00Z"))).tag === 0x17);
    check("2050 is GeneralizedTime", readDer(time(new Date("2050-01-01T00:00:00Z"))).tag === 0x18);
    check(
      "UTCTime body",
      Buffer.from(readDer(time(new Date("2026-09-18T12:34:56Z"))).content).toString() === "260918123456Z",
    );

    // UTF-16BE, which both keystore formats depend on for the password.
    check("utf16be", hex(utf16be("ab")) === "00610062", hex(utf16be("ab")));
  }

  console.log("\n-- PEM --");
  {
    const der = crypto.getRandomValues(new Uint8Array(200));
    const pem = encodePem("CERTIFICATE", der);
    // Every body line but the last is exactly 64 characters; the last holds the
    // remainder. The slice drops the BEGIN line, the END line and the trailing
    // empty string that the final newline leaves behind.
    const body = pem.split("\n").slice(1, -2);
    check(
      "wraps at 64 columns",
      body.slice(0, -1).every((line) => line.length === 64) && body.at(-1)!.length <= 64,
      body.map((line) => line.length).join(","),
    );
    check("round-trips", hex(findPem(pem, ["CERTIFICATE"]).der) === hex(der));

    // What a real paste looks like: CRLF, indentation, and a preamble.
    const messy = "Bag Attributes\r\n    friendlyName: x\r\n" + pem.replace(/\n/g, "\r\n  ");
    check("survives CRLF and indentation", hex(findPem(messy, ["CERTIFICATE"]).der) === hex(der));

    const two = encodePem("CERTIFICATE", der) + encodePem("CERTIFICATE", der);
    check("reads a chain of blocks", decodePem(two).length === 2);

    let refused = false;
    try {
      findPem(encodePem("PRIVATE KEY", der), ["CERTIFICATE"]);
    } catch {
      refused = true;
    }
    check("names the wrong block type", refused);
  }

  console.log("\n-- subject alternative names --");
  {
    check("host name", parseSan("example.com").kind === "dns");
    check("wildcard", parseSan("*.example.com").kind === "dns");
    check("IPv4 becomes 4 bytes", hex(parseSan("10.0.0.1").bytes!) === "0a000001");
    check(
      "IPv6 becomes 16 bytes",
      hex(parseSan("2001:db8::1").bytes!) === "20010db8000000000000000000000001",
      hex(parseSan("2001:db8::1").bytes!),
    );
    check("email", parseSan("admin@example.com").kind === "email");
    check("URI", parseSan("https://example.com/x").kind === "uri");
    check("duplicates are dropped", parseSans("a.com, a.com, b.com").length === 2);

    for (const bad of ["ex*ample.com", "not a host", "10.0.0.999"]) {
      let threw = false;
      try {
        parseSan(bad);
      } catch {
        threw = true;
      }
      check(`refuses "${bad}"`, threw);
    }
  }

  console.log("\n-- key usage from purposes --");
  {
    const rsa = resolveUsage(["tls-server"], "rsa");
    check("RSA TLS server keeps keyEncipherment", rsa.usage.includes("keyEncipherment"));

    // An ECDSA key cannot encipher, so the bit must not be asserted.
    const ec = resolveUsage(["tls-server"], "ec");
    check("EC TLS server drops keyEncipherment", !ec.usage.includes("keyEncipherment"));
    check("and says why", ec.note !== null);

    const signing = resolveUsage(["document-signing"], "rsa");
    check("document signing adds nonRepudiation", signing.usage.includes("nonRepudiation"));

    const both = resolveUsage(["tls-server", "tls-client"], "rsa");
    check("two purposes merge into two EKUs", both.eku.length === 2, both.eku.join(","));
    check("no purposes means no EKU", resolveUsage([], "rsa").eku.length === 0);
  }

  console.log("\n-- self-signed root CA --");
  let caPem = "";
  let caKeyPem = "";
  {
    const input: GenerateInput = {
      ...BASE_INPUT,
      mode: "ca",
      subject: { CN: "Toolkit Test Root", O: "Toolkit", C: "VN" },
      sans: [],
      purposes: [],
      keyAlgoId: "rsa-2048",
      hash: "SHA-256",
      days: 3650,
      pathLength: 1,
    };
    const bundle = await generate(input);
    caPem = bundle.certificatePem!;
    caKeyPem = bundle.privateKeyPem;

    // Node parses it, which is the first real proof the bytes are a certificate.
    const cert = new X509Certificate(caPem);
    check("Node parses it", cert.subject.includes("Toolkit Test Root"), cert.subject);
    check("issuer equals subject", cert.issuer === cert.subject);
    check("is a CA", cert.ca);
    check("basicConstraints pathlen:1", caPem.length > 0 && bundle.summary.some((s) => s.value.includes("pathlen:1")));

    // The signature check is the one that matters: it proves the TBS bytes that
    // were signed are byte-for-byte the ones embedded.
    check("verifies against its own key", cert.verify(createPublicKey(caPem)));
    check("checkIssued against itself", cert.checkIssued(cert));

    check(
      "validity is ten years",
      Math.round((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000) === 3650,
    );
    check("notBefore is backdated", Date.parse(cert.validFrom) < Date.now());

    // The private key is a usable PKCS#8.
    const key = createPrivateKey(caKeyPem);
    check("private key is RSA 2048", key.asymmetricKeyDetails?.modulusLength === 2048);

    // A root CA must not be pinned to one purpose by an EKU.
    check("no extended key usage on the root", !openssslText(caPem).includes("Extended Key Usage"));
    check("keyCertSign is present", openssslText(caPem).includes("Certificate Sign"));

    const parsed = parseCertificate(caPem);
    check("own parser agrees it is a CA", parsed.isCa && parsed.canSign);
    check("own parser reads the subject", parsed.subject.includes("CN=Toolkit Test Root"), parsed.subject);
    check("own parser sees it is self-signed", parsed.selfSigned);
    check("serial is 16 bytes", parsed.serialHex.length === 32, parsed.serialHex);
  }

  console.log("\n-- leaf signed by that CA --");
  {
    const input: GenerateInput = {
      ...BASE_INPUT,
      issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem },
      purposes: ["tls-server", "tls-client"],
    };
    const bundle = await generate(input);
    const leaf = new X509Certificate(bundle.certificatePem!);
    const ca = new X509Certificate(caPem);

    check("subject is the common name", leaf.subject.includes("example.com"), leaf.subject);
    check("issuer is the CA's subject", leaf.issuer === ca.subject, `${leaf.issuer} vs ${ca.subject}`);
    check("is not a CA", !leaf.ca);

    // The whole point: a third party agrees the CA signed this.
    check("verifies against the CA key", leaf.verify(ca.publicKey));
    check("checkIssued by the CA", leaf.checkIssued(ca));

    // Node reads SANs back out, including both IP families.
    const sans = leaf.subjectAltName ?? "";
    check("DNS names survive", sans.includes("DNS:example.com") && sans.includes("DNS:www.example.com"), sans);
    check("IPv4 SAN survives", sans.includes("10.0.0.1"), sans);
    check("IPv6 SAN survives", sans.toLowerCase().includes("2001:db8"), sans);
    check("host name matches", leaf.checkHost("www.example.com") !== undefined, sans);

    const text = openssslText(bundle.certificatePem!);
    check("EKU lists both roles", text.includes("TLS Web Server Authentication") && text.includes("TLS Web Client Authentication"), text.slice(0, 200));
    check("authority key identifier is present", text.includes("Authority Key Identifier"));
    check(
      "AKI matches the CA's SKI",
      akiOf(text) !== null && akiOf(text) === skiOf(openssslText(caPem)),
      `${akiOf(text)} vs ${skiOf(openssslText(caPem))}`,
    );
    check("chain PEM holds two certificates", decodePem(bundle.chainPem ?? "").length === 2);

    // Signature algorithm must name ECDSA, since the CA here is RSA but the
    // subject key is EC — the two are independent and easy to confuse.
    check("signed with the CA's RSA key", leaf.publicKey.asymmetricKeyType === "ec" && text.includes("sha256WithRSAEncryption"), text.slice(0, 120));
  }

  console.log("\n-- signing with the session CA --");
  {
    const caInput: GenerateInput = {
      ...BASE_INPUT,
      mode: "ca",
      subject: { CN: "Session Root" },
      sans: [],
      purposes: [],
      keyAlgoId: "ec-p384",
      hash: "SHA-384",
      days: 365,
      pathLength: null,
    };
    const caBundle = await generate(caInput);
    const session = await toSessionCa(caInput, caBundle);

    const leaf = await generate({
      ...BASE_INPUT,
      subject: { CN: "app.internal" },
      sans: parseSans("app.internal"),
      issuer: { kind: "session" },
      sessionCa: session,
      hash: "SHA-384",
    });

    const leafCert = new X509Certificate(leaf.certificatePem!);
    const caCert = new X509Certificate(caBundle.certificatePem!);
    check("ECDSA P-384 CA signs a leaf", leafCert.verify(caCert.publicKey));
    check("issuer name matches", leafCert.issuer === caCert.subject);
    check("ECDSA signature is DER, not raw", openssslText(leaf.certificatePem!).includes("ecdsa-with-SHA384"));
  }

  console.log("\n-- key algorithms --");
  {
    for (const [id, hash, type, detail] of [
      ["rsa-3072", "SHA-384", "rsa", 3072],
      ["ec-p256", "SHA-256", "ec", "prime256v1"],
      ["ec-p521", "SHA-512", "ec", "secp521r1"],
    ] as const) {
      const bundle = await generate({
        ...BASE_INPUT,
        mode: "ca",
        subject: { CN: `Test ${id}` },
        sans: [],
        purposes: [],
        keyAlgoId: id,
        hash: hash as HashName,
        days: 30,
      });
      const cert = new X509Certificate(bundle.certificatePem!);
      const details = cert.publicKey.asymmetricKeyDetails;
      const actual = type === "rsa" ? details?.modulusLength : details?.namedCurve;
      check(`${id} produces a ${type} key`, cert.publicKey.asymmetricKeyType === type && actual === detail, String(actual));
      check(`${id} self-signature verifies`, cert.verify(cert.publicKey));
    }
  }

  console.log("\n-- certificate request --");
  {
    const bundle = await generate({
      ...BASE_INPUT,
      mode: "csr",
      subject: { CN: "csr.example.com", O: "Example Ltd", C: "VN" },
      sans: parseSans("csr.example.com, alt.example.com"),
      keyAlgoId: "rsa-2048",
    });
    check("produces a CSR and no certificate", bundle.csrPem !== null && bundle.certificatePem === null);
    check("CSR has the right PEM label", bundle.csrPem!.includes("BEGIN CERTIFICATE REQUEST"));

    if (OPENSSL_AVAILABLE) {
      // `-verify` checks the CSR's self-signature, which is the only thing a
      // CSR asserts and the thing a CA checks first.
      const verified = openssl(["req", "-verify", "-noout", "-text"], Buffer.from(bundle.csrPem!));
      check("OpenSSL parses the CSR", verified !== null, "openssl rejected it");
      if (verified) {
        check("subject survives", verified.includes("CN") && verified.includes("csr.example.com"));
        check("requested SANs survive", verified.includes("DNS:alt.example.com"), verified.slice(0, 400));
        check("requested EKU survives", verified.includes("TLS Web Server Authentication"));
      }
    }
  }

  console.log("\n-- refusals --");
  {
    await refuses(check, "a missing common name", { ...BASE_INPUT, mode: "csr", subject: {} as Dn });
    await refuses(check, "a three-letter country", { ...BASE_INPUT, mode: "csr", subject: { CN: "a.com", C: "VNM" } });
    await refuses(check, "zero days", { ...BASE_INPUT, mode: "csr", days: 0 });
    await refuses(check, "signing with no CA", { ...BASE_INPUT, issuer: { kind: "session" }, sessionCa: null });
    await refuses(check, "an empty CA certificate", {
      ...BASE_INPUT,
      issuer: { kind: "upload", certPem: "", keyPem: caKeyPem },
    });

    // The mismatched-key check: a real CA certificate with someone else's key.
    const other = await generate({
      ...BASE_INPUT,
      mode: "ca",
      subject: { CN: "Other Root" },
      sans: [],
      purposes: [],
      keyAlgoId: "rsa-2048",
    });
    await refuses(check, "a key that belongs to another CA", {
      ...BASE_INPUT,
      issuer: { kind: "upload", certPem: caPem, keyPem: other.privateKeyPem },
    });
  }

  console.log("\n-- warnings that do not stop generation --");
  {
    const noSans = await generate({ ...BASE_INPUT, sans: [], issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem } });
    check("warns about a TLS certificate with no SANs", noSans.notes.some((n) => n.includes("alternative names")), noSans.notes.join(" | "));

    const noPurpose = await generate({
      ...BASE_INPUT,
      purposes: [],
      issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem },
    });
    check("warns about no purpose at all", noPurpose.notes.some((n) => n.includes("extended key usage")), noPurpose.notes.join(" | "));

    // A leaf outliving its issuer is legal, useless, and worth saying.
    const outlives = await generate({
      ...BASE_INPUT,
      days: 20_000,
      issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem },
    });
    check("warns when the leaf outlives the CA", outlives.notes.some((n) => n.includes("outlives")), outlives.notes.join(" | "));

    // Signing with a leaf certificate instead of a CA.
    const leaf = await generate({ ...BASE_INPUT, issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem } });
    const fromLeaf = await generate({
      ...BASE_INPUT,
      subject: { CN: "under-a-leaf.test" },
      issuer: { kind: "upload", certPem: leaf.certificatePem!, keyPem: leaf.privateKeyPem },
    });
    check("warns when the issuer is not a CA", fromLeaf.notes.some((n) => n.includes("not marked as a CA")), fromLeaf.notes.join(" | "));
  }

  console.log("\n-- PKCS#12 --");
  {
    const bundle = await generate({
      ...BASE_INPUT,
      keyAlgoId: "rsa-2048",
      issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem },
    });
    const password = "correct horse battery";
    const p12 = await buildP12(bundle.keystore!, { password, alias: "example" });

    check("starts with a SEQUENCE", p12[0] === 0x30);
    check("is not trivially small", p12.length > 1000, String(p12.length));

    // Structure: PFX ::= SEQUENCE { version 3, authSafe, macData }.
    const pfx = readChildren(readDer(p12));
    check("version is 3", pfx[0]!.content[0] === 3);
    check("has macData", pfx.length === 3);

    if (OPENSSL_AVAILABLE) {
      const dir = mkdtempSync(join(tmpdir(), "tt-p12-"));
      try {
        const file = join(dir, "test.p12");
        writeFileSync(file, p12);

        // The real test: OpenSSL checks the MAC, derives the PBES2 key from the
        // password and decrypts the private key. All three have to be right.
        const info = openssl(["pkcs12", "-in", file, "-info", "-nodes", "-passin", `pass:${password}`]);
        check("OpenSSL opens it with the password", info !== null, "openssl refused the keystore");
        if (info) {
          check("the private key comes back out", info.includes("BEGIN PRIVATE KEY"));
          check("both certificates are inside", (info.match(/BEGIN CERTIFICATE/g) ?? []).length === 2);
          check("the friendly name survives", info.includes("example"), info.slice(0, 300));
          check("PBES2 with AES-256-CBC", info.includes("AES-256-CBC"), info.slice(0, 400));

          // And the key that came out is the one that went in: its public half
          // must equal the certificate's. A keystore that paired a key with
          // someone else's certificate would pass every check above and fail
          // only when a server tried to start with it.
          const extracted =
            info.slice(info.indexOf("-----BEGIN PRIVATE KEY"), info.indexOf("-----END PRIVATE KEY-----") + 25) + "\n";
          const spkiOf = (pem: string) =>
            createPublicKey(pem).export({ type: "spki", format: "der" }).toString("hex");
          check("the key inside matches the certificate", spkiOf(extracted) === spkiOf(bundle.certificatePem!));
        }

        const wrong = openssl(["pkcs12", "-in", file, "-info", "-nodes", "-passin", "pass:wrong"]);
        check("a wrong password is refused", wrong === null);
      } finally {
        discard(dir);
      }
    }

    // An EC key in a keystore exercises a different PKCS#8 shape.
    const ecBundle = await generate({ ...BASE_INPUT, issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem } });
    const ecP12 = await buildP12(ecBundle.keystore!, { password, alias: "ec" });
    if (OPENSSL_AVAILABLE) {
      const dir = mkdtempSync(join(tmpdir(), "tt-p12ec-"));
      try {
        const file = join(dir, "ec.p12");
        writeFileSync(file, ecP12);
        const info = openssl(["pkcs12", "-in", file, "-info", "-nodes", "-passin", `pass:${password}`]);
        check("an EC keystore opens too", info !== null && info.includes("BEGIN PRIVATE KEY"));
      } finally {
        discard(dir);
      }
    }
  }

  console.log("\n-- JKS --");
  {
    const bundle = await generate({
      ...BASE_INPUT,
      keyAlgoId: "rsa-2048",
      issuer: { kind: "upload", certPem: caPem, keyPem: caKeyPem },
    });
    const password = "changeit";
    const jks = await buildJavaKeystore(bundle.keystore!, { password, alias: "Server" });

    check("magic is 0xFEEDFEED", hex(jks.subarray(0, 4)) === "feedfeed", hex(jks.subarray(0, 4)));
    check("version is 2", hex(jks.subarray(4, 8)) === "00000002");
    check("holds one entry", hex(jks.subarray(8, 12)) === "00000001");
    check("the entry is a private key", hex(jks.subarray(12, 16)) === "00000001");

    // The protector's AlgorithmIdentifier must carry an explicit NULL. ASN.1
    // says the field is optional and Java reads only the OID, so omitting it
    // produces a keystore Java opens happily — and pyjks, which was written
    // against real keytool output, refuses outright. Pinned because the bug it
    // guards against is invisible to every check either side of it.
    const protectorAlgorithm = readChildren(readChildren(readDer(protectedInfo(jks)))[0]!);
    check(
      "the key protector names its OID",
      readOid(protectorAlgorithm[0]!) === "1.3.6.1.4.1.42.2.17.1.1",
      readOid(protectorAlgorithm[0]!),
    );
    check(
      "and carries an explicit NULL parameter",
      protectorAlgorithm.length === 2 && protectorAlgorithm[1]!.tag === 0x05,
      `${protectorAlgorithm.length} fields`,
    );

    // Java lower-cases aliases on the way in, so the file must contain the
    // lower-cased form or `keytool -list` will disagree with what was asked for.
    check("alias is lower-cased", Buffer.from(jks).includes(Buffer.from("server")), "alias not found");

    // The trailing digest seals the whole file under the password.
    const body = jks.subarray(0, jks.length - 20);
    const expected = createHash("sha1")
      .update(Buffer.from(utf16be(password)))
      .update(Buffer.from("Mighty Aphrodite", "utf8"))
      .update(Buffer.from(body))
      .digest();
    check("keystore digest matches", hex(jks.subarray(jks.length - 20)) === expected.toString("hex"));

    // Undo the key protector and confirm the PKCS#8 that comes back is the one
    // that went in. Same understanding as the writer, so this is a regression
    // check rather than an independent one.
    const recovered = recoverJksKey(jks, password);
    check(
      "the protected key decrypts to the original PKCS#8",
      hex(recovered) === hex(bundle.keystore!.pkcs8),
      `${recovered.length} vs ${bundle.keystore!.pkcs8.length} bytes`,
    );
    check("and Node accepts it as a key", (() => {
      try {
        return createPrivateKey({ key: Buffer.from(recovered), format: "der", type: "pkcs8" }).asymmetricKeyType === "rsa";
      } catch {
        return false;
      }
    })());

    // The certificates are stored in the clear, so they can simply be found.
    check(
      "both certificates are embedded",
      Buffer.from(jks).includes(Buffer.from(bundle.keystore!.chain[0]!)) &&
        Buffer.from(jks).includes(Buffer.from(bundle.keystore!.chain[1]!)),
    );
    check("each is tagged X.509", (Buffer.from(jks).toString("latin1").match(/X\.509/g) ?? []).length === 2);

    let shortPassword = false;
    try {
      await buildJks({ password: "short", alias: "a", pkcs8: bundle.keystore!.pkcs8, chain: [...bundle.keystore!.chain] });
    } catch {
      shortPassword = true;
    }
    check("refuses a password under six characters", shortPassword);
  }


  console.log("\n-- intermediate CA --");
  {
    // A three-tier PKI: root signs an intermediate, the intermediate signs a
    // leaf. The point of the check is the middle certificate — before this it
    // was impossible to make one, because being a CA implied being self-signed.
    const rootInput: GenerateInput = {
      ...BASE_INPUT,
      mode: "ca",
      subject: { CN: "Tier Root" },
      sans: [],
      purposes: [],
      keyAlgoId: "rsa-2048",
      days: 3650,
      pathLength: 1,
    };
    const root = await generate(rootInput);
    const rootCa = await toSessionCa(rootInput, root);

    const midInput: GenerateInput = {
      ...BASE_INPUT,
      subject: { CN: "Tier Issuing CA" },
      sans: [],
      purposes: [],
      keyAlgoId: "rsa-2048",
      days: 1825,
      isCa: true,
      pathLength: 0,
      issuer: { kind: "session" },
      sessionCa: rootCa,
    };
    const mid = await generate(midInput);
    const midCert = new X509Certificate(mid.certificatePem!);
    const rootCert = new X509Certificate(root.certificatePem!);

    check("the intermediate is a CA", midCert.ca);
    check("signed by the root, not itself", midCert.issuer === rootCert.subject && midCert.subject !== midCert.issuer);
    check("root's signature verifies", midCert.verify(rootCert.publicKey));
    check("pathlen:0 is set", openssslText(mid.certificatePem!).includes("pathlen:0"), openssslText(mid.certificatePem!).slice(0, 200));
    check("a CA carries no EKU", !openssslText(mid.certificatePem!).includes("Extended Key Usage"));
    check("its chain reaches the root", decodePem(mid.chainPem ?? "").length === 2);

    // The intermediate now signs, and its chain must come through whole.
    const midCa = await toSessionCa(midInput, mid);
    check("the intermediate can become the session CA", bundleIsCa(mid) && midCa.chain.length === 2);
    check("and remembers its pathlen", midCa.pathLength === 0, String(midCa.pathLength));

    const leaf = await generate({
      ...BASE_INPUT,
      subject: { CN: "server.tier.test" },
      sans: parseSans("server.tier.test"),
      issuer: { kind: "session" },
      sessionCa: midCa,
    });
    const leafCert = new X509Certificate(leaf.certificatePem!);
    check("the leaf is signed by the intermediate", leafCert.verify(midCert.publicKey));
    check("not a CA itself", !leafCert.ca);
    check(
      "the full chain is leaf, intermediate, root",
      decodePem(leaf.chainPem ?? "").length === 3,
      String(decodePem(leaf.chainPem ?? "").length),
    );

    if (OPENSSL_AVAILABLE) {
      // The real proof: OpenSSL builds and validates the whole path.
      const dir = mkdtempSync(join(tmpdir(), "tt-chain-"));
      try {
        writeFileSync(join(dir, "root.pem"), root.certificatePem!);
        writeFileSync(join(dir, "mid.pem"), mid.certificatePem!);
        writeFileSync(join(dir, "leaf.pem"), leaf.certificatePem!);
        const verified = openssl([
          "verify", "-CAfile", join(dir, "root.pem"),
          "-untrusted", join(dir, "mid.pem"), join(dir, "leaf.pem"),
        ]);
        check("OpenSSL validates the three-tier path", verified !== null && verified.includes("OK"), verified ?? "refused");
      } finally {
        discard(dir);
      }
    }

    // A CA under a pathlen:0 CA is legal to emit and useless in practice.
    const tooDeep = await generate({ ...midInput, subject: { CN: "Too Deep" }, issuer: { kind: "session" }, sessionCa: midCa });
    check("warns about issuing a CA under pathlen:0", tooDeep.notes.some((n) => n.includes("pathlen:0")), tooDeep.notes.join(" | "));

    // A CSR may also ask to be a CA.
    const caCsr = await generate({
      ...BASE_INPUT,
      mode: "csr",
      subject: { CN: "Requested CA" },
      sans: [],
      purposes: [],
      isCa: true,
      pathLength: null,
    });
    if (OPENSSL_AVAILABLE) {
      const text = openssl(["req", "-verify", "-noout", "-text"], Buffer.from(caCsr.csrPem!)) ?? "";
      check("a CSR can request CA:TRUE", text.includes("CA:TRUE"), text.slice(0, 300));
    }
  }

  console.log("\n-- PEM headers --");
  {
    // RFC 1421 headers must be split off, not stripped: the letters in
    // "ProcType" and "ENCRYPTED" survive a non-base64 filter and silently
    // corrupt the key body.
    const der = crypto.getRandomValues(new Uint8Array(96));
    const withHeaders =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "Proc-Type: 4,ENCRYPTED\n" +
      "DEK-Info: AES-256-CBC,0123456789ABCDEF0123456789ABCDEF\n" +
      "\n" +
      encodePem("X", der).split("\n").slice(1, -2).join("\n") +
      "\n-----END RSA PRIVATE KEY-----\n";

    const block = decodePem(withHeaders)[0]!;
    check("body survives the headers intact", hex(block.der) === hex(der), `${block.der.length} vs ${der.length} bytes`);
    check("Proc-Type is read", block.headers["Proc-Type"] === "4,ENCRYPTED", JSON.stringify(block.headers));
    check("DEK-Info is read", (block.headers["DEK-Info"] ?? "").startsWith("AES-256-CBC,"), JSON.stringify(block.headers));

    // A plain block has no headers, and base64 is never mistaken for one.
    const plain = decodePem(encodePem("CERTIFICATE", der))[0]!;
    check("a plain block has no headers", Object.keys(plain.headers).length === 0);
    check("and still round-trips", hex(plain.der) === hex(der));

    check("an encrypted key is detected", isEncryptedKeyPem(withHeaders));
    check("a plain key is not", !isEncryptedKeyPem(encodePem("PRIVATE KEY", der)));
  }

  console.log("\n-- DER input --");
  {
    const bundle = await generate({ ...BASE_INPUT, mode: "ca", subject: { CN: "DER Test" }, sans: [], purposes: [], keyAlgoId: "ec-p256" });
    const der = findPem(bundle.certificatePem!, ["CERTIFICATE"]).der;

    // A .crt straight off a device is binary; it has to come in as readily as
    // the PEM does.
    const converted = bytesToPemText(der, "CERTIFICATE");
    check("binary DER becomes PEM", converted.startsWith("-----BEGIN CERTIFICATE-----"));
    check("and parses to the same certificate", parseCertificate(converted).subject.includes("DER Test"));
    check(
      "PEM text is passed through untouched",
      bytesToPemText(new TextEncoder().encode(bundle.certificatePem!), "CERTIFICATE") === bundle.certificatePem,
    );
  }

  console.log("\n-- encrypted private keys --");
  {
    const passphrase = "correct horse battery staple";
    const bundle = await generate({ ...BASE_INPUT, mode: "ca", subject: { CN: "Enc Test" }, sans: [], purposes: [], keyAlgoId: "rsa-2048" });
    const plainPkcs8 = findPem(bundle.privateKeyPem, ["PRIVATE KEY"]).der;

    // Refusals first: they must name the missing passphrase rather than blame
    // the file.
    const encrypted = await encryptPkcs8(plainPkcs8, passphrase);
    await rejects(check, "an encrypted key with no passphrase", () => importPrivateKeyPem(encrypted, "SHA-256"), "passphrase");
    await rejects(check, "an encrypted key with the wrong passphrase", () => importPrivateKeyPem(encrypted, "SHA-256", "wrong"), "passphrase");

    const opened = await importPrivateKeyPem(encrypted, "SHA-256", passphrase);
    check("PBES2 round-trips to the original key", hex(opened.pkcs8) === hex(plainPkcs8), `${opened.pkcs8.length} bytes`);
    check("and the algorithm is recognised", opened.algo.id === "rsa-2048", opened.algo.id);

    if (OPENSSL_AVAILABLE) {
      const dir = mkdtempSync(join(tmpdir(), "tt-enc-"));
      try {
        const plainFile = join(dir, "plain.key");
        writeFileSync(plainFile, bundle.privateKeyPem);

        // Keys written by OpenSSL itself, which is the oracle that matters:
        // these are the forms a real CA key actually arrives in.
        const forms: [string, string[], string][] = [
          ["PBES2 AES-256 / SHA-256", ["-v2", "aes-256-cbc", "-v2prf", "hmacWithSHA256"], "pbes2-256.key"],
          ["PBES2 AES-128 / SHA-1 PRF", ["-v2", "aes-128-cbc", "-v2prf", "hmacWithSHA1"], "pbes2-128.key"],
          ["PBES2 at OpenSSL's default", [], "pbes2-default.key"],
        ];
        for (const [name, args, file] of forms) {
          const out = join(dir, file);
          const made = openssl(["pkcs8", "-topk8", "-in", plainFile, "-out", out, "-passout", `pass:${passphrase}`, ...args]);
          if (made === null) {
            check(`openssl wrote ${name}`, false, "openssl refused");
            continue;
          }
          const text = readFileSync(out, "utf8");
          const back = await importPrivateKeyPem(text, "SHA-256", passphrase);
          check(`opens ${name}`, hex(back.pkcs8) === hex(plainPkcs8), `${back.pkcs8.length} bytes`);
        }

        // The traditional PEM, whose key schedule is MD5-based EVP_BytesToKey.
        const trad = join(dir, "trad.key");
        if (openssl(["rsa", "-in", plainFile, "-out", trad, "-aes256", "-traditional", "-passout", `pass:${passphrase}`]) !== null) {
          const text = readFileSync(trad, "utf8");
          check("the traditional PEM is detected as encrypted", isEncryptedKeyPem(text));
          const back = await importPrivateKeyPem(text, "SHA-256", passphrase);
          check("opens a DEK-Info AES-256-CBC key", hex(back.pkcs8) === hex(plainPkcs8), `${back.pkcs8.length} bytes`);
          await rejects(check, "a DEK-Info key with the wrong passphrase", () => importPrivateKeyPem(text, "SHA-256", "wrong"), "passphrase");
        }

        // 3DES is a real format we genuinely cannot open. The message must say
        // so and offer the way out, not report a wrong passphrase.
        const des3 = join(dir, "des3.key");
        if (openssl(["pkcs8", "-topk8", "-in", plainFile, "-out", des3, "-passout", `pass:${passphrase}`, "-v1", "PBE-SHA1-3DES"]) !== null) {
          const text = readFileSync(des3, "utf8");
          let message = "";
          try {
            await importPrivateKeyPem(text, "SHA-256", passphrase);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          check("refuses 3DES by name", message.includes("3DES"), message);
          check("and says how to convert it", message.includes("openssl pkcs8"), message);
        }

        // An EC key takes a different PKCS#8 body through the same decryption.
        const ecBundle = await generate({ ...BASE_INPUT, mode: "ca", subject: { CN: "Enc EC" }, sans: [], purposes: [], keyAlgoId: "ec-p384" });
        const ecPlain = join(dir, "ec.key");
        writeFileSync(ecPlain, ecBundle.privateKeyPem);
        const ecEnc = join(dir, "ec-enc.key");
        if (openssl(["pkcs8", "-topk8", "-in", ecPlain, "-out", ecEnc, "-passout", `pass:${passphrase}`, "-v2", "aes-256-cbc"]) !== null) {
          const back = await importPrivateKeyPem(readFileSync(ecEnc, "utf8"), "SHA-384", passphrase);
          check("opens an encrypted EC key", back.algo.id === "ec-p384", back.algo.id);
        }

        // And the whole point: signing with an encrypted CA key, end to end.
        const signed = await generate({
          ...BASE_INPUT,
          subject: { CN: "signed-by-encrypted.test" },
          issuer: {
            kind: "upload",
            certPem: bundle.certificatePem!,
            keyPem: readFileSync(join(dir, "pbes2-256.key"), "utf8"),
            passphrase,
          },
        });
        check(
          "signs with an encrypted CA key",
          new X509Certificate(signed.certificatePem!).verify(new X509Certificate(bundle.certificatePem!).publicKey),
        );
      } finally {
        discard(dir);
      }
    }
  }


  console.log("\n-- the OpenSSL script the page shows --");
  {
    // These checks run the script. A printed command that does not execute, or
    // executes into a different certificate from the one the page builds, is
    // worse than showing nothing — so the assertion is not "the text looks
    // right" but "sh ran it, and the result matches".
    const SHELL = shellAvailable();
    if (!SHELL || !OPENSSL_AVAILABLE) {
      console.log("  note: sh or openssl is missing — the script was not executed.");
    }

    const cases: { name: string; input: GenerateInput; alias?: string }[] = [
      {
        name: "root CA",
        input: {
          ...BASE_INPUT,
          mode: "ca",
          subject: { CN: "Script Root", O: "Toolkit", C: "VN" },
          sans: [],
          purposes: [],
          keyAlgoId: "rsa-2048",
          days: 3650,
          pathLength: 1,
        },
      },
      {
        name: "EC root CA with no path limit",
        input: {
          ...BASE_INPUT,
          mode: "ca",
          subject: { CN: "Script EC Root" },
          sans: [],
          purposes: [],
          keyAlgoId: "ec-p384",
          hash: "SHA-384",
          days: 365,
          pathLength: null,
        },
      },
      {
        name: "TLS server certificate",
        input: {
          ...BASE_INPUT,
          keyAlgoId: "rsa-2048",
          subject: { CN: "script.example.com", O: "Example Ltd", C: "VN" },
          sans: parseSans("script.example.com, www.script.example.com, 10.0.0.7, 2001:db8::5"),
          purposes: ["tls-server", "tls-client"],
          days: 825,
        },
        alias: "server",
      },
      {
        name: "an intermediate CA",
        input: {
          ...BASE_INPUT,
          keyAlgoId: "ec-p256",
          subject: { CN: "Script Issuing CA" },
          sans: [],
          purposes: [],
          isCa: true,
          pathLength: 0,
          days: 1825,
        },
      },
      {
        name: "a document-signing certificate",
        input: {
          ...BASE_INPUT,
          keyAlgoId: "rsa-2048",
          subject: { CN: "Nguyen Van A", O: "Công ty ABC", C: "VN" },
          sans: parseSans("a@example.com"),
          purposes: ["document-signing", "email"],
          days: 398,
        },
      },
    ];

    for (const testCase of cases) {
      const steps = opensslSteps(testCase.input, { alias: testCase.alias });
      const script = stepsToScript(steps);

      // Cheap structural checks that hold with or without a shell.
      check(`${testCase.name}: starts by making a key`, steps[0]!.command.includes("openssl genpkey"));
      check(`${testCase.name}: every step has a title`, steps.every((s) => s.title.length > 0));
      if (testCase.alias) {
        const keystore = steps.find((step) => step.title.includes("Keystores"))?.command ?? "";
        check(`${testCase.name}: exports a .p12 under the alias`, keystore.includes(`-name '${testCase.alias}'`), keystore);
        check(`${testCase.name}: converts it to a JKS`, keystore.includes("keytool -importkeystore"), keystore);
      }
      check(
        `${testCase.name}: no passphrase is ever put on a command line`,
        !/-pass(in|out)\s/.test(script),
        script.slice(0, 200),
      );

      if (!SHELL || !OPENSSL_AVAILABLE) continue;

      const dir = mkdtempSync(join(tmpdir(), "tt-script-"));
      try {
        // Signing needs a CA on disk; the script expects ca.crt and ca.key.
        let issuerPem = "";
        if (testCase.input.mode === "signed") {
          const ca = await generate({
            ...BASE_INPUT,
            mode: "ca",
            subject: { CN: "Script Signing Root" },
            sans: [],
            purposes: [],
            keyAlgoId: "rsa-2048",
            days: 3650,
            pathLength: 1,
          });
          issuerPem = ca.certificatePem!;
          writeFileSync(join(dir, "ca.crt"), ca.certificatePem!);
          writeFileSync(join(dir, "ca.key"), ca.privateKeyPem);
        }

        // The keystore step is left out of the run: `keytool` needs a JDK, and
        // `pkcs12 -export` prompts for a password that the displayed command
        // deliberately does not carry. Its text is asserted separately below.
        const runnable = steps.filter((step) => !step.title.includes("Keystores"));
        writeFileSync(join(dir, "run.sh"), stepsToScript(runnable));
        const run = runScript(dir);
        check(`${testCase.name}: the script runs clean`, run.ok, run.output);
        if (!run.ok) continue;

        // And the certificate it produced is the one the page would have made.
        const base = fileBaseFor(testCase.input.subject, testCase.input.mode);
        const fromScript = join(dir, `${base}.crt`);

        const page = await generate(
          testCase.input.mode === "signed"
            ? {
                ...testCase.input,
                issuer: {
                  kind: "upload",
                  certPem: issuerPem,
                  keyPem: readFileSync(join(dir, "ca.key"), "utf8"),
                },
              }
            : testCase.input,
        );
        const pageFile = join(dir, "page.crt");
        writeFileSync(pageFile, page.certificatePem!);

        const shape = (file: string) =>
          (openssl([
            "x509", "-in", file, "-noout", "-subject", "-issuer",
            "-ext", "basicConstraints,keyUsage,extendedKeyUsage,subjectAltName",
          ]) ?? "")
            .replace(/\r/g, "")
            .trim();

        const scripted = shape(fromScript);
        const built = shape(pageFile);
        check(
          `${testCase.name}: the script's certificate matches the page's`,
          scripted === built && scripted.length > 0,
          `script:\n${scripted}\n--- page:\n${built}`,
        );

        // The chain the script assembles must validate, same as the page's.
        if (testCase.input.mode === "signed") {
          const verified = openssl(["verify", "-CAfile", join(dir, "ca.crt"), fromScript]);
          check(`${testCase.name}: OpenSSL validates what the script signed`, verified !== null, "refused");
          check(
            `${testCase.name}: the fullchain holds two certificates`,
            (readFileSync(join(dir, `${base}.fullchain.pem`), "utf8").match(/BEGIN CERTIFICATE/g) ?? []).length === 2,
          );
        }

        if (testCase.alias) {
          // The shown command lets OpenSSL prompt, which is right for a person
          // and impossible for a test: OpenSSL reads the prompt from the tty,
          // not stdin, so there is nothing to feed it. The test adds -passout,
          // which is exactly the flag the displayed command must never carry.
          const exported = spawnSync(
            "sh",
            ["-c", `openssl pkcs12 -export -inkey ${base}.key -in ${base}.crt -certfile ca.crt -name ${testCase.alias} -out ${base}.p12 -passout pass:changeit`],
            {
              cwd: dir,
              encoding: "utf8",
              input: "changeit\nchangeit\n",
              env: { ...process.env, MSYS_NO_PATHCONV: "1" },
            },
          );
          check(`${testCase.name}: the export command writes a .p12`, exported.status === 0, `${exported.stdout}${exported.stderr}`.slice(0, 300));
          if (exported.status === 0) {
            const info = openssl(["pkcs12", "-in", join(dir, `${base}.p12`), "-info", "-nokeys", "-passin", "pass:changeit"]);
            check(`${testCase.name}: and OpenSSL reads it back`, info !== null && info.includes("BEGIN CERTIFICATE"), "refused");
          }
        }
      } finally {
        discard(dir);
      }
    }

    // A CSR script is its own path: nothing signs it, so `req -verify` is the
    // only thing that can check it.
    if (SHELL && OPENSSL_AVAILABLE) {
      const csrInput: GenerateInput = {
        ...BASE_INPUT,
        mode: "csr",
        keyAlgoId: "rsa-2048",
        subject: { CN: "script-csr.example.com", O: "Example Ltd" },
        sans: parseSans("script-csr.example.com, alt.example.com"),
        purposes: ["tls-server"],
      };
      const dir = mkdtempSync(join(tmpdir(), "tt-csr-"));
      try {
        writeFileSync(join(dir, "run.sh"), stepsToScript(opensslSteps(csrInput)));
        const run = runScript(dir);
        check("CSR script: runs clean", run.ok, run.output);
        if (run.ok) {
          const base = fileBaseFor(csrInput.subject, "csr");
          const text = openssl(["req", "-in", join(dir, `${base}.csr`), "-noout", "-text", "-verify"]) ?? "";
          check("CSR script: the request carries its SANs", text.includes("DNS:alt.example.com"), text.slice(0, 400));
          check("CSR script: and its requested EKU", text.includes("TLS Web Server Authentication"));
        }
      } finally {
        discard(dir);
      }
    }

    // File names: a Vietnamese common name must fold to something usable rather
    // than collapse into a row of hyphens.
    {
      const name = (cn: string) => fileBaseFor({ CN: cn }, "ca");
      check("folds Vietnamese accents", name("Chứng thư gốc") === "chung-thu-goc", name("Chứng thư gốc"));
      check("maps đ by hand", name("Công ty Đông Á") === "cong-ty-dong-a", name("Công ty Đông Á"));
      check("keeps a host name as it is", name("www.example.com") === "www.example.com");
      check("names a wildcard readably", name("*.example.com") === "wildcard.example.com");
      check("falls back when nothing survives", name("中文") === "ca", name("中文"));
    }

    // Quoting is the part a script gets wrong silently. A DN holding the
    // characters OpenSSL's -subj parser treats as structure must survive.
    {
      const awkward: GenerateInput = {
        ...BASE_INPUT,
        mode: "ca",
        subject: { CN: "A/B Ltd. (test)", O: "O'Brien + Sons", C: "VN" },
        sans: [],
        purposes: [],
        keyAlgoId: "ec-p256",
        days: 30,
      };
      const steps = opensslSteps(awkward);
      check("awkward DN: the slash is escaped", steps[1]!.command.includes("A\\/B"), steps[1]!.command);
      check("awkward DN: the plus is escaped", steps[1]!.command.includes("\\+"), steps[1]!.command);
      check("awkward DN: the apostrophe is requoted", steps[1]!.command.includes(`'\\''`), steps[1]!.command);

      if (SHELL && OPENSSL_AVAILABLE) {
        const dir = mkdtempSync(join(tmpdir(), "tt-quote-"));
        try {
          writeFileSync(join(dir, "run.sh"), stepsToScript(steps));
          const run = runScript(dir);
          check("awkward DN: the script still runs", run.ok, run.output);
          if (run.ok) {
            const made = new X509Certificate(readFileSync(join(dir, `${fileBaseFor(awkward.subject, "ca")}.crt`), "utf8"));
            const page = new X509Certificate((await generate(awkward)).certificatePem!);
            check("awkward DN: subject survives intact", made.subject === page.subject, `${made.subject} vs ${page.subject}`);
          }
        } finally {
          discard(dir);
        }
      }
    }
  }

  if (!OPENSSL_AVAILABLE) {
    console.log("\n  note: openssl is not on PATH — the OpenSSL cross-checks were skipped.");
  }
}

/**
 * Runs the generated script in `dir`.
 *
 * `MSYS_NO_PATHCONV` is set because this machine's shell is Git Bash, whose
 * MSYS layer rewrites an argument starting with `/` into a Windows path — so
 * `-subj '/CN=x'` arrives as `C:/Program Files/Git/CN=x`. The script is correct
 * POSIX and runs unmodified on Linux, macOS and WSL; the variable makes this
 * shell behave like those rather than papering over a fault in the script.
 * openssl's key-generation progress dots are dropped so a real error is legible.
 */
function runScript(dir: string): { ok: boolean; output: string } {
  const run = spawnSync("sh", ["run.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  const output = `${run.stdout}${run.stderr}`
    .replace(/[.+*]{8,}/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .slice(0, 400);
  return { ok: !run.error && run.status === 0, output };
}

/**
 * Removes a temporary directory, tolerating a file Windows still has open —
 * a failed cleanup must not take the whole verification run down with it.
 */
function discard(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The OS will clear it eventually; it is under the temp directory.
  }
}

/** Asserts that a call rejects, and that its message mentions `contains`. */
async function rejects(
  check: Check,
  what: string,
  run: () => Promise<unknown>,
  contains: string,
): Promise<void> {
  let message = "";
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(
    `refuses ${what}`,
    message.toLowerCase().includes(contains.toLowerCase()),
    message || "it was accepted",
  );
}

/**
 * Wraps a PKCS#8 as an `ENCRYPTED PRIVATE KEY` under PBES2, so the decryption
 * path can be round-tripped without OpenSSL on the machine.
 *
 * This is self-consistency only — it proves the reader undoes what this writer
 * did. The OpenSSL-written keys below are what prove the reader understands the
 * format as everyone else writes it.
 */
async function encryptPkcs8(pkcs8: Uint8Array, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 10_000;

  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, pkcs8.slice().buffer),
  );

  const algorithm = sequence(
    oid("1.2.840.113549.1.5.13"),
    sequence(
      sequence(
        oid("1.2.840.113549.1.5.12"),
        sequence(
          octetString(salt),
          integer(iterations),
          sequence(oid("1.2.840.113549.2.9"), nullValue()),
        ),
      ),
      sequence(oid("2.16.840.1.101.3.4.1.42"), octetString(iv)),
    ),
  );
  return encodePem("ENCRYPTED PRIVATE KEY", sequence(algorithm, octetString(ciphertext)));
}

/** Asserts that `generate` refuses an input, and does so with a message. */
async function refuses(check: Check, what: string, input: GenerateInput): Promise<void> {
  let message = "";
  try {
    await generate(input);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(`refuses ${what}`, message.length > 0, message || "it was accepted");
}

/** `openssl x509 -text`, or an empty string when OpenSSL is absent. */
function openssslText(pem: string): string {
  if (!OPENSSL_AVAILABLE) return "";
  return openssl(["x509", "-noout", "-text"], Buffer.from(pem)) ?? "";
}

function afterLabel(text: string, label: string): string | null {
  const at = text.indexOf(label);
  if (at < 0) return null;
  const rest = text.slice(at + label.length);
  const match = rest.match(/([0-9A-F]{2}(:[0-9A-F]{2})+)/);
  return match ? match[1]! : null;
}

const skiOf = (text: string) => afterLabel(text, "Subject Key Identifier");
const akiOf = (text: string) => afterLabel(text, "Authority Key Identifier");

/**
 * Undoes `KeyProtector.protect` — the SHA-1 keystream XOR — to get the PKCS#8
 * back out of a JKS. The mirror image of what src/lib/jks.ts writes.
 */
function recoverJksKey(jks: Uint8Array, password: string): Uint8Array {
  // Skip magic, version, count, entry tag, then the alias and the timestamp.
  let at = 16;
  const aliasLength = (jks[at]! << 8) | jks[at + 1]!;
  at += 2 + aliasLength + 8;

  const keyLength = readInt(jks, at);
  at += 4;
  const encryptedPrivateKeyInfo = jks.subarray(at, at + keyLength);

  // EncryptedPrivateKeyInfo ::= SEQUENCE { AlgorithmIdentifier, OCTET STRING }
  const parts = readChildren(readDer(encryptedPrivateKeyInfo));
  const algorithm = readOid(readChildren(parts[0]!)[0]!);
  if (algorithm !== "1.3.6.1.4.1.42.2.17.1.1") throw new Error(`Unexpected protector OID: ${algorithm}`);

  const blob = parts[1]!.content;
  const salt = blob.subarray(0, 20);
  const encrypted = blob.subarray(20, blob.length - 20);
  const passwordBytes = Buffer.from(utf16be(password));

  const keystream = Buffer.alloc(Math.ceil(encrypted.length / 20) * 20);
  let previous = Buffer.from(salt);
  for (let offset = 0; offset < keystream.length; offset += 20) {
    previous = createHash("sha1").update(passwordBytes).update(previous).digest();
    previous.copy(keystream, offset);
  }

  const plain = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i += 1) plain[i] = encrypted[i]! ^ keystream[i]!;
  return plain;
}

/** The EncryptedPrivateKeyInfo bytes out of a single-entry JKS. */
function protectedInfo(jks: Uint8Array): Uint8Array {
  let at = 16;
  at += 2 + ((jks[at]! << 8) | jks[at + 1]!) + 8;
  const length = readInt(jks, at);
  return jks.subarray(at + 4, at + 4 + length);
}

function readInt(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

