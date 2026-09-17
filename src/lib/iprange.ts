/**
 * Address-range algebra for IPv4 and IPv6 alike: range to CIDR, aggregation,
 * supernets, splitting.
 *
 * Everything works on `bigint` with the family's bit width as a parameter, so
 * there is one implementation of each algorithm rather than one per family.
 * IPv4 values fit a number, but a second copy of every algorithm would be the
 * place the two families quietly start to disagree.
 */

import { formatIpv4, maskFromPrefix, parseCidr, parseIpv4, prefixFromMask } from "./ipv4";
import { formatIpv6, parseIpv6, parseIpv6Cidr } from "./ipv6";

export type Family = 4 | 6;

export const FAMILY_BITS: Record<Family, number> = { 4: 32, 6: 128 };

export interface Cidr {
  family: Family;
  network: bigint;
  prefix: number;
}

export interface IpRange {
  family: Family;
  start: bigint;
  end: bigint;
}

const bitsOf = (family: Family) => BigInt(FAMILY_BITS[family]);

export function allOnes(family: Family): bigint {
  return (1n << bitsOf(family)) - 1n;
}

export function prefixMask(family: Family, prefix: number): bigint {
  const bits = FAMILY_BITS[family];
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`An IPv${family} prefix must be between 0 and ${bits}, not ${prefix}.`);
  }
  return prefix === 0 ? 0n : (allOnes(family) << BigInt(bits - prefix)) & allOnes(family);
}

export function blockSize(family: Family, prefix: number): bigint {
  return 1n << BigInt(FAMILY_BITS[family] - prefix);
}

export function formatAddress(family: Family, value: bigint): string {
  return family === 4 ? formatIpv4(Number(value)) : formatIpv6(value);
}

export function formatCidrText(cidr: Cidr): string {
  return `${formatAddress(cidr.family, cidr.network)}/${cidr.prefix}`;
}

export function familyOf(text: string): Family {
  return text.includes(":") ? 6 : 4;
}

export function parseAddress(text: string): { family: Family; value: bigint } {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("An address is missing.");
  const family = familyOf(trimmed);
  if (family === 4) return { family, value: BigInt(parseIpv4(trimmed)) };
  return { family, value: parseIpv6(trimmed).value };
}

export interface ParsedCidr extends Cidr {
  /** The address as written, before host bits were cleared. */
  address: bigint;
  /** True when the text had host bits set, e.g. 10.0.0.5/24. */
  hostBits: boolean;
  prefixAssumed: boolean;
}

/**
 * One prefix in any accepted form: `10.0.0.0/24`, `10.0.0.0/255.255.255.0`,
 * `10.0.0.0 255.255.255.0`, `2001:db8::/32`, or a bare address (a single-address
 * prefix). Host bits are cleared and reported rather than refused, because
 * `10.0.0.5/24` in a list almost always means "the /24 that holds this host".
 */
export function parsePrefixed(text: string): ParsedCidr {
  const trimmed = text.trim();
  if (familyOf(trimmed) === 6) {
    const input = parseIpv6Cidr(trimmed);
    const network = input.address & prefixMask(6, input.prefix);
    return {
      family: 6,
      network,
      prefix: input.prefix,
      address: input.address,
      hostBits: network !== input.address,
      prefixAssumed: input.prefixAssumed,
    };
  }
  const input = parseCidr(trimmed);
  const address = BigInt(input.address);
  const network = BigInt((input.address & maskFromPrefix(input.prefix)) >>> 0);
  return {
    family: 4,
    network,
    prefix: input.prefix,
    address,
    hostBits: network !== address,
    prefixAssumed: input.prefixAssumed,
  };
}

export function cidrToRange(cidr: Cidr): IpRange {
  const size = blockSize(cidr.family, cidr.prefix);
  return { family: cidr.family, start: cidr.network, end: cidr.network + size - 1n };
}

export function rangeSize(range: IpRange): bigint {
  return range.end - range.start + 1n;
}

function trailingZeros(value: bigint, bits: number): number {
  if (value === 0n) return bits;
  let count = 0;
  while (((value >> BigInt(count)) & 1n) === 0n) count += 1;
  return count;
}

/** floor(log2(value)) for value >= 1. */
function log2Floor(value: bigint): number {
  return value.toString(2).length - 1;
}

/**
 * The fewest CIDR blocks that cover exactly `start`..`end`.
 *
 * Greedy from the low end: each block is as large as the start address's
 * alignment allows without running past the end. That is provably minimal —
 * any cover must split at the same alignment boundaries — and the suite
 * checks it against brute force.
 */
