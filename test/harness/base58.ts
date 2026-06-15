/**
 * Minimal, dependency-free base58 (Bitcoin alphabet) encoder plus a wire-format
 * signature extractor. Used so the mock cluster can derive the same transaction
 * signature that `@solana/kit`'s `getSignatureFromTransaction` produces, letting
 * tests build/sign a real kit transaction and assert against the mock.
 */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

/** Reads a Solana compact-u16 (shortvec) length prefix. */
export function readShortU16(
  bytes: Uint8Array,
  offset: number,
): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let length = 0;
  for (;;) {
    const byte = bytes[offset + length]!;
    value |= (byte & 0x7f) << shift;
    length++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, length };
}

/**
 * Extracts the first signature (base58) from a base64-encoded wire transaction.
 * Wire layout: [compact-u16 signature count][sig0 (64 bytes)]...[message].
 */
export function firstSignatureFromWireBase64(wireBase64: string): string {
  const bytes = Uint8Array.from(Buffer.from(wireBase64, "base64"));
  const { length } = readShortU16(bytes, 0);
  return base58Encode(bytes.slice(length, length + 64));
}
