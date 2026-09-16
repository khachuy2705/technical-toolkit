/**
 * Checks for the text-transform tools. Driven by scripts/verify.ts, which owns
 * the harness and the exit code.
 */

import { createHash } from "node:crypto";
import { decodeBase64, encodeBase64, bytesToBase64, base64ToBytes } from "../src/lib/base64";
import { hashBytes, hashText, toHex } from "../src/lib/hash";
import { md5 } from "../src/lib/md5";
import { findErrorIndex, formatJson } from "../src/lib/jsonfmt";
import { convertYaml } from "../src/lib/yamlfmt";
import { lineColumn, sortKeysDeep } from "../src/lib/format";

export type Check = (name: string, condition: boolean, detail?: string) => void;

/** RFC 1321, appendix A.5. */
const RFC1321 = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ],
  [
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    "57edf4a22be3c955ac49da2e2107b67a",
  ],
] as const;

function md5Hex(text: string): string {
  return toHex(md5(new TextEncoder().encode(text)));
}

export async function runToolChecks(check: Check): Promise<void> {
  console.log("\n-- md5 --");
  {
    for (const [input, expected] of RFC1321) {
      const label = input.length === 0 ? '""' : `"${input.slice(0, 24)}${input.length > 24 ? "…" : ""}"`;
      check(`RFC 1321 vector ${label}`, md5Hex(input) === expected, md5Hex(input));
    }

    // Node's MD5 is the oracle. Every length from 0 to 200 walks the padding
    // logic across both block boundaries — 55/56/57 and 63/64/65 are where a
    // hand-written MD5 usually breaks.
    let mismatch: string | null = null;
    for (let length = 0; length <= 200 && mismatch === null; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + length) & 0xff;
      const ours = toHex(md5(bytes));
      const theirs = createHash("md5").update(bytes).digest("hex");
      if (ours !== theirs) mismatch = `length ${length}: ${ours} vs ${theirs}`;
    }
    check("matches node:crypto for every length 0-200", mismatch === null, mismatch ?? "");

    // Multi-megabyte input, to confirm the bit-length field is written correctly
    // once the message is long enough to matter.
    const big = new Uint8Array(3_000_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
    check(
      "matches node:crypto on a 3 MB buffer",
      toHex(md5(big)) === createHash("md5").update(big).digest("hex"),
    );

    check("digest is 32 hex characters", /^[0-9a-f]{32}$/.test(md5Hex("anything")));
  }

  console.log("\n-- sha --");
  {
    check(
      "SHA-256 of empty input",
      (await hashText("sha-256", "")) ===
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    check(
      'SHA-256 of "abc"',
      (await hashText("sha-256", "abc")) ===
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    check(
      'SHA-512 of "abc"',
      (await hashText("sha-512", "abc")) ===
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
    check(
      "SHA-256 handles non-ASCII as UTF-8",
      (await hashText("sha-256", "café")) === createHash("sha256").update("café", "utf8").digest("hex"),
    );

    // A view into a larger buffer must hash its own bytes, not the whole buffer.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const window = backing.subarray(2, 5);
    check(
      "hashes a subarray view, not its backing buffer",
      (await hashBytes("sha-256", window)) ===
        createHash("sha256").update(Buffer.from([3, 4, 5])).digest("hex"),
    );
  }

  console.log("\n-- base64 --");
  {
    check("encodes ASCII", encodeBase64("hello") === "aGVsbG8=");
    check("decodes ASCII", decodeBase64("aGVsbG8=") === "hello");
    check("empty round-trips", encodeBase64("") === "" && decodeBase64("") === "");

    // btoa alone throws on this; the UTF-8 path is the whole point of the module.
    const unicode = "Chào thế giới 🎉 — ok";
    check("round-trips non-ASCII text", decodeBase64(encodeBase64(unicode)) === unicode, unicode);
    check(
      "matches Node's base64 for non-ASCII",
      encodeBase64(unicode) === Buffer.from(unicode, "utf8").toString("base64"),
    );

    const urlSafe = encodeBase64("~~~???>>>", "url");
    check("URL-safe output avoids + / =", !/[+/=]/.test(urlSafe), urlSafe);
    check("URL-safe round-trips", decodeBase64(urlSafe, "url") === "~~~???>>>");
    check("standard decoder accepts URL-safe input", decodeBase64(urlSafe) === "~~~???>>>");

    check("tolerates wrapped input", decodeBase64("aGVs\nbG8=") === "hello");
    check("tolerates missing padding", decodeBase64("aGVsbG8") === "hello");

    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    check(
      "byte round-trip is exact",
      [...base64ToBytes(bytesToBase64(bytes))].join() === [...bytes].join(),
    );

    let rejected = 0;
    for (const bad of ["aGVsbG8*", "!!!!", "a"]) {
      try {
        decodeBase64(bad);
      } catch {
        rejected += 1;
      }
    }
    check("rejects invalid input", rejected === 3, `${rejected}/3`);

    let binaryReported = false;
    try {
      // 0xFF is never a valid UTF-8 lead byte.
      decodeBase64(bytesToBase64(new Uint8Array([0xff, 0xfe, 0xfd])));
    } catch (error) {
      binaryReported = error instanceof Error && error.message.includes("not valid UTF-8");
    }
    check("reports binary payloads instead of mojibake", binaryReported);
  }

  console.log("\n-- json --");
  {
    const pretty = formatJson('{"b":1,"a":[2,3]}', { indent: 2, minify: false, sortKeys: false });
    check("pretty-prints", pretty.ok && pretty.output === '{\n  "b": 1,\n  "a": [\n    2,\n    3\n  ]\n}', pretty.ok ? pretty.output : pretty.message);

    const minified = formatJson('{ "a" : 1 , "b" : [ 2 ] }', { indent: 2, minify: true, sortKeys: false });
    check("minifies", minified.ok && minified.output === '{"a":1,"b":[2]}', minified.ok ? minified.output : minified.message);

    const sorted = formatJson('{"b":1,"a":{"d":2,"c":3}}', { indent: 2, minify: true, sortKeys: true });
    check("sorts keys recursively", sorted.ok && sorted.output === '{"a":{"c":3,"d":2},"b":1}', sorted.ok ? sorted.output : sorted.message);

    const arrays = formatJson('{"a":[3,1,2]}', { indent: 2, minify: true, sortKeys: true });
    check("leaves array order alone", arrays.ok && arrays.output === '{"a":[3,1,2]}', arrays.ok ? arrays.output : arrays.message);

    const tabbed = formatJson('{"a":1}', { indent: "tab", minify: false, sortKeys: false });
    check("indents with tabs", tabbed.ok && tabbed.output.includes("\t"), tabbed.ok ? JSON.stringify(tabbed.output) : tabbed.message);

    check("empty input yields empty output", (() => { const r = formatJson("   ", { indent: 2, minify: false, sortKeys: false }); return r.ok && r.output === ""; })());

    const broken = formatJson('{\n  "a": 1,\n  "b": ,\n}', { indent: 2, minify: false, sortKeys: false });
    check("reports a parse error", !broken.ok, broken.ok ? broken.output : broken.message);
    check(
      "names the failing line",
      !broken.ok && /line 3/.test(broken.message),
      broken.ok ? "" : broken.message,
    );

    for (const strict of ['{"a":1,}', "{a:1}", "{'a':1}", '{"a":1} // note']) {
      const result = formatJson(strict, { indent: 2, minify: false, sortKeys: false });
      check(`rejects non-strict JSON ${strict}`, !result.ok);
    }

    // The locator is bisection over JSON.parse, not message scraping, so these
    // offsets must hold on any engine. Each case names the first character the
    // parser genuinely cannot accept.
    const LOCATIONS: readonly [string, number][] = [
      ['{"a":1,}', 7],
      ["{a:1}", 1],
      ["[1, 2, 3,]", 9],
      ['{"a": tru}', 9],
      ['{"a":1} trailing', 8],
      ["[1,2,", 5],
      ['{"a": "unterminated', 19],
    ];
    for (const [text, index] of LOCATIONS) {
      check(`locates the error in ${text}`, findErrorIndex(text) === index, `got ${findErrorIndex(text)}, want ${index}`);
    }
    check("valid JSON has no error index", findErrorIndex('{"a":[1,2]}') === -1);

    const truncated = formatJson('{"a":', { indent: 2, minify: false, sortKeys: false });
    check("says when the input ends early", !truncated.ok && /ends before/.test(truncated.message), truncated.ok ? "" : truncated.message);

    check("lineColumn is 1-based", (() => { const p = lineColumn("ab\ncd", 3); return p.line === 2 && p.column === 1; })());
    check("sortKeysDeep leaves primitives", sortKeysDeep(5) === 5 && sortKeysDeep(null) === null);
  }

  console.log("\n-- yaml --");
  {
    const tidy = await convertYaml("b:   1\na:\n  - 2\n", { mode: "format", indent: 2, sortKeys: false });
    check("tidies YAML", tidy.ok && tidy.output === "b: 1\na:\n  - 2\n", tidy.ok ? JSON.stringify(tidy.output) : tidy.message);

    const toJson = await convertYaml("a: 1\nb: [2, 3]\n", { mode: "to-json", indent: 2, sortKeys: false });
    check("converts YAML to JSON", toJson.ok && JSON.parse(toJson.output as string).b[1] === 3, toJson.ok ? toJson.output : toJson.message);

    const fromJson = await convertYaml('{"a":1,"b":[2,3]}', { mode: "from-json", indent: 2, sortKeys: false });
    check("converts JSON to YAML", fromJson.ok && fromJson.output.startsWith("a: 1"), fromJson.ok ? JSON.stringify(fromJson.output) : fromJson.message);

    const sorted = await convertYaml("b: 1\na: 2\n", { mode: "format", indent: 2, sortKeys: true });
    check("sorts mapping keys", sorted.ok && sorted.output === "a: 2\nb: 1\n", sorted.ok ? JSON.stringify(sorted.output) : sorted.message);

    const indented = await convertYaml("a:\n  b:\n    c: 1\n", { mode: "format", indent: 4, sortKeys: false });
    check("honours the indent setting", indented.ok && indented.output.includes("    b:"), indented.ok ? JSON.stringify(indented.output) : indented.message);

    const multi = await convertYaml("a: 1\n---\nb: 2\n", { mode: "format", indent: 2, sortKeys: false });
    check("keeps both documents of a stream", multi.ok && multi.output.includes("---"), multi.ok ? JSON.stringify(multi.output) : multi.message);

    const multiJson = await convertYaml("a: 1\n---\nb: 2\n", { mode: "to-json", indent: 2, sortKeys: false });
    check("a multi-document stream becomes a JSON array", multiJson.ok && JSON.parse(multiJson.output as string).length === 2, multiJson.ok ? multiJson.output : multiJson.message);

    const broken = await convertYaml("a: [1, 2\nb: 3", { mode: "format", indent: 2, sortKeys: false });
    check("reports invalid YAML", !broken.ok, broken.ok ? broken.output : broken.message);
    check("names a line and column", !broken.ok && /line \d+, column \d+/.test(broken.message), broken.ok ? "" : broken.message);

    const badJson = await convertYaml("{not json}", { mode: "from-json", indent: 2, sortKeys: false });
    check("reports invalid JSON in from-json mode", !badJson.ok);

    // Documented behaviour, asserted so it cannot change silently: reformatting
    // is a parse-and-print, so comments do not survive it.
    const commented = await convertYaml("# keep me\na: 1\n", { mode: "format", indent: 2, sortKeys: false });
    check("comments are dropped, as documented", commented.ok && !commented.output.includes("keep me"), commented.ok ? JSON.stringify(commented.output) : commented.message);

    // YAML 1.2 core schema: the Norway problem does not bite.
    const norway = await convertYaml("country: NO\nflag: no\n", { mode: "to-json", indent: 2, sortKeys: false });
    const parsed = norway.ok ? (JSON.parse(norway.output) as Record<string, unknown>) : {};
    check('unquoted NO stays a string', parsed["country"] === "NO", JSON.stringify(parsed));

    const empty = await convertYaml("   ", { mode: "format", indent: 2, sortKeys: false });
    check("empty input yields empty output", empty.ok && empty.output === "");
  }
}