export function rangeToCidrs(range: IpRange): Cidr[] {
  const { family } = range;
  const bits = FAMILY_BITS[family];
  if (range.start > range.end) throw new Error("The range ends before it starts.");

  const out: Cidr[] = [];
  let start = range.start;
  while (start <= range.end) {
    const aligned = trailingZeros(start, bits);
    const fits = log2Floor(range.end - start + 1n);
    const hostBits = Math.min(aligned, fits);
    out.push({ family, network: start, prefix: bits - hostBits });
    start += 1n << BigInt(hostBits);
  }
  return out;
}

const RANGE_SEPARATOR = /\s*(?:\s-\s|\s*[–—]\s*|\s+to\s+|-(?=[\d.]+$))\s*/i;

/**
 * `10.0.0.5 - 10.0.3.200`, `10.0.0.5–10.0.3.200`, `2001:db8::1 to 2001:db8::ff`,
 * a CIDR (its own range), or a single address. A bare hyphen with no spaces is
 * accepted for IPv4 only; in IPv6 text a hyphen is too easy to misread.
 */
export function parseRange(text: string): IpRange {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Enter a range.");

  const parts = trimmed.split(RANGE_SEPARATOR);
  if (parts.length > 2) throw new Error(`"${trimmed}" has more than two ends.`);

  if (parts.length === 1) {
    const cidr = parsePrefixed(trimmed);
    return cidrToRange(cidr);
  }

  const start = parseAddress(parts[0]!);
  const end = parseAddress(parts[1]!);
  if (start.family !== end.family) {
    throw new Error(`"${trimmed}" starts in IPv${start.family} and ends in IPv${end.family}.`);
  }
  if (start.value > end.value) {
    throw new Error(
      `${formatAddress(start.family, start.value)} comes after ${formatAddress(end.family, end.value)}; write the lower address first.`,
    );
  }
  return { family: start.family, start: start.value, end: end.value };
}

/** Sorted, with overlapping and adjacent ranges joined. One family per call. */
export function mergeRanges(ranges: readonly IpRange[]): IpRange[] {
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: IpRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + 1n) {
      if (range.end > last.end) last.end = range.end;
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/** The fewest prefixes covering exactly the same addresses as `cidrs`. */
export function aggregate(cidrs: readonly Cidr[]): Cidr[] {
  return mergeRanges(cidrs.map(cidrToRange)).flatMap(rangeToCidrs);
}

export interface Supernet {
  cidr: Cidr;
  /** Addresses the supernet covers that none of the inputs did. */
  extra: bigint;
}

/** The single smallest prefix that contains every input. */
export function supernet(cidrs: readonly Cidr[]): Supernet {
  if (cidrs.length === 0) throw new Error("There is nothing to summarise.");
  const family = cidrs[0]!.family;
  const ranges = cidrs.map(cidrToRange);
  const low = ranges.reduce((min, r) => (r.start < min ? r.start : min), ranges[0]!.start);
  const high = ranges.reduce((max, r) => (r.end > max ? r.end : max), ranges[0]!.end);

  const bits = FAMILY_BITS[family];
  const differing = low === high ? 0 : (low ^ high).toString(2).length;
  const prefix = bits - differing;
  const cidr = { family, network: low & prefixMask(family, prefix), prefix };

  const covered = mergeRanges(ranges).reduce((sum, r) => sum + rangeSize(r), 0n);
  return { cidr, extra: blockSize(family, prefix) - covered };
}

function isDottedMask(token: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(token)) return false;
  try {
    prefixFromMask(parseIpv4(token));
    return true;
  } catch {
    return false;
  }
}

export interface ListEntry {
  line: number;
  text: string;
  cidr: ParsedCidr;
}

export interface ListProblem {
  line: number;
  text: string;
  message: string;
}

export interface ParsedList {
  entries: ListEntry[];
  problems: ListProblem[];
}

/**
 * A list of prefixes, one per line or separated by commas, semicolons or
 * whitespace. `#` starts a comment. Bad entries are collected with their line
 * number instead of stopping the whole list.
 */
