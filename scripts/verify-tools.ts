/**
 * Checks for the text-transform tools. Driven by scripts/verify.ts, which owns
 * the harness and the exit code.
 */

import { createHash } from "node:crypto";
import { decodeBase64, encodeBase64, bytesToBase64, base64ToBytes } from "../src/lib/base64";
import { hashBytes, hashText, toHex } from "../src/lib/hash";
import { md5 } from "../src/lib/md5";
import { findErrorIndex, formatJson } from "../src/lib/jsonfmt";
import { HIGHLIGHT_LIMIT, highlightJson, tokenizeJson } from "../src/lib/jsonhighlight";
import { convertYaml } from "../src/lib/yamlfmt";
import { lineColumn, sortKeysDeep } from "../src/lib/format";
import {
  availableZones,
  civilFromDays,
  dayOfYear,
  daysFromCivil,
  daysInMonth,
  detectUnit,
  formatSpan,
  formatWallTime,
  formatZoned,
  isEpochText,
  isLeapYear,
  isoWeek,
  localZone,
  parseMoment,
  parseWallTime,
  relativeToNow,
  unitStrings,
  wallTimeAt,
  wallTimeToMs,
  weekdayIndex,
  WEEKDAYS,
  zoneOffsetMs,
  zonedParts,
} from "../src/lib/epoch";
import {
  classifyAddress,
  describeNetwork,
  formatCidr,
  formatIpv4,
  maskFromPrefix,
  parseCidr,
  parseIpv4,
  prefixFromMask,
  toBinary,
} from "../src/lib/ipv4";
import {
  dayCanChi,
  eraOffset,
  formatDmy,
  formatLunar,
  jdFromSolar,
  leapMonthNumber,
  leapMonthOf,
  LUNAR_MIN_YEAR,
  LunarError,
  lunarMonthSpan,
  lunarToSolar,
  lunarYearMonths,
  monthCanChi,
  solarFromJd,
  solarToLunar,
  solarToLunarAt,
  spellLunar,
  weekdayOfJd,
  WEEKDAYS_VI,
  yearCanChi,
} from "../src/lib/lunar";

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

  console.log("\n-- ipv4 --");
  {
    check("formats an address", formatIpv4(0xc0a8010a) === "192.168.1.10");
    check("formats the top of the space", formatIpv4(0xffffffff) === "255.255.255.255");
    check("round-trips every octet boundary", ["0.0.0.0", "1.2.3.4", "128.0.0.1", "255.255.255.255"].every((a) => formatIpv4(parseIpv4(a)) === a));

    // Addresses at or above 128.0.0.0 have the top bit set, which JavaScript's
    // signed bitwise operators turn negative without an explicit >>> 0.
    check("high addresses stay unsigned", parseIpv4("255.255.255.255") === 4294967295, String(parseIpv4("255.255.255.255")));
    check("network of a high address is unsigned", describeNetwork(parseIpv4("240.1.2.3"), 8).network === parseIpv4("240.0.0.0"));

    const BAD = ["256.1.1.1", "1.2.3", "1.2.3.4.5", "1.2.3.a", "", "1.2.3.-1", "01.2.3.4", "1.02.3.4"];
    let rejected = 0;
    for (const bad of BAD) {
      try { parseIpv4(bad); } catch { rejected += 1; }
    }
    check("rejects malformed addresses", rejected === BAD.length, rejected + "/" + BAD.length);

    // Leading zeros are octal to some parsers and decimal to others; refusing
    // them is the only reading that cannot be wrong.
    let octalRefused = false;
    try { parseIpv4("010.0.0.1"); } catch (error) {
      octalRefused = error instanceof Error && error.message.includes("leading zero");
    }
    check("refuses leading zeros by name", octalRefused);

    check("mask for /24", formatIpv4(maskFromPrefix(24)) === "255.255.255.0");
    check("mask for /0 is all zeros", maskFromPrefix(0) === 0, String(maskFromPrefix(0)));
    check("mask for /32 is all ones", maskFromPrefix(32) === 4294967295, String(maskFromPrefix(32)));
    check(
      "every prefix round-trips through its mask",
      Array.from({ length: 33 }, (_, i) => i).every((p) => prefixFromMask(maskFromPrefix(p)) === p),
    );

    // The cheat sheet on the page is generated from maskFromPrefix, so these 33
    // strings are published reference data. Pinned in full: a regression here
    // would quietly hand every visitor a wrong table.
    const MASKS: readonly string[] = [
      "0.0.0.0", "128.0.0.0", "192.0.0.0", "224.0.0.0",
      "240.0.0.0", "248.0.0.0", "252.0.0.0", "254.0.0.0",
      "255.0.0.0", "255.128.0.0", "255.192.0.0", "255.224.0.0",
      "255.240.0.0", "255.248.0.0", "255.252.0.0", "255.254.0.0",
      "255.255.0.0", "255.255.128.0", "255.255.192.0", "255.255.224.0",
      "255.255.240.0", "255.255.248.0", "255.255.252.0", "255.255.254.0",
      "255.255.255.0", "255.255.255.128", "255.255.255.192", "255.255.255.224",
      "255.255.255.240", "255.255.255.248", "255.255.255.252", "255.255.255.254",
      "255.255.255.255",
    ];
    const rendered = MASKS.map((_, prefix) => formatIpv4(maskFromPrefix(prefix)));
    const firstWrong = rendered.findIndex((m, i) => m !== MASKS[i]);
    check(
      "the full /0-/32 mask table is correct",
      firstWrong === -1,
      firstWrong === -1 ? "" : `/${firstWrong}: ${rendered[firstWrong]} vs ${MASKS[firstWrong]}`,
    );

    let gappy = false;
    try { prefixFromMask(parseIpv4("255.255.0.255")); } catch { gappy = true; }
    check("rejects a non-contiguous mask", gappy);

    const NETWORKS: readonly [string, number, string, string, string, string, number][] = [
      ["192.168.1.10/24", 24, "255.255.255.0", "192.168.1.0", "192.168.1.1", "192.168.1.254", 254],
      ["10.0.0.0/8", 8, "255.0.0.0", "10.0.0.0", "10.0.0.1", "10.255.255.254", 16777214],
      ["172.16.5.3/30", 30, "255.255.255.252", "172.16.5.0", "172.16.5.1", "172.16.5.2", 2],
      ["192.168.1.130/26", 26, "255.255.255.192", "192.168.1.128", "192.168.1.129", "192.168.1.190", 62],
      ["0.0.0.0/0", 0, "0.0.0.0", "0.0.0.0", "0.0.0.1", "255.255.255.254", 4294967294],
    ];
    for (const [text, prefix, mask, network, first, last, usable] of NETWORKS) {
      const parsed = parseCidr(text);
      const net = describeNetwork(parsed.address, parsed.prefix);
      const actual = [parsed.prefix, formatIpv4(net.mask), formatIpv4(net.network), formatIpv4(net.firstHost), formatIpv4(net.lastHost), net.usableHosts];
      const expected = [prefix, mask, network, first, last, usable];
      check(text + " resolves correctly", actual.join("|") === expected.join("|"), actual.join(" ") + " vs " + expected.join(" "));
    }

    // The canonical form a route table or firewall rule wants: the network, not
    // the host address that was typed. Each pair is host input -> subnet.
    const CANONICAL: readonly [string, string][] = [
      ["10.144.141.83/26", "10.144.141.64/26"],
      ["192.168.1.200/24", "192.168.1.0/24"],
      ["172.16.5.3/30", "172.16.5.0/30"],
      ["10.0.0.7/8", "10.0.0.0/8"],
      ["203.0.113.7/31", "203.0.113.6/31"],
      ["10.1.2.3/32", "10.1.2.3/32"],
      ["255.255.255.255/1", "128.0.0.0/1"],
    ];
    for (const [input, expected] of CANONICAL) {
      const parsed = parseCidr(input);
      const net = describeNetwork(parsed.address, parsed.prefix);
      const actual = formatCidr(net.network, net.prefix);
      check(input + " is in " + expected, actual === expected, actual);
    }

    check(
      "the canonical form is idempotent",
      CANONICAL.every(([, subnet]) => {
        const parsed = parseCidr(subnet);
        const net = describeNetwork(parsed.address, parsed.prefix);
        return formatCidr(net.network, net.prefix) === subnet;
      }),
    );

    check("broadcast of a /24", formatIpv4(describeNetwork(parseIpv4("192.168.1.10"), 24).broadcast) === "192.168.1.255");
    check("wildcard of a /24", formatIpv4(describeNetwork(parseIpv4("192.168.1.10"), 24).wildcard) === "0.0.0.255");
    check("host bits are cleared", formatIpv4(describeNetwork(parseIpv4("192.168.1.200"), 24).network) === "192.168.1.0");

    // RFC 3021: a /31 has two usable addresses and no broadcast. A naive
    // "total minus two" reports 0 here and -1 for a /32.
    const p31 = describeNetwork(parseIpv4("203.0.113.6"), 31);
    check("/31 has 2 usable hosts", p31.usableHosts === 2, String(p31.usableHosts));
    check("/31 hosts are both addresses", formatIpv4(p31.firstHost) === "203.0.113.6" && formatIpv4(p31.lastHost) === "203.0.113.7", formatIpv4(p31.firstHost) + "-" + formatIpv4(p31.lastHost));

    const p32 = describeNetwork(parseIpv4("10.1.2.3"), 32);
    check("/32 has 1 usable host", p32.usableHosts === 1, String(p32.usableHosts));
    check("/32 first and last are the address", formatIpv4(p32.firstHost) === "10.1.2.3" && formatIpv4(p32.lastHost) === "10.1.2.3");
    check("/31 and /32 are flagged degenerate", p31.degenerate && p32.degenerate);
    check("/30 is not degenerate", !describeNetwork(parseIpv4("10.0.0.0"), 30).degenerate);

    check(
      "usable hosts never go negative",
      Array.from({ length: 33 }, (_, i) => i).every((p) => describeNetwork(parseIpv4("10.20.30.40"), p).usableHosts >= 1),
    );
    check(
      "total addresses double as the prefix shrinks",
      Array.from({ length: 33 }, (_, i) => i).every((p) => describeNetwork(0, p).totalAddresses === 2 ** (32 - p)),
    );

    check("accepts a dotted mask", parseCidr("10.0.0.1/255.255.255.0").prefix === 24);
    check("accepts a space separator", parseCidr("10.0.0.1 255.255.128.0").prefix === 17);
    check("a bare address is /32 and says so", (() => { const r = parseCidr("10.0.0.1"); return r.prefix === 32 && r.prefixAssumed; })());
    check("a written prefix is not marked assumed", !parseCidr("10.0.0.1/24").prefixAssumed);

    const BAD_PREFIXES = ["1.2.3.4/33", "1.2.3.4/", "1.2.3.4/abc", "1.2.3.4/-1", "1.2.3.4/255.255.0.255"];
    let badPrefixes = 0;
    for (const bad of BAD_PREFIXES) {
      try { parseCidr(bad); } catch { badPrefixes += 1; }
    }
    check("rejects bad prefixes", badPrefixes === BAD_PREFIXES.length, badPrefixes + "/" + BAD_PREFIXES.length);

    const KINDS: readonly [string, string][] = [
      ["10.1.2.3", "Private"],
      ["172.16.0.1", "Private"],
      ["172.32.0.1", "Public"],
      ["192.168.0.1", "Private"],
      ["127.0.0.1", "Loopback"],
      ["169.254.1.1", "Link-local"],
      ["100.64.0.1", "Carrier-grade NAT"],
      ["203.0.113.1", "Documentation"],
      ["224.0.0.1", "Multicast"],
      ["8.8.8.8", "Public"],
      ["255.255.255.255", "Limited broadcast"],
    ];
    for (const [address, label] of KINDS) {
      check(address + " is " + label, classifyAddress(parseIpv4(address)).label === label, classifyAddress(parseIpv4(address)).label);
    }

    check("binary view groups by octet", toBinary(parseIpv4("192.168.1.0")) === "11000000.10101000.00000001.00000000", toBinary(parseIpv4("192.168.1.0")));
  }
  console.log("\n-- epoch: unit detection --");
  {
    // The boundaries are the digit counts a present-day timestamp has in each
    // unit; the in-between lengths must round down to the coarser one.
    const DIGITS: readonly [number, string][] = [
      [1, "seconds"], [9, "seconds"], [10, "seconds"],
      [11, "milliseconds"], [13, "milliseconds"],
      [14, "microseconds"], [16, "microseconds"],
      [17, "nanoseconds"], [19, "nanoseconds"], [25, "nanoseconds"],
    ];
    for (const [digits, unit] of DIGITS) {
      check(`${digits} digits reads as ${unit}`, detectUnit(digits) === unit, detectUnit(digits));
    }

    const SAME_INSTANT = ["1758086602", "1758086602000", "1758086602000000", "1758086602000000000"];
    check(
      "the same instant in all four units auto-detects to one time",
      new Set(SAME_INSTANT.map((text) => parseMoment(text).ms)).size === 1,
      JSON.stringify(SAME_INSTANT.map((t) => parseMoment(t).ms)),
    );

    // Forcing a unit must override the guess, not be ignored by it.
    check("forcing milliseconds overrides the guess", parseMoment("1758086602", "milliseconds").ms === 1758086602);
    check("forcing seconds overrides the guess", parseMoment("1758086602000", "seconds").ms === 1758086602000000);
    check("auto is reported in the explanation", /10 digits/.test(parseMoment("1758086602").how), parseMoment("1758086602").how);
    check("a forced unit explains without digit counting", !/digit/.test(parseMoment("1758086602", "seconds").how), parseMoment("1758086602", "seconds").how);
  }

  console.log("\n-- epoch: exactness --");
  {
    // The point of carrying nanoseconds as a bigint: 19 digits is past
    // Number.MAX_SAFE_INTEGER, so a double round-trip would change the value.
    const NANOS = "1699999999123456789";
    const exact = parseMoment(NANOS);
    check("a 19-digit nanosecond value survives unchanged", unitStrings(exact.nanos).nanoseconds === NANOS, unitStrings(exact.nanos).nanoseconds);
    check(
      "the same value through a double would have been wrong",
      String(Number(NANOS)) !== NANOS,
      `Number() gives ${Number(NANOS)}`,
    );
    check("its millisecond floor is right", exact.ms === 1699999999123, String(exact.ms));
    check("its microseconds are exact", unitStrings(exact.nanos).microseconds === "1699999999123456");

    const half = parseMoment("1699999999.5");
    check("a fractional epoch is read as seconds", half.unit === "seconds" && half.ms === 1699999999500, `${half.unit} ${half.ms}`);
    check("its nanoseconds are exact, not a float product", unitStrings(half.nanos).nanoseconds === "1699999999500000000", unitStrings(half.nanos).nanoseconds);

    const fine = parseMoment("1699999999.1234567891", "seconds");
    check("digits finer than a nanosecond are dropped and said so", /finer digits dropped/.test(fine.how), fine.how);

    // Before 1970 every division has to floor, not truncate toward zero.
    const NEGATIVE: readonly [string, number, string][] = [
      ["-1", -1000, "-1"],
      ["-0.5", -500, "-1"],
      ["-1000", -1000000, "-1000"],
    ];
    for (const [text, ms, seconds] of NEGATIVE) {
      const m = parseMoment(text);
      check(`${text} floors correctly below the epoch`, m.ms === ms && unitStrings(m.nanos).seconds === seconds, `${m.ms} / ${unitStrings(m.nanos).seconds}`);
    }
    check("-1 is one second before the epoch", formatZoned(parseMoment("-1").ms, "UTC") === "1969-12-31 23:59:59 +00:00", formatZoned(parseMoment("-1").ms, "UTC"));
  }

  console.log("\n-- epoch: date strings --");
  {
    check("ISO 8601 with a Z", parseMoment("2026-09-17T14:03:22Z").ms === 1789653802000, String(parseMoment("2026-09-17T14:03:22Z").ms));
    check("an explicit offset is honoured", parseMoment("2026-09-17T21:03:22+07:00").ms === 1789653802000, String(parseMoment("2026-09-17T21:03:22+07:00").ms));
    check("a date string reports no unit", parseMoment("2026-09-17T14:03:22Z").unit === null);

    // The ECMAScript spec's asymmetry, surfaced rather than hidden: a bare date
    // is UTC, a bare date-time is local.
    check("a bare date is midnight UTC", formatZoned(parseMoment("2026-09-17").ms, "UTC") === "2026-09-17 00:00:00 +00:00", formatZoned(parseMoment("2026-09-17").ms, "UTC"));
    check("and says so", /midnight UTC/.test(parseMoment("2026-09-17").how), parseMoment("2026-09-17").how);
    check("a zoneless date-time says it used the local zone", /local time zone/.test(parseMoment("2026-09-17T14:03:22").how), parseMoment("2026-09-17T14:03:22").how);
    check("a zoned string says it carried its own offset", /its own offset/.test(parseMoment("2026-09-17T14:03:22Z").how), parseMoment("2026-09-17T14:03:22Z").how);

    // `YYYY-MM-DD HH:MM:SS` is not in the spec; it is repaired to the T form so
    // every browser reads it the same way rather than by private extension.
    check("the SQL form parses", parseMoment("2026-09-17 14:03:22").ms === parseMoment("2026-09-17T14:03:22").ms);

    const BAD = ["", "   ", "not a date", "2026-13-45T99:99:99Z", "0x10"];
    let rejected = 0;
    for (const bad of BAD) {
      try { parseMoment(bad); } catch { rejected += 1; }
    }
    check("rejects what it cannot read", rejected === BAD.length, `${rejected}/${BAD.length}`);

    // V8 reads "1.2.3" as 2 January 2003 and "09/17/2026" by American
    // convention; other engines disagree. Guessing is worse than refusing, so
    // a letterless string has to be ISO-shaped.
    // `1.2` is deliberately absent: it is a valid fractional epoch, not a date.
    const AMBIGUOUS = ["1.2.3", "09/17/2026", "17/09/2026", "10.0.0.1", "2026.09.17"];
    let refused = 0;
    let named = 0;
    for (const text of AMBIGUOUS) {
      try {
        parseMoment(text);
      } catch (error) {
        refused += 1;
        if (error instanceof Error && /too ambiguous/.test(error.message)) named += 1;
      }
    }
    check("refuses dates only a legacy parser would accept", refused === AMBIGUOUS.length, `${refused}/${AMBIGUOUS.length}`);
    check("and says why rather than just failing", named === AMBIGUOUS.length, `${named}/${AMBIGUOUS.length}`);

    // A spelled-out month is not ambiguous, so those still parse.
    check("a written month still works", parseMoment("17 Sep 2026 14:03:22 GMT").ms === Date.UTC(2026, 8, 17, 14, 3, 22), String(parseMoment("17 Sep 2026 14:03:22 GMT").ms));
    check("the RFC 2822 form in a log still works", parseMoment("Thu, 17 Sep 2026 14:03:22 GMT").ms === Date.UTC(2026, 8, 17, 14, 3, 22));

    let outOfRange = false;
    try { parseMoment("99999999999999999999999999", "seconds"); } catch (error) {
      outOfRange = error instanceof Error && /outside the range/.test(error.message);
    }
    check("refuses a value no date can hold, by name", outOfRange);
  }

  console.log("\n-- epoch: calendar --");
  {
    check("the epoch is day zero", daysFromCivil(1970, 1, 1) === 0, String(daysFromCivil(1970, 1, 1)));
    check("day zero is the epoch", JSON.stringify(civilFromDays(0)) === '{"year":1970,"month":1,"day":1}', JSON.stringify(civilFromDays(0)));

    // 400 years either side of the epoch, every day: the two functions must be
    // exact inverses, which is what makes the rest of this section trustworthy.
    let broken: string | null = null;
    for (let days = -146097; days <= 146097 && broken === null; days += 1) {
      const civil = civilFromDays(days);
      if (daysFromCivil(civil.year, civil.month, civil.day) !== days) {
        broken = `day ${days} became ${JSON.stringify(civil)}`;
      }
    }
    check("civil-days round-trips for 800 years of dates", broken === null, broken ?? "");

    const WEEKDAY_CASES: readonly [number, number, number, string][] = [
      [1970, 1, 1, "Thursday"],
      [1969, 12, 31, "Wednesday"],
      [2000, 1, 1, "Saturday"],
      [2024, 2, 29, "Thursday"],
      [2026, 9, 17, "Thursday"],
      [2038, 1, 19, "Tuesday"],
    ];
    for (const [year, month, day, name] of WEEKDAY_CASES) {
      const actual = WEEKDAYS[weekdayIndex(year, month, day)];
      check(`${year}-${month}-${day} was a ${name}`, actual === name, String(actual));
    }

    check("leap years", [2000, 2024, 1996].every(isLeapYear) && ![1900, 2023, 2100].some(isLeapYear));
    check("day 366 exists in 2024", dayOfYear(2024, 12, 31) === 366, String(dayOfYear(2024, 12, 31)));
    check("and not in 2023", dayOfYear(2023, 12, 31) === 365, String(dayOfYear(2023, 12, 31)));
    check("1 March is day 61 in a leap year", dayOfYear(2024, 3, 1) === 61, String(dayOfYear(2024, 3, 1)));
    check("and day 60 otherwise", dayOfYear(2023, 3, 1) === 60, String(dayOfYear(2023, 3, 1)));

    // The cases that catch naive week numbering: a January day that belongs to
    // the previous year, and a December day that belongs to the next one.
    const WEEK_CASES: readonly [number, number, number, string][] = [
      [2026, 9, 17, "2026-W38"],
      [1970, 1, 1, "1970-W01"],
      [2021, 1, 1, "2020-W53"],
      [2020, 12, 31, "2020-W53"],
      [2027, 1, 1, "2026-W53"],
      [2019, 12, 30, "2020-W01"],
      [2016, 1, 1, "2015-W53"],
    ];
    for (const [year, month, day, expected] of WEEK_CASES) {
      const week = isoWeek(year, month, day);
      const actual = `${week.year}-W${String(week.week).padStart(2, "0")}`;
      check(`${year}-${month}-${day} is ${expected}`, actual === expected, actual);
    }
  }

  console.log("\n-- epoch: rendering --");
  {
    // Published reference data: these nine rows are printed on the page, so a
    // formatting regression would hand every visitor a wrong table.
    const LANDMARKS: readonly [number, string][] = [
      [-2208988800, "1900-01-01 00:00:00 +00:00"],
      [-1, "1969-12-31 23:59:59 +00:00"],
      [0, "1970-01-01 00:00:00 +00:00"],
      [1000000000, "2001-09-09 01:46:40 +00:00"],
      [1234567890, "2009-02-13 23:31:30 +00:00"],
      [2000000000, "2033-05-18 03:33:20 +00:00"],
      [2147483647, "2038-01-19 03:14:07 +00:00"],
      [4294967295, "2106-02-07 06:28:15 +00:00"],
      [253402300799, "9999-12-31 23:59:59 +00:00"],
    ];
    for (const [epoch, expected] of LANDMARKS) {
      const actual = formatZoned(epoch * 1000, "UTC");
      check(`${epoch} is ${expected}`, actual === expected, actual);
    }

    // A fixed-offset zone and a zone with daylight saving, at both ends of the
    // year: rendering is where an offset gets dropped or applied backwards.
    check("a +07:00 zone shifts forward", formatZoned(Date.UTC(2026, 0, 1), "Asia/Ho_Chi_Minh") === "2026-01-01 07:00:00 +07:00", formatZoned(Date.UTC(2026, 0, 1), "Asia/Ho_Chi_Minh"));
    // Saigon ran on +08:00 until 1975, and the tz database knows it. Pinned
    // because "apply the current offset to every date" is the shortcut that
    // makes a converter wrong about anything historical.
    check("a historical offset is not the current one", formatZoned(0, "Asia/Ho_Chi_Minh") === "1970-01-01 08:00:00 +08:00", formatZoned(0, "Asia/Ho_Chi_Minh"));
    check("winter in New York is -05:00", formatZoned(Date.UTC(2026, 0, 15, 12), "America/New_York") === "2026-01-15 07:00:00 -05:00", formatZoned(Date.UTC(2026, 0, 15, 12), "America/New_York"));
    check("summer in New York is -04:00", formatZoned(Date.UTC(2026, 6, 15, 12), "America/New_York") === "2026-07-15 08:00:00 -04:00", formatZoned(Date.UTC(2026, 6, 15, 12), "America/New_York"));
    check("a half-hour offset survives", formatZoned(0, "Asia/Kolkata") === "1970-01-01 05:30:00 +05:30", formatZoned(0, "Asia/Kolkata"));

    // Crossing a date line in the local zone is the case that makes "which day
    // was that" a different answer per zone.
    const newYear = Date.UTC(2026, 0, 1, 2);
    const tokyo = zonedParts(newYear, "Asia/Tokyo");
    const losAngeles = zonedParts(newYear, "America/Los_Angeles");
    check("one instant is two different dates", tokyo.day === 1 && losAngeles.day === 31, `${tokyo.year}-${tokyo.month}-${tokyo.day} vs ${losAngeles.year}-${losAngeles.month}-${losAngeles.day}`);

    check("the ISO rendering is the JavaScript one", new Date(parseMoment("1758086602").ms).toISOString() === "2025-09-17T05:23:22.000Z");

    check("UTC is always offered", availableZones().includes("UTC"));
    check("the local zone is always offered", availableZones().includes(localZone()), localZone());
    check("the zone list is sorted and unique", (() => {
      const zones = availableZones();
      return zones.every((zone, i) => i === 0 || zones[i - 1]! < zone);
    })());

    const SPANS: readonly [number, string][] = [
      [0, "0 seconds"],
      [1, "1 second"],
      [60, "1 minute"],
      [3600, "1 hour"],
      [86400, "1 day"],
      [90061, "1 day 1 hour"],
      [604800, "7 days"],
      [31536000, "1 year"],
      [63072000, "2 years"],
    ];
    for (const [seconds, expected] of SPANS) {
      check(`${seconds} s is ${expected}`, formatSpan(seconds) === expected, formatSpan(seconds));
    }

    const now = Date.UTC(2026, 8, 17, 12);
    check("relative: an hour ago", relativeToNow(now - 3600_000, now) === "1 hour ago", relativeToNow(now - 3600_000, now));
    check("relative: in two days", relativeToNow(now + 2 * 86400_000, now) === "in 2 days", relativeToNow(now + 2 * 86400_000, now));
    check("relative: the present is not a duration", relativeToNow(now, now) === "right now", relativeToNow(now, now));
  }

  console.log("\n-- epoch: wall time to epoch --");
  {
    const wall = parseWallTime("2026-09-17T14:03:22");
    check("parses the datetime-local shape", formatWallTime(wall) === "2026-09-17T14:03:22", formatWallTime(wall));
    check("a space works as well as a T", formatWallTime(parseWallTime("2026-09-17 14:03")) === "2026-09-17T14:03:00");
    check("February has 29 days in a leap year only", daysInMonth(2024, 2) === 29 && daysInMonth(2023, 2) === 28 && daysInMonth(1900, 2) === 28);

    // Date would roll each of these over into a neighbouring day without a word.
    const IMPOSSIBLE = ["2023-02-29T00:00", "2026-04-31T00:00", "2026-13-01T00:00", "2026-09-17T24:00", "2026-09-17T12:60", "2026-09-17T12:00:60", "2026-09-17", "17/09/2026 12:00"];
    let refused = 0;
    for (const text of IMPOSSIBLE) {
      try { parseWallTime(text); } catch { refused += 1; }
    }
    check("refuses wall times that do not exist on any calendar", refused === IMPOSSIBLE.length, `${refused}/${IMPOSSIBLE.length}`);

    // One wall time, several zones. Each expected instant is independently known.
    const ZONED: readonly [string, string, string][] = [
      ["2026-09-17T14:03:22", "UTC", "2026-09-17T14:03:22.000Z"],
      ["2026-09-17T14:03:22", "Asia/Ho_Chi_Minh", "2026-09-17T07:03:22.000Z"],
      ["2026-09-17T14:03:22", "Asia/Kolkata", "2026-09-17T08:33:22.000Z"],
      ["2026-01-15T07:00:00", "America/New_York", "2026-01-15T12:00:00.000Z"],
      ["2026-07-15T08:00:00", "America/New_York", "2026-07-15T12:00:00.000Z"],
      ["1970-01-01T08:00:00", "Asia/Ho_Chi_Minh", "1970-01-01T00:00:00.000Z"],
    ];
    for (const [text, zone, expected] of ZONED) {
      const result = wallTimeToMs(parseWallTime(text), zone);
      const actual = new Date(result.ms).toISOString();
      check(`${text} in ${zone} is ${expected}`, actual === expected && result.resolution === "exact", `${actual} ${result.resolution}`);
    }

    // Spring forward: 02:00-02:59 on 8 March 2026 never happened in New York.
    // Pushed forward by the gap, as Temporal's "compatible" mode does.
    const gap = wallTimeToMs(parseWallTime("2026-03-08T02:30:00"), "America/New_York");
    check("a skipped time is flagged as a gap", gap.resolution === "gap", gap.resolution);
    check("and pushed forward by the gap's length", new Date(gap.ms).toISOString() === "2026-03-08T07:30:00.000Z", new Date(gap.ms).toISOString());

    // Fall back: 01:00-01:59 on 1 November 2026 happened twice.
    const overlap = wallTimeToMs(parseWallTime("2026-11-01T01:30:00"), "America/New_York");
    check("a repeated time is flagged as an overlap", overlap.resolution === "overlap", overlap.resolution);
    check("the earlier instant is chosen", new Date(overlap.ms).toISOString() === "2026-11-01T05:30:00.000Z", new Date(overlap.ms).toISOString());
    check("and the later one is reported", overlap.later !== null && new Date(overlap.later).toISOString() === "2026-11-01T06:30:00.000Z", String(overlap.later));

    // Lord Howe Island moves its clocks by thirty minutes, which breaks any
    // code that assumes a DST shift is a whole hour.
    const lordHowe = wallTimeToMs(parseWallTime("2026-10-04T02:15:00"), "Australia/Lord_Howe");
    check("a half-hour DST gap is found", lordHowe.resolution === "gap" && new Date(lordHowe.ms).toISOString() === "2026-10-03T15:45:00.000Z", `${lordHowe.resolution} ${new Date(lordHowe.ms).toISOString()}`);

    // Local mean time carries seconds; the ICU offset label rounds them away,
    // which is why the offset is derived from the wall clock instead.
    const lmt = zoneOffsetMs(Date.UTC(1900, 0, 1), "Asia/Ho_Chi_Minh");
    check("pre-1906 Saigon is +07:06:30, seconds included", lmt === 25_590_000, String(lmt));

    // Round trip: every instant's wall time must lead back to that instant, or
    // to the other half of an overlap. Sampled every 7h13m across 2025-2027 in
    // zones with whole-hour, half-hour and no DST.
    const ROUND_TRIP_ZONES = ["UTC", "Asia/Ho_Chi_Minh", "America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata"];
    let mismatch: string | null = null;
    for (const zone of ROUND_TRIP_ZONES) {
      for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2027, 11, 31) && mismatch === null; ms += 25_980_000) {
        const back = wallTimeToMs(wallTimeAt(ms, zone), zone);
        if (back.ms !== ms && back.later !== ms) mismatch = `${zone} ${new Date(ms).toISOString()} -> ${new Date(back.ms).toISOString()}`;
      }
    }
    check("wall time round-trips in six zones across three years", mismatch === null, mismatch ?? "");

    check("the epoch box accepts plain and fractional numbers", ["1758086602", "-1", "1758086602.5", " 42 "].every(isEpochText));
    check("and nothing else", !["", "2026-09-17", "1e9", "0x10", "1.2.3", "12 34"].some(isEpochText));
  }

  console.log("\n-- lunar calendar --");
  {
    // Tết, as printed in Vietnam. Independent of this code: public record.
    const TET: readonly [number, string][] = [
      [1945, "13/2/1945"], [1954, "3/2/1954"], [1968, "29/1/1968"], [1975, "11/2/1975"],
      [1985, "21/1/1985"], [2000, "5/2/2000"], [2004, "22/1/2004"], [2007, "17/2/2007"],
      [2020, "25/1/2020"], [2021, "12/2/2021"], [2022, "1/2/2022"], [2023, "22/1/2023"],
      [2024, "10/2/2024"], [2025, "29/1/2025"], [2026, "17/2/2026"], [2027, "6/2/2027"],
      [2030, "2/2/2030"], [2033, "31/1/2033"], [2034, "19/2/2034"],
    ];
    for (const [year, expected] of TET) {
      const actual = formatDmy(lunarToSolar({ day: 1, month: 1, year, leap: false }));
      check(`Tết ${year} is ${expected}`, actual === expected, actual);
    }

    const LEAPS: readonly [number, number | null][] = [
      [2004, 2], [2006, 7], [2009, 5], [2012, 4], [2014, 9], [2017, 6], [2020, 4],
      [2023, 2], [2024, null], [2025, 6], [2026, null], [2028, 5], [2031, 3], [2033, 11],
      [2148, 1],
    ];
    for (const [year, month] of LEAPS) {
      check(`${year} leap month is ${month ?? "none"}`, leapMonthOf(year) === month, String(leapMonthOf(year)));
    }

    // The article's own worked example: 2004 has a leap month 2, running
    // 21/3/2004 to 18/4/2004.
    const leap2004 = lunarMonthSpan(2, 2004, true);
    check("leap month 2 of 2004 starts 21/3/2004", formatDmy(solarFromJd(leap2004.start)) === "21/3/2004", formatDmy(solarFromJd(leap2004.start)));
    check("and ends 18/4/2004", formatDmy(solarFromJd(leap2004.start + leap2004.length - 1)) === "18/4/2004");

    // The meridian is the whole difference between the two calendars. Tết 1968
    // came a day earlier in Hanoi, and in 1985 the two were a month apart.
    check("29/1/1968 is Tết at UTC+7", JSON.stringify(solarToLunarAt({ day: 29, month: 1, year: 1968 }, 7)) === '{"day":1,"month":1,"year":1968,"leap":false}');
    check("and still the old year at UTC+8", JSON.stringify(solarToLunarAt({ day: 29, month: 1, year: 1968 }, 8)) === '{"day":30,"month":12,"year":1967,"leap":false}');
    check("21/1/1985 is Tết at UTC+7 but month 12 at UTC+8", solarToLunarAt({ day: 21, month: 1, year: 1985 }, 7).month === 1 && solarToLunarAt({ day: 21, month: 1, year: 1985 }, 8).month === 12);

    // The era switch: 1967 is computed at UTC+8, so its last month has to stop
    // where Tết 1968 (UTC+7) begins rather than overlap it by a day.
    const last1967 = lunarMonthSpan(12, 1967, false);
    check("month 12 of 1967 ends the day before Tết 1968", formatDmy(solarFromJd(last1967.start + last1967.length)) === "29/1/1968", formatDmy(solarFromJd(last1967.start + last1967.length)));
    check("pre-1968 dates use the calendar then in use", eraOffset(1967) === 8 && eraOffset(1968) === 7);
    check("28/1/1968 is the last day of 1967", formatLunar(solarToLunar({ day: 28, month: 1, year: 1968 })) === "29/12/1967", formatLunar(solarToLunar({ day: 28, month: 1, year: 1968 })));

    // The sample code estimates the month once and steps back at most once;
    // on 7 May 2054 that lands a lunation late and reports day 0.
    const may2054 = solarToLunar({ day: 7, month: 5, year: 2054 });
    check("no date is ever day 0", may2054.day >= 1, formatLunar(may2054));

    check("the leap month after month 12 is numbered 12, not 0", leapMonthNumber(2) === 12, String(leapMonthNumber(2)));
    check("the leap month after month 11 is 11", leapMonthNumber(1) === 11);
    check("offset 4 after month 11 is a leap month 2", leapMonthNumber(4) === 2);

    const leap11 = lunarToSolar({ day: 1, month: 11, year: 2033, leap: true });
    check("leap month 11 of 2033 starts 22/12/2033", formatDmy(leap11) === "22/12/2033", formatDmy(leap11));
    check("2033's winter solstice month is the regular month 11", solarToLunar({ day: 21, month: 12, year: 2033 }).leap === false);

    // Every day of the supported range, both ways. Solar to lunar to solar has
    // to land on the same day, which is what makes the two boxes trustworthy
    // together — and it covers every month length and every leap month.
    let broken: string | null = null;
    for (let jd = jdFromSolar({ day: 1, month: 1, year: 1900 }); jd <= jdFromSolar({ day: 31, month: 12, year: 2199 }) && broken === null; jd += 1) {
      const lunar = solarToLunar(solarFromJd(jd));
      if (lunar.year < LUNAR_MIN_YEAR) continue;
      try {
        if (jdFromSolar(lunarToSolar(lunar)) !== jd) broken = `${formatDmy(solarFromJd(jd))} via ${formatLunar(lunar)}`;
      } catch (error) {
        broken = `${formatDmy(solarFromJd(jd))} via ${formatLunar(lunar)}: ${(error as Error).message}`;
      }
    }
    check("every day 1900-2199 round-trips", broken === null, broken ?? "");

    check("month lengths are only ever 29 or 30", Array.from({ length: 300 }, (_, i) => 1900 + i).every((y) => lunarYearMonths(y).every((r) => r.length === 29 || r.length === 30)));
    check("a leap year lists 13 months, a common year 12", lunarYearMonths(2025).length === 13 && lunarYearMonths(2026).length === 12);

    // Refusals, each by name. The sample code accepts all of these silently.
    const REFUSED: readonly [string, () => unknown, RegExp][] = [
      ["day 30 of a 29-day month", () => lunarToSolar({ day: 30, month: 2, year: 2025, leap: false }), /chỉ có 29 ngày/],
      ["a leap flag on the wrong month", () => lunarToSolar({ day: 1, month: 3, year: 2025, leap: true }), /Năm 2025 nhuận tháng 6, không phải tháng 3/],
      ["a leap flag in a common year", () => lunarToSolar({ day: 1, month: 1, year: 2024, leap: true }), /Năm 2024 không có tháng nhuận/],
      ["a leap 11 claimed for the year after it", () => lunarToSolar({ day: 1, month: 11, year: 2034, leap: true }), /Năm 2034 không có tháng nhuận/],
      ["month 13", () => lunarToSolar({ day: 1, month: 13, year: 2025, leap: false }), /Không có tháng 13 âm lịch/],
      ["day 0", () => lunarToSolar({ day: 0, month: 1, year: 2025, leap: false }), /không có ngày 0/],
      ["a year before the range", () => solarToLunar({ day: 1, month: 1, year: 1899 }), /1900/],
      ["a year after the range", () => lunarToSolar({ day: 1, month: 1, year: 2200, leap: false }), /2199/],
    ];
    for (const [name, attempt, message] of REFUSED) {
      let said = "";
      let typed = false;
      try { attempt(); } catch (error) { said = (error as Error).message; typed = error instanceof LunarError; }
      // The page shows only LunarError messages verbatim, so the type matters.
      check(`refuses ${name}`, message.test(said) && typed, said || "(accepted)");
    }

    // Can Chi, from the article and from well-known dates. Tết 2024 was a
    // Giáp Thìn day in a Bính Dần month of a Giáp Thìn year.
    const tet2024 = jdFromSolar({ day: 10, month: 2, year: 2024 });
    check("Tết 2024 was a Giáp Thìn day", dayCanChi(tet2024) === "Giáp Thìn", dayCanChi(tet2024));
    check("in a Bính Dần month", monthCanChi(1, 2024) === "Bính Dần", monthCanChi(1, 2024));
    check("of a Giáp Thìn year", yearCanChi(2024) === "Giáp Thìn");
    check("and it was a Saturday", WEEKDAYS_VI[weekdayOfJd(tet2024)] === "Thứ Bảy", WEEKDAYS_VI[weekdayOfJd(tet2024)]);
    check("month 3 of 2004 is Mậu Thìn (the article's example)", monthCanChi(3, 2004) === "Mậu Thìn", monthCanChi(3, 2004));
    check("leap month 2 of 2004 is Đinh Mão nhuận", monthCanChi(2, 2004, true) === "Đinh Mão nhuận");
    check("years: Mậu Thân 1968, Ất Tỵ 2025, Bính Ngọ 2026", yearCanChi(1968) === "Mậu Thân" && yearCanChi(2025) === "Ất Tỵ" && yearCanChi(2026) === "Bính Ngọ");
    check("spelled the way it is said", spellLunar({ day: 7, month: 8, year: 2026, leap: false }) === "Mùng 7 tháng Tám năm Bính Ngọ", spellLunar({ day: 7, month: 8, year: 2026, leap: false }));
    check("with Giêng, Chạp and nhuận", spellLunar({ day: 1, month: 1, year: 2025, leap: false }) === "Mùng 1 tháng Giêng năm Ất Tỵ" && spellLunar({ day: 23, month: 12, year: 2025, leap: false }) === "Ngày 23 tháng Chạp năm Ất Tỵ" && spellLunar({ day: 15, month: 6, year: 2025, leap: true }) === "Ngày 15 tháng Sáu nhuận năm Ất Tỵ");
    check("17/9/2026 is 7/8 Bính Ngọ", formatLunar(solarToLunar({ day: 17, month: 9, year: 2026 })) === "7/8/2026", formatLunar(solarToLunar({ day: 17, month: 9, year: 2026 })));
  }

  console.log("\n-- json highlighting --");
  {
    const visible = (html: string) =>
      html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const kinds = (text: string) =>
      tokenizeJson(text)
        .filter((t) => t.kind !== "space")
        .map((t) => `${t.kind}:${text.slice(t.start, t.end)}`)
        .join(" ");

    // The layer and the textarea must hold the same characters, or the caret
    // drifts off the text it edits. Fuzzed over JSON-ish noise, valid or not.
    const ALPHABET = ['{', '}', '[', ']', ',', ':', '"', '\\', ' ', '\n', '\t', 'a', 'e', '1', '-', '.', 'n', 't', '<', '&', '/', 'ệ', '😀'];
    let drift: string | null = null;
    let gaps: string | null = null;
    for (let n = 0; n < 3000 && drift === null && gaps === null; n += 1) {
      let text = "";
      const length = 1 + ((n * 7919) % 60);
      for (let i = 0; i < length; i += 1) text += ALPHABET[(n * 31 + i * i * 17 + i) % ALPHABET.length];
      const tokens = tokenizeJson(text);
      if (tokens.some((t, i) => t.end <= t.start || (i > 0 && t.start !== tokens[i - 1]!.end)) || tokens.at(-1)?.end !== text.length) {
        gaps = JSON.stringify(text);
      }
      const expected = text.endsWith("\n") ? `${text} ` : text;
      if (visible(highlightJson(text)) !== expected) drift = JSON.stringify(text);
    }
    check("tokens tile every input exactly, with no gap or overlap", gaps === null, gaps ?? "");
    check("the layer shows exactly the textarea's characters", drift === null, drift ?? "");

    check("keys and string values are told apart", kinds('{"a": "b"}') === 'punct:{ key:"a" punct:: string:"b" punct:}', kinds('{"a": "b"}'));
    check("a key may have its colon on the next line", kinds('{"a"\n  : 1}').includes('key:"a"'));
    check("array strings are never keys", !kinds('["a", "b"]').includes("key"));
    check("an escaped quote does not end a string", kinds('"say \\"hi\\""') === 'string:"say \\"hi\\""', kinds('"say \\"hi\\""'));
    check("numbers, booleans and null", kinds("[-1.5e3, 0, true, false, null]") === "punct:[ number:-1.5e3 punct:, number:0 punct:, boolean:true punct:, boolean:false punct:, null:null punct:]", kinds("[-1.5e3, 0, true, false, null]"));
    check("words JSON does not know are invalid", kinds("[undefined, NaN, True]") === "punct:[ invalid:undefined punct:, invalid:NaN punct:, invalid:True punct:]", kinds("[undefined, NaN, True]"));
    check("a comment is invalid", kinds('{} // no').includes("invalid:/"), kinds('{} // no'));
    check("an unclosed quote stops at the end of its line", kinds('{"a: 1,\n"b": 2}') === 'punct:{ invalid:"a: 1, key:"b" punct:: number:2 punct:}', kinds('{"a: 1,\n"b": 2}'));

    const hostile = highlightJson('{"x": "<script>alert(1)</script> & more"}');
    check("markup in the input is escaped", !hostile.includes("<script") && hostile.includes("&lt;script&gt;") && hostile.includes("&amp;"), hostile);

    // The mark goes on the character the error message names.
    const broken = '{"a": 1,}';
    const at = findErrorIndex(broken);
    check("the error mark lands on the offending character", at === 8 && highlightJson(broken, at).includes('<mark class="tok-error">}</mark>'), highlightJson(broken, at));
    const truncated = '{"a": [1, 2';
    check("an input that ends early gets an end marker", highlightJson(truncated, findErrorIndex(truncated)).endsWith('<mark class="tok-error tok-error--end"> </mark>'));
    check("a mark on a newline keeps the line break", visible(highlightJson("[1\n,]", 2)) === "[1 \n,]", JSON.stringify(visible(highlightJson("[1\n,]", 2))));
    check("no mark when there is no error", !highlightJson('{"a": 1}').includes("<mark"));
    check("a trailing newline is kept visible", highlightJson("{}\n").endsWith("\n "));

    // Budget check, printed rather than asserted: timing depends on the machine.
    const big = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `item ${i}`, ok: i % 2 === 0, v: null })), null, 2).slice(0, HIGHLIGHT_LIMIT);
    const t0 = performance.now();
    highlightJson(big);
    console.log(`     ${big.length.toLocaleString("en-US")} characters highlighted in ${(performance.now() - t0).toFixed(1)} ms`);
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
