/**
 * Checks for the byte and throughput converter, `src/lib/bytes.ts`: exact
 * arithmetic, the units as the standards define them, numbers and units as
 * people type them, and the transfer sums the page exists for.
 */

import {
  EFFICIENCIES,
  approximateDuration,
  formatDuration,
  formatNumber,
  groupDigits,
  inUnit,
  parseDuration,
  parseNumber,
  parseQuick,
  parseUnit,
  rateFor,
  rateUnit,
  ratio,
  sizeFor,
  sizeUnit,
  toDecimal,
  transferTime,
  type Ratio,
} from "../src/lib/bytes";
import type { Check } from "./verify-tools";

const same = (a: Ratio | null, n: bigint, d = 1n): boolean => a !== null && a.n === n && a.d === d;
const decimal = (value: Ratio, digits = 15): string => toDecimal(value, digits).text;

export async function runByteChecks(check: Check): Promise<void> {
  console.log("\n-- bytes: units, exactly --");
  {
    check("1 GiB is exactly 1.073741824 GB", decimal(inUnit(ratio(sizeUnit("GiB").bits), sizeUnit("GB"))) === "1.073741824");
    check("1 TiB is exactly 1,099.511627776 GB", decimal(inUnit(ratio(sizeUnit("TiB").bits), sizeUnit("GB"))) === "1099.511627776");
    check("1 TB is 931.322574615… GiB", decimal(inUnit(ratio(sizeUnit("TB").bits), sizeUnit("GiB")), 12) === "931.322574615");
    check("1 TB is 0.909494701773 TiB", decimal(inUnit(ratio(sizeUnit("TB").bits), sizeUnit("TiB")), 12) === "0.909494701773");
    check("1 MiB is 1,048,576 bytes", decimal(inUnit(ratio(sizeUnit("MiB").bits), sizeUnit("B"))) === "1048576");
    check("1 byte is 8 bits", decimal(inUnit(ratio(sizeUnit("B").bits), sizeUnit("bit"))) === "8");
    check("100 Mbit/s is 12.5 MB/s", decimal(inUnit(ratio(100n * rateUnit("Mbit/s").bits), rateUnit("MB/s"))) === "12.5");
    check("1 Gbit/s is 125 MB/s and 119.209289551 MiB/s", decimal(inUnit(ratio(rateUnit("Gbit/s").bits), rateUnit("MB/s"))) === "125" && decimal(inUnit(ratio(rateUnit("Gbit/s").bits), rateUnit("MiB/s")), 12) === "119.209289551");
    check("1 MB/s is 8 Mbit/s", decimal(inUnit(ratio(rateUnit("MB/s").bits), rateUnit("Mbit/s"))) === "8");
  }

  console.log("\n-- bytes: the sum the page exists for --");
  {
    const quick = parseQuick("5 TB @ 1 Gbps", "en");
    const ok = !("error" in quick) && quick.kind === "time";
    const seconds = ok ? transferTime(quick.size.value, quick.rate.value) : ratio(0n);
    check("5 TB at 1 Gbps takes exactly 40,000 seconds", same(seconds, 40_000n), decimal(seconds));
    check("said as 11 h 6 min 40 s, about 11.1 hours", formatDuration(seconds, "en") === "11 h 6 min 40 s" && approximateDuration(seconds, "en") === "≈ 11.1 hours", `${formatDuration(seconds, "en")} / ${approximateDuration(seconds, "en")}`);
    check("and in Vietnamese: 11 giờ 6 phút 40 giây, khoảng 11,1 giờ", formatDuration(seconds, "vi") === "11 giờ 6 phút 40 giây" && approximateDuration(seconds, "vi") === "≈ 11,1 giờ", `${formatDuration(seconds, "vi")} / ${approximateDuration(seconds, "vi")}`);
    const tcp = EFFICIENCIES.find((e) => e.id === "tcp")!;
    const real = transferTime(ratio(8n * 1000n ** 4n * 5n), ratio(1000n ** 3n), tcp.share);
    check("over TCP and Ethernet, 1448 data bytes in each 1538: 11 h 48 min 6 s", formatDuration(real, "en") === "11 h 48 min 6 s", formatDuration(real, "en"));
    check("1 TB in 2 hours needs 1.11 Gbit/s", decimal(inUnit(rateFor(ratio(8n * 1000n ** 4n), ratio(7200n)), rateUnit("Gbit/s")), 3) === "1.11");
    check("100 Mbit/s for a day moves 1.08 TB", decimal(inUnit(sizeFor(ratio(100_000_000n), ratio(86_400n)), sizeUnit("TB"))) === "1.08");
    check("under a minute, milliseconds: 1 GB at 1 Gbit/s is 8 s", formatDuration(transferTime(ratio(8_000_000_000n), ratio(1_000_000_000n)), "en") === "8 s");
    check("1 MiB at 1 Gbit/s is 8.39 ms", formatDuration(transferTime(ratio(8n * 1024n * 1024n), ratio(1_000_000_000n)), "en") === "≈ 8.39 ms", formatDuration(transferTime(ratio(8n * 1024n * 1024n), ratio(1_000_000_000n)), "en"));
    check("days when it takes days: 100 TB at 100 Mbit/s", formatDuration(transferTime(ratio(8n * 1000n ** 4n * 100n), ratio(100_000_000n)), "en") === "92 d 14 h 13 min 20 s");
  }

  console.log("\n-- bytes: numbers as people type them --");
  {
    const NUMBERS: readonly [string, "en" | "vi", bigint | null, bigint?][] = [
      ["5", "en", 5n],
      ["1.5", "en", 3n, 2n],
      ["1,5", "en", 3n, 2n],
      ["1,5", "vi", 3n, 2n],
      ["1,000", "en", 1000n],
      ["1,000", "vi", 1n],
      ["1.000", "vi", 1000n],
      ["1.000", "en", 1n],
      ["1 000", "vi", 1000n],
      ["1,000,000", "en", 1_000_000n],
      ["1.000.000", "vi", 1_000_000n],
      ["1,234.5", "vi", 2469n, 2n],
      ["1.234,5", "en", 2469n, 2n],
      ["2.5e3", "en", 2500n],
      ["1e-3", "en", 1n, 1000n],
      [".5", "en", 1n, 2n],
      ["0,750", "en", 3n, 4n],
      ["1,2,3", "en", null],
      ["12,34,567", "en", null],
      ["abc", "en", null],
      ["", "en", null],
    ];
    for (const [text, lang, n, d = 1n] of NUMBERS) {
      const got = parseNumber(text, lang);
      check(`${JSON.stringify(text)} in ${lang} → ${n === null ? "refused" : d === 1n ? n : `${n}/${d}`}`, n === null ? got === null : same(got, n, d), got === null ? "null" : `${got.n}/${got.d}`);
    }
    check("grouped as each language writes it", groupDigits("1234567.5", "en") === "1,234,567.5" && groupDigits("1234567.5", "vi") === "1.234.567,5");
    check("rounded numbers carry ≈", formatNumber(ratio(1n, 3n), "en", 4) === "≈ 0.3333" && formatNumber(ratio(5n, 2n), "vi") === "2,5");
  }

  console.log("\n-- bytes: units as people write them --");
  {
    const UNITS: readonly [string, string | null, boolean][] = [
      ["GB", "GB", false],
      ["GiB", "GiB", false],
      ["Gb", "Gbit", false],
      ["Gbit", "Gbit", false],
      ["gb", "GB", true],
      ["Mbps", "Mbit/s", false],
      ["mbps", "Mbit/s", false],
      ["Mb/s", "Mbit/s", false],
      ["MB/s", "MB/s", false],
      ["MBps", "MB/s", false],
      ["MiB/s", "MiB/s", false],
      ["KB", "kB", true],
      ["kB", "kB", false],
      ["gigabytes", "GB", false],
      ["megabits", "Mbit", false],
      ["Mo", "MB", false],
      ["bytes", "B", false],
      ["GHz", null, false],
      ["", null, false],
    ];
    for (const [text, symbol, noted] of UNITS) {
      const got = parseUnit(text);
      check(
        `${JSON.stringify(text)} → ${symbol ?? "not a unit"}${noted ? ", with a note" : ""}`,
        symbol === null ? got === null : got !== null && got.symbol === symbol && (got.note !== null) === noted,
        got === null ? "null" : `${got.symbol}${got.note ? " (noted)" : ""}`,
      );
    }
    check("durations: 2h 30min, 90 min, 1,5 giờ, 3 ngày, 1:30:00", same(parseDuration("2h 30min"), 9000n) && same(parseDuration("90 min"), 5400n) && same(parseDuration("1,5 giờ"), 5400n) && same(parseDuration("3 ngày"), 259_200n) && same(parseDuration("1:30:00"), 5400n));
    check("a bare number is not a duration", parseDuration("90") === null);
  }

  console.log("\n-- bytes: one-line questions --");
  {
    const ASKS: readonly [string, string][] = [
      ["5 TB @ 1 Gbps", "time"],
      ["5TB@1Gbps", "time"],
      ["5 TB over 1 Gbps", "time"],
      ["1 Gbps, 5 TB", "time"],
      ["1,5 TB qua 300 Mbps", "time"],
      ["1 TB in 2 h", "rate-needed"],
      ["4 GB trong 10 phút", "rate-needed"],
      ["100 Mbps for 1 day", "size-moved"],
      ["300 Mbps trong 1 ngày", "size-moved"],
      ["5 TB to GiB", "size"],
      ["5 TB sang GiB", "size"],
      ["1 Gbps in MB/s", "rate"],
      ["500gb", "size"],
      ["100 mbps", "rate"],
      ["5 TB to MB/s", "error"],
      ["5 TB @ 1 Gbps @ 2 h", "error"],
      ["2 h", "error"],
      ["hello", "error"],
    ];
    for (const [text, kind] of ASKS) {
      const got = parseQuick(text, "vi");
      const gotKind = "error" in got ? "error" : got.kind;
      check(`${JSON.stringify(text)} → ${kind}`, gotKind === kind, gotKind);
    }
    const target = parseQuick("5 TB to GiB", "en");
    check("5 TB to GiB converts to GiB", !("error" in target) && target.kind === "size" && target.target?.symbol === "GiB");
    const errors = ASKS.map(([text]) => parseQuick(text, "en")).filter((got): got is { error: { en: string; vi: string } } => "error" in got);
    check("every refusal says why, in both languages", errors.every((got) => got.error.en !== "" && got.error.vi !== "" && got.error.en !== got.error.vi));
  }
}
