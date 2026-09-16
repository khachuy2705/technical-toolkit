/**
 * Base64, UTF-8 safe.
 *
 * `btoa` and `atob` operate on Latin-1: `btoa("é")` throws, and round-tripping
 * anything outside U+00FF silently corrupts. Everything here goes through
 * TextEncoder/TextDecoder so the tool is correct for real-world text.
 */

export type Base64Variant = "standard" | "url";

/** Chunked so a large input cannot blow the argument limit of `apply`. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array, variant: Base64Variant = "standard"): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const encoded = btoa(binary);
  return variant === "url" ? toUrlSafe(encoded) : encoded;
}

export function base64ToBytes(text: string, variant: Base64Variant = "standard"): Uint8Array {
  const normalised = normalise(text, variant);
  const binary = atob(normalised);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(text: string, variant: Base64Variant = "standard"): string {
  return bytesToBase64(new TextEncoder().encode(text), variant);
}

/**
 * Decodes to text. Throws a human-readable Error when the input is not valid
 * Base64, or decodes to bytes that are not valid UTF-8.
 */
export function decodeBase64(text: string, variant: Base64Variant = "standard"): string {
  const bytes = base64ToBytes(text, variant);
  try {
    // `fatal` matters: without it, invalid UTF-8 becomes U+FFFD and the tool
    // would hand back plausible-looking mojibake instead of reporting a problem.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "Decoded successfully, but the bytes are not valid UTF-8 text. The input is probably binary data.",
    );
  }
}

function toUrlSafe(encoded: string): string {
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Prepares input for `atob`: drops whitespace, accepts either alphabet
 * regardless of the selected variant, and restores padding.
 *
 * Being liberal here is deliberate — Base64 arrives wrapped at 76 columns, in
 * URL-safe form, or with the padding stripped, and a decoder that rejects those
 * is useless in practice.
 */
function normalise(text: string, variant: Base64Variant): string {
  let value = text.replace(/\s+/g, "");
  if (value.length === 0) return "";

  value = value.replace(/-/g, "+").replace(/_/g, "/");

  const invalid = value.replace(/=+$/, "").match(/[^A-Za-z0-9+/]/);
  if (invalid) {
    throw new Error(`Not valid Base64: unexpected character ${JSON.stringify(invalid[0])}.`);
  }

  const unpadded = value.replace(/=+$/, "");
  const remainder = unpadded.length % 4;
  if (remainder === 1) {
    throw new Error("Not valid Base64: the input is one character short of a complete group.");
  }

  void variant; // Both alphabets are accepted on input; the variant only shapes output.
  return remainder === 0 ? unpadded : unpadded + "=".repeat(4 - remainder);
}
