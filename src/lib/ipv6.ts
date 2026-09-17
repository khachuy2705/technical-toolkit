/**
 * IPv6 address parsing, formatting and classification.
 *
 * Addresses are 128-bit `bigint`s. JavaScript numbers stop being exact at 53
 * bits, so there is no shortcut here the way `>>> 0` works for IPv4.
 */

import { formatIpv4, parseIpv4 } from "./ipv4";

export const IPV6_BITS = 128;
export const IPV6_MAX = (1n << 128n) - 1n;

export interface Ipv6Parsed {
  value: bigint;
  /** A `%eth0` suffix that was stripped: it names an interface, not part of the address. */
  zone: string | null;
}

const GROUP = /^[0-9a-f]{1,4}$/i;

/**
 * Accepts every RFC 4291 text form: full, `::`-compressed, with a trailing
 * dotted IPv4, in brackets, and with a zone suffix. Each refusal names the
 * part that is wrong.
 */
export function parseIpv6(text: string): Ipv6Parsed {
  let body = text.trim();
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);

  let zone: string | null = null;
  const percent = body.indexOf("%");
  if (percent !== -1) {
    zone = body.slice(percent + 1);
    body = body.slice(0, percent);
    if (zone.length === 0) throw new Error("A % must be followed by a zone name, such as %eth0.");
  }

  if (body.length === 0) throw new Error("Enter an IPv6 address.");
  if (!body.includes(":")) throw new Error(`"${body}" is not an IPv6 address — it has no colons.`);

  const doubles = body.split("::").length - 1;
  if (doubles > 1) throw new Error(`"${body}" uses "::" more than once, so it is ambiguous.`);
  if (/:::/.test(body)) throw new Error(`"${body}" has three colons in a row.`);

  const parsePart = (part: string): string[] => (part === "" ? [] : part.split(":"));
  let head: string[];
  let tail: string[];
  if (doubles === 1) {
    const [left, right] = body.split("::") as [string, string];
    head = parsePart(left);
    tail = parsePart(right);
  } else {
    head = body.split(":");
    tail = [];
  }

  // A trailing dotted quad stands for the last two groups.
  const groups = (list: string[], allowIpv4: boolean): bigint[] => {
    const out: bigint[] = [];
    list.forEach((group, i) => {
      if (allowIpv4 && i === list.length - 1 && group.includes(".")) {
        const v4 = BigInt(parseIpv4(group));
        out.push(v4 >> 16n, v4 & 0xffffn);
        return;
      }
      if (group === "") throw new Error(`"${body}" has an empty group — a single colon cannot start or end an address.`);
      if (!GROUP.test(group)) throw new Error(`"${group}" is not a group of one to four hex digits.`);
      out.push(BigInt(`0x${group}`));
    });
    return out;
  };

  const left = groups(head, doubles === 0);
  const right = groups(tail, true);
  const count = left.length + right.length;

  if (doubles === 0 && count !== 8) {
    throw new Error(`"${body}" has ${count} groups; a full IPv6 address has 8.`);
  }
  if (doubles === 1 && count > 7) {
    throw new Error(`"${body}" has ${count} groups around "::", which leaves nothing for "::" to stand for.`);
  }

  const all = [...left, ...Array<bigint>(8 - count).fill(0n), ...right];
  const value = all.reduce((acc, group) => (acc << 16n) | group, 0n);
  return { value, zone };
}

function groupsOf(value: bigint): number[] {
  const out: number[] = [];
  for (let i = 7; i >= 0; i -= 1) out.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  return out;
}

/** True for ::ffff:0:0/96, which RFC 5952 §5 prints with a dotted quad. */
function isIpv4Mapped(value: bigint): boolean {
  return value >> 32n === 0xffffn;
}

/**
 * RFC 5952 canonical text: lowercase, no leading zeros, the longest run of two
 * or more zero groups replaced by `::` (the first such run on a tie), and
 * IPv4-mapped addresses written with their dotted quad.
 */
