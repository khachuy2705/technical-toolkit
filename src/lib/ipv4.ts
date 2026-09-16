/**
 * IPv4 address and subnet arithmetic.
 *
 * Addresses are carried as unsigned 32-bit numbers. Every bitwise result is
 * passed through `>>> 0`, because JavaScript's bitwise operators work on signed
 * int32 and anything with the top bit set — every address from 128.0.0.0 up —
 * comes back negative otherwise.
 */

export const IPV4_MAX = 0xffffffff;

export function formatIpv4(value: number): string {
  const n = value >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/**
 * Parses dotted-quad notation.
 *
 * Leading zeros are rejected rather than accepted. `inet_aton` and several
 * language runtimes read `010` as octal 8, others as decimal 10, and that
 * disagreement is a well-worn source of access-control bypasses. Refusing the
 * input is the only reading that cannot be wrong.
 */
export function parseIpv4(text: string): number {
  const trimmed = text.trim();
  const parts = trimmed.split(".");

  if (parts.length !== 4) {
    throw new Error(`"${trimmed}" is not an IPv4 address — it needs four dot-separated octets.`);
  }

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`"${part}" is not a number between 0 and 255.`);
    }
    if (part.length > 1 && part.startsWith("0")) {
      throw new Error(
        `"${part}" has a leading zero. Some tools read that as octal and some as decimal, so it is refused rather than guessed.`,
      );
    }
    const octet = Number(part);
    if (octet > 255) throw new Error(`"${part}" is above 255.`);
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** The netmask for a prefix length, as a 32-bit number. */
export function maskFromPrefix(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`A prefix must be between 0 and 32, not ${prefix}.`);
  }
  // `x << 32` is a no-op in JavaScript (the shift count is taken mod 32), so a
  // /0 mask has to be special-cased rather than shifted into existence.
  return prefix === 0 ? 0 : (IPV4_MAX << (32 - prefix)) >>> 0;
}

/**
 * The prefix length of a netmask. Throws when the mask has gaps — 255.255.0.255
 * is a valid-looking dotted quad but not a valid mask.
 */
export function prefixFromMask(mask: number): number {
  const value = mask >>> 0;
  // A contiguous mask is exactly one run of 1s followed by 0s, so inverting it
  // and adding one must land on a power of two (or zero, for /0 and /32).
  const inverted = ~value >>> 0;
  if (((inverted + 1) & inverted) !== 0) {
    throw new Error(
      `${formatIpv4(value)} is not a valid subnet mask — the 1 bits have to be contiguous.`,
    );
  }
  let prefix = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if ((value & (1 << bit)) === 0) break;
    prefix += 1;
  }
  return prefix;
}

export interface Ipv4Input {
  address: number;
  prefix: number;
  /** True when the user gave no prefix and /32 was assumed. */
  prefixAssumed: boolean;
}

/**
 * Accepts `10.0.0.1/24`, `10.0.0.1/255.255.255.0`, `10.0.0.1 255.255.255.0`,
 * and a bare `10.0.0.1`.
 */
export function parseCidr(text: string): Ipv4Input {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Enter an address.");

  const separator = trimmed.includes("/") ? "/" : /\s/.test(trimmed) ? " " : null;
  if (separator === null) {
    return { address: parseIpv4(trimmed), prefix: 32, prefixAssumed: true };
  }

  const cut = separator === "/" ? trimmed.indexOf("/") : trimmed.search(/\s/);
  const addressPart = trimmed.slice(0, cut).trim();
  const prefixPart = trimmed.slice(cut + 1).trim();

  const address = parseIpv4(addressPart);

  if (prefixPart.length === 0) throw new Error("The prefix is missing after the slash.");

  if (prefixPart.includes(".")) {
    return { address, prefix: prefixFromMask(parseIpv4(prefixPart)), prefixAssumed: false };
  }

  if (!/^\d{1,2}$/.test(prefixPart)) {
    throw new Error(`"${prefixPart}" is not a prefix length or a subnet mask.`);
  }
  const prefix = Number(prefixPart);
  if (prefix > 32) throw new Error(`A prefix must be between 0 and 32, not ${prefix}.`);

  return { address, prefix, prefixAssumed: false };
}

