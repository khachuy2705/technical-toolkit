/**
 * MD5 (RFC 1321).
 *
 * Hand-written because WebCrypto deliberately does not offer MD5 — it is
 * cryptographically broken and `crypto.subtle` refuses to help you use it. The
 * tool still offers it because MD5 remains everywhere as a non-security
 * checksum: package manifests, legacy APIs, ETags, file integrity lists.
 *
 * Correctness is pinned by the RFC 1321 test suite in scripts/verify.ts. Do not
 * edit this file without running it.
 */

/** Per-round left-rotation amounts. */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** K[i] = floor(abs(sin(i + 1)) * 2^32), the RFC's sine table. */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000);
}

function rotateLeft(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

/** MD5 digest of `input`, as 16 raw bytes. */
export function md5(input: Uint8Array): Uint8Array {
  // Pad to a multiple of 64 bytes: one 0x80 byte, zeroes, then the original
  // length in bits as a 64-bit little-endian integer.
  const bitLength = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer);
  // Lengths above 2^32 bits (512 MB) would need the high word; browsers will
  // run out of memory long before that, so the high word stays zero.
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x1_0000_0000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) block[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      // `| 0` keeps the intermediate in int32 range; JS bitwise ops would
      // otherwise see a float once the sum exceeds 2^31.
      b = (b + rotateLeft((a + f + K[i]! + block[g]!) | 0, SHIFTS[i]!)) | 0;
      a = temp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0 >>> 0, true);
  out.setUint32(4, b0 >>> 0, true);
  out.setUint32(8, c0 >>> 0, true);
  out.setUint32(12, d0 >>> 0, true);
  return digest;
}