export function formatIpv6(value: bigint): string {
  if (isIpv4Mapped(value)) return `::ffff:${formatIpv4(Number(value & 0xffffffffn))}`;

  const groups = groupsOf(value);
  let bestStart = -1;
  let bestLength = 1; // a single zero group is never compressed
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

/** All eight groups, four digits each. */
export function expandIpv6(value: bigint): string {
  return groupsOf(value)
    .map((g) => g.toString(16).padStart(4, "0"))
    .join(":");
}

export function ipv6Mask(prefix: number): bigint {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    throw new Error(`An IPv6 prefix must be between 0 and 128, not ${prefix}.`);
  }
  return prefix === 0 ? 0n : (IPV6_MAX << BigInt(128 - prefix)) & IPV6_MAX;
}

export interface Ipv6Input {
  address: bigint;
  prefix: number;
  prefixAssumed: boolean;
  zone: string | null;
}

/** `2001:db8::1/64`, or a bare address taken as /128. */
export function parseIpv6Cidr(text: string): Ipv6Input {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Enter an IPv6 address.");
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    const { value, zone } = parseIpv6(trimmed);
    return { address: value, prefix: 128, prefixAssumed: true, zone };
  }
  const prefixText = trimmed.slice(slash + 1).trim();
  if (!/^\d{1,3}$/.test(prefixText)) {
    throw new Error(`"${prefixText}" is not a prefix length; IPv6 prefixes are 0 to 128.`);
  }
  const prefix = Number(prefixText);
  if (prefix > 128) throw new Error(`An IPv6 prefix must be between 0 and 128, not ${prefix}.`);
  const { value, zone } = parseIpv6(trimmed.slice(0, slash));
  return { address: value, prefix, prefixAssumed: false, zone };
}

export interface Ipv6Network {
  address: bigint;
  prefix: number;
  mask: bigint;
  network: bigint;
  last: bigint;
  total: bigint;
  /** How many /64s fit, or null for a prefix longer than /64. */
  subnets64: bigint | null;
}

export function describeIpv6(address: bigint, prefix: number): Ipv6Network {
  const mask = ipv6Mask(prefix);
  const network = address & mask;
  const last = network | (~mask & IPV6_MAX);
  return {
    address,
    prefix,
    mask,
    network,
    last,
    total: 1n << BigInt(128 - prefix),
    subnets64: prefix <= 64 ? 1n << BigInt(64 - prefix) : null,
  };
}

export interface Ipv6Kind {
  label: string;
  note: string;
  cidr: string;
}

interface KindRule {
  cidr: string;
  label: string;
  note: string;
}

const KIND_RULES: readonly KindRule[] = [
  { cidr: "::/128", label: "Unspecified", note: "RFC 4291 — the absence of an address" },
  { cidr: "::1/128", label: "Loopback", note: "RFC 4291 — never leaves the host" },
  { cidr: "::ffff:0:0/96", label: "IPv4-mapped", note: "RFC 4291 — an IPv4 address seen through an IPv6 socket" },
  { cidr: "64:ff9b::/96", label: "NAT64", note: "RFC 6052 — well-known prefix for IPv4 translation" },
  { cidr: "64:ff9b:1::/48", label: "Local NAT64", note: "RFC 8215 — locally used translation prefix" },
  { cidr: "100::/64", label: "Discard", note: "RFC 6666 — a blackhole for remotely triggered filtering" },
  { cidr: "2001::/32", label: "Teredo", note: "RFC 4380 — IPv6 tunnelled over UDP through IPv4 NAT" },
  { cidr: "2001:20::/28", label: "ORCHIDv2", note: "RFC 7343 — cryptographic identifiers, not routable" },
  { cidr: "2001:db8::/32", label: "Documentation", note: "RFC 3849 — for examples only" },
  { cidr: "3fff::/20", label: "Documentation", note: "RFC 9637 — for examples only" },
  { cidr: "2002::/16", label: "6to4", note: "RFC 3056 — deprecated IPv4 tunnelling" },
  { cidr: "fc00::/7", label: "Unique local", note: "RFC 4193 — private addressing, like RFC 1918" },
  { cidr: "fe80::/10", label: "Link-local", note: "RFC 4291 — valid only on one link" },
  { cidr: "ff00::/8", label: "Multicast", note: "RFC 4291 — one-to-many, not a host address" },
  { cidr: "2000::/3", label: "Global unicast", note: "RFC 4291 — routable on the internet" },
];

