import { md5 } from "./md5";

export type HashId = "md5" | "sha-256" | "sha-512";

export interface HashAlgorithm {
  readonly id: HashId;
  readonly label: string;
  /** Digest length in bits. */
  readonly bits: number;
  readonly note: string;
}

export const HASH_ALGORITHMS: readonly HashAlgorithm[] = [
  {
    id: "md5",
    label: "MD5",
    bits: 128,
    note: "broken for security — checksums and legacy formats only",
  },
  { id: "sha-256", label: "SHA-256", bits: 256, note: "the sensible default" },
  { id: "sha-512", label: "SHA-512", bits: 512, note: "wider digest, no practical downside" },
] as const;

export function hashById(id: HashId): HashAlgorithm {
  const found = HASH_ALGORITHMS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown hash algorithm: ${id}`);
  return found;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Hex digest of `bytes`.
 *
 * SHA goes through WebCrypto; MD5 cannot, because `crypto.subtle` does not
 * implement it. Both paths are async so callers need only one shape.
 */
export async function hashBytes(id: HashId, bytes: Uint8Array): Promise<string> {
  if (id === "md5") return toHex(md5(bytes));

  const name = id === "sha-256" ? "SHA-256" : "SHA-512";
  // `slice()` hands subtle a plain ArrayBuffer even when `bytes` is a view into
  // a larger buffer, which a File read can produce.
  const digest = await crypto.subtle.digest(name, bytes.slice().buffer);
  return toHex(new Uint8Array(digest));
}

export async function hashText(id: HashId, text: string): Promise<string> {
  return hashBytes(id, new TextEncoder().encode(text));
}

/** Every algorithm at once, in registry order. */
export async function hashAll(bytes: Uint8Array): Promise<{ id: HashId; hex: string }[]> {
  return Promise.all(
    HASH_ALGORITHMS.map(async (algorithm) => ({
      id: algorithm.id,
      hex: await hashBytes(algorithm.id, bytes),
    })),
  );
}