export function parseCidrList(text: string, limit = 10_000): ParsedList {
  const entries: ListEntry[] = [];
  const problems: ListProblem[] = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index]!.replace(/#.*/, "");
    // Commas and semicolons always separate entries. Within a piece,
    // `10.0.0.0 255.255.255.0` is one entry written with a space: only a token
    // that is a whole, valid mask joins its predecessor — checking just the
    // first octet would swallow `192.168.0.0/16` after a space.
    const items: string[] = [];
    for (const piece of content.split(/[,;]/)) {
      const pieceStart = items.length;
      for (const token of piece.split(/\s+/).filter((t) => t.length > 0)) {
        const previous = items.length > pieceStart ? items[items.length - 1] : undefined;
        if (previous !== undefined && !/[/:\s]/.test(previous) && isDottedMask(token)) {
          items[items.length - 1] = `${previous} ${token}`;
        } else {
          items.push(token);
        }
      }
    }
    for (const item of items) {
      if (entries.length >= limit) {
        problems.push({ line: index + 1, text: item, message: `Only the first ${limit.toLocaleString("en-US")} entries are read.` });
        return { entries, problems };
      }
      try {
        entries.push({ line: index + 1, text: item, cidr: parsePrefixed(item) });
      } catch (error) {
        problems.push({ line: index + 1, text: item, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { entries, problems };
}

/** Rows a split page draws, and rows its copy and CSV export carry. */
export const SPLIT_TABLE_LIMIT = 1024;
export const SPLIT_EXPORT_LIMIT = 65536;

export interface SplitResult {
  prefix: number;
  /** How many subnets the parent splits into. */
  count: bigint;
  subnets: Cidr[];
  /** True when `subnets` holds only the first `limit` of them. */
  truncated: boolean;
}

/** `parent` cut into /`prefix` blocks, listing at most `limit` of them. */
export function splitCidr(parent: Cidr, prefix: number, limit: number): SplitResult {
  const bits = FAMILY_BITS[parent.family];
  if (!Number.isInteger(prefix) || prefix < parent.prefix || prefix > bits) {
    throw new Error(`A /${parent.prefix} can only be split into prefixes from /${parent.prefix} to /${bits}.`);
  }
  const count = 1n << BigInt(prefix - parent.prefix);
  const step = blockSize(parent.family, prefix);
  const shown = count < BigInt(limit) ? Number(count) : limit;
  const subnets: Cidr[] = [];
  for (let i = 0; i < shown; i += 1) {
    subnets.push({ family: parent.family, network: parent.network + BigInt(i) * step, prefix });
  }
  return { prefix, count, subnets, truncated: BigInt(shown) < count };
}

/**
 * The prefix that splits `parent` into at least `pieces` equal subnets. A
 * count that is not a power of two rounds up, and the caller says so.
 */
export function prefixForPieces(parent: Cidr, pieces: number): number {
  if (!Number.isInteger(pieces) || pieces < 1) throw new Error("Split into at least one subnet.");
  const extra = pieces === 1 ? 0 : (BigInt(pieces) - 1n).toString(2).length;
  const prefix = parent.prefix + extra;
  const bits = FAMILY_BITS[parent.family];
  if (prefix > bits) {
    throw new Error(
      `A /${parent.prefix} holds at most ${formatBig(blockSize(parent.family, parent.prefix))} single-address subnets, fewer than ${pieces.toLocaleString("en-US")}.`,
    );
  }
  return prefix;
}

export function formatBig(value: bigint): string {
  return value.toLocaleString("en-US");
}

export type BlockStyle = "cidr" | "mask" | "wildcard";

/**
 * One block as a line of config. Masks and wildcards are IPv4 notions; IPv6
 * blocks are always written as prefixes, whatever the style.
 */
export function formatBlock(cidr: Cidr, style: BlockStyle): string {
  if (cidr.family === 6 || style === "cidr") return formatCidrText(cidr);
  const mask = Number(prefixMask(4, cidr.prefix));
  const shown = style === "mask" ? mask : ~mask >>> 0;
  return `${formatAddress(4, cidr.network)} ${formatIpv4(shown)}`;
}

/**
 * Hosts a subnet can number. IPv4 loses its network and broadcast addresses
 * except on /31 (RFC 3021) and /32; IPv6 has no broadcast, so every address
 * counts.
 */
export function usableHosts(cidr: Cidr): bigint {
  const size = blockSize(cidr.family, cidr.prefix);
  if (cidr.family === 6 || cidr.prefix >= 31) return size;
  return size - 2n;
}

export interface Redundancy {
  /** Entries identical to an earlier one. */
  duplicates: ListEntry[];
  /** Entries wholly inside another, with the entry that holds them. */
  contained: { entry: ListEntry; within: ListEntry }[];
}

/** What aggregation will silently absorb, so the page can say so. */
export function findRedundant(entries: readonly ListEntry[]): Redundancy {
  const duplicates: ListEntry[] = [];
  const contained: { entry: ListEntry; within: ListEntry }[] = [];

  for (const family of [4, 6] as const) {
    const items = entries
      .filter((e) => e.cidr.family === family)
      .map((e) => ({ entry: e, range: cidrToRange(e.cidr) }))
      // Wider first at the same start, so a container is always seen first.
      .sort((a, b) =>
        a.range.start !== b.range.start
          ? a.range.start < b.range.start ? -1 : 1
          : a.range.end > b.range.end ? -1 : a.range.end < b.range.end ? 1 : a.entry.line - b.entry.line,
      );

    let widest: (typeof items)[number] | undefined;
    for (const item of items) {
      if (widest && item.range.end <= widest.range.end) {
        const same = item.range.start === widest.range.start && item.range.end === widest.range.end;
        if (same) duplicates.push(item.entry);
        else contained.push({ entry: item.entry, within: widest.entry });
      } else {
        widest = item;
      }
    }
  }
  return { duplicates, contained };
}