/** The rules, most specific first, so the first containing prefix wins. */
const KINDS = KIND_RULES.map((rule) => {
  const { address, prefix } = parseIpv6Cidr(rule.cidr);
  return { ...rule, network: address, prefix, mask: ipv6Mask(prefix) };
}).sort((a, b) => b.prefix - a.prefix);

export function classifyIpv6(address: bigint): Ipv6Kind {
  for (const rule of KINDS) {
    if ((address & rule.mask) === rule.network) {
      return { label: rule.label, note: rule.note, cidr: rule.cidr };
    }
  }
  return { label: "Reserved", note: "IETF reserved space — not assigned for use", cidr: "" };
}

/**
 * An IPv4 address carried inside the IPv6 one, where the address type defines
 * where it sits. Teredo stores the client address with every bit inverted.
 */
export function embeddedIpv4(address: bigint): { address: string; role: string } | null {
  const kind = classifyIpv6(address).label;
  const low32 = Number(address & 0xffffffffn);
  switch (kind) {
    case "IPv4-mapped":
    case "NAT64":
      return { address: formatIpv4(low32), role: "the IPv4 address in the last 32 bits" };
    case "6to4":
      return { address: formatIpv4(Number((address >> 80n) & 0xffffffffn)), role: "the site's IPv4 address, bits 16–47" };
    case "Teredo":
      return { address: formatIpv4(~low32 >>> 0), role: "the client's public IPv4 address, stored inverted" };
    default:
      return null;
  }
}

/**
 * The MAC address an EUI-64 interface identifier was built from, if the low
 * 64 bits have the ff:fe marker in the middle. The universal/local bit is
 * flipped back, as RFC 4291 appendix A describes.
 */
export function eui64Mac(address: bigint): string | null {
  const iid = address & 0xffffffffffffffffn;
  if (((iid >> 24n) & 0xffffn) !== 0xfffen) return null;
  const bytes = [
    Number((iid >> 56n) & 0xffn) ^ 0x02,
    Number((iid >> 48n) & 0xffn),
    Number((iid >> 40n) & 0xffn),
    Number((iid >> 16n) & 0xffn),
    Number((iid >> 8n) & 0xffn),
    Number(iid & 0xffn),
  ];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}

/**
 * Reverse-DNS name. For a whole address, all 32 nibbles; for a prefix, only
 * the nibbles the prefix fixes — which is only a valid zone boundary when the
 * prefix is a multiple of 4.
 */
export function ip6Arpa(address: bigint, nibbles = 32): string {
  const hex = expandIpv6(address).replace(/:/g, "").slice(0, nibbles);
  return `${[...hex].reverse().join(".")}${nibbles > 0 ? "." : ""}ip6.arpa`;
}

/** Eight 16-bit groups in binary, dot-separated. */
export function ipv6Binary(value: bigint): string {
  return groupsOf(value)
    .map((g) => g.toString(2).padStart(16, "0"))
    .join(".");
}

/** `2^64`, or the full number when it is short enough to read. */
export function formatCount(count: bigint): string {
  const digits = count.toString();
  if (digits.length <= 15) return count.toLocaleString("en-US");
  const exponent = count.toString(2).length - 1;
  return 1n << BigInt(exponent) === count ? `2^${exponent}` : digits;
}