export interface Ipv4Network {
  address: number;
  prefix: number;
  mask: number;
  wildcard: number;
  network: number;
  broadcast: number;
  firstHost: number;
  lastHost: number;
  usableHosts: number;
  totalAddresses: number;
  /** True for /31 and /32, where the usual network/broadcast split does not apply. */
  degenerate: boolean;
}

export function describeNetwork(address: number, prefix: number): Ipv4Network {
  const mask = maskFromPrefix(prefix);
  const wildcard = ~mask >>> 0;
  const network = (address & mask) >>> 0;
  const broadcast = (network | wildcard) >>> 0;
  const totalAddresses = 2 ** (32 - prefix);

  // /31 is a point-to-point link (RFC 3021): both addresses are usable and
  // there is no broadcast. /32 is a single host. Applying the usual
  // "subtract network and broadcast" rule to either gives 0 or -1 hosts.
  let firstHost: number;
  let lastHost: number;
  let usableHosts: number;

  if (prefix === 32) {
    firstHost = network;
    lastHost = network;
    usableHosts = 1;
  } else if (prefix === 31) {
    firstHost = network;
    lastHost = broadcast;
    usableHosts = 2;
  } else {
    firstHost = (network + 1) >>> 0;
    lastHost = (broadcast - 1) >>> 0;
    usableHosts = totalAddresses - 2;
  }

  return {
    address,
    prefix,
    mask,
    wildcard,
    network,
    broadcast,
    firstHost,
    lastHost,
    usableHosts,
    totalAddresses,
    degenerate: prefix >= 31,
  };
}

export interface AddressKind {
  label: string;
  note: string;
  /** Routable on the public internet. */
  global: boolean;
}

interface KindRule {
  readonly cidr: string;
  readonly label: string;
  readonly note: string;
  readonly global: boolean;
}

/** Ordered most specific first; the first containing range wins. */
const KINDS: readonly KindRule[] = [
  { cidr: "0.0.0.0/8", label: "This network", note: "RFC 1122 — only valid as a source address", global: false },
  { cidr: "10.0.0.0/8", label: "Private", note: "RFC 1918 — not routed on the internet", global: false },
  { cidr: "100.64.0.0/10", label: "Carrier-grade NAT", note: "RFC 6598 — shared ISP address space", global: false },
  { cidr: "127.0.0.0/8", label: "Loopback", note: "RFC 1122 — never leaves the host", global: false },
  { cidr: "169.254.0.0/16", label: "Link-local", note: "RFC 3927 — self-assigned when DHCP fails", global: false },
  { cidr: "172.16.0.0/12", label: "Private", note: "RFC 1918 — not routed on the internet", global: false },
  { cidr: "192.0.0.0/24", label: "IETF protocol assignments", note: "RFC 6890", global: false },
  { cidr: "192.0.2.0/24", label: "Documentation", note: "RFC 5737 — TEST-NET-1", global: false },
  { cidr: "192.168.0.0/16", label: "Private", note: "RFC 1918 — not routed on the internet", global: false },
  { cidr: "198.18.0.0/15", label: "Benchmarking", note: "RFC 2544 — network device testing", global: false },
  { cidr: "198.51.100.0/24", label: "Documentation", note: "RFC 5737 — TEST-NET-2", global: false },
  { cidr: "203.0.113.0/24", label: "Documentation", note: "RFC 5737 — TEST-NET-3", global: false },
  { cidr: "224.0.0.0/4", label: "Multicast", note: "RFC 5771 — one-to-many, not a host address", global: false },
  { cidr: "255.255.255.255/32", label: "Limited broadcast", note: "RFC 919", global: false },
  { cidr: "240.0.0.0/4", label: "Reserved", note: "RFC 1112 — reserved for future use", global: false },
];

export function classifyAddress(address: number): AddressKind {
  for (const rule of KINDS) {
    const [network, prefix] = rule.cidr.split("/") as [string, string];
    const mask = maskFromPrefix(Number(prefix));
    if (((address & mask) >>> 0) === parseIpv4(network)) {
      return { label: rule.label, note: rule.note, global: rule.global };
    }
  }
  return { label: "Public", note: "globally routable address space", global: true };
}

/** `11000000.10101000.00000001.00000000` — one dotted group per octet. */
export function toBinary(value: number): string {
  const n = value >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    .map((octet) => octet.toString(2).padStart(8, "0"))
    .join(".");
}
