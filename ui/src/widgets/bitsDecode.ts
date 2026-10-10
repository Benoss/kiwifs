/**
 * Interpretations of a bit pattern.
 *
 * Kept out of the component so each is unit-testable, and because the point of
 * `decode:` is to retire the one-off TwosComplementView / FloatView that every
 * numeric-representation page otherwise grows: a float *is* a bit pattern with
 * three named fields and one reading.
 */

export type BitsDecoding = "uint" | "int" | "twos" | "ieee32" | "ieee64" | "hex" | "oct" | "raw";

export interface DecodedBits {
  /** Short label for the summary row, e.g. "two's complement". */
  label: string;
  /** The value as the reader should see it. */
  text: string;
  /** Extra lines — the sign/exponent/mantissa breakdown of a float. */
  detail?: string[];
}

function bitsOf(value: number, width: number): string {
  // >>> 0 keeps a high bit from printing as a negative; BigInt handles 64-bit.
  if (width > 32) return BigInt.asUintN(width, BigInt(Math.trunc(value))).toString(2).padStart(width, "0");
  return (value >>> 0).toString(2).slice(-width).padStart(width, "0");
}

/** Unsigned value of the low `width` bits. */
export function asUint(value: number, width: number): number {
  if (width >= 53) return Number(BigInt.asUintN(width, BigInt(Math.trunc(value))));
  return Math.trunc(value) & ((2 ** width) - 1);
}

/** Two's complement reading of the low `width` bits. */
export function asTwos(value: number, width: number): number {
  const u = asUint(value, width);
  const half = 2 ** (width - 1);
  return u >= half ? u - 2 ** width : u;
}

/** IEEE-754 single or double, from the raw bit pattern. */
export function asFloat(value: number, width: 32 | 64): { value: number; parts: string[] } {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  if (width === 32) {
    view.setUint32(0, asUint(value, 32) >>> 0);
    const bits = bitsOf(value, 32);
    return {
      value: view.getFloat32(0),
      parts: [
        `sign ${bits[0]}`,
        `exponent ${bits.slice(1, 9)} (${parseInt(bits.slice(1, 9), 2) - 127})`,
        `mantissa ${bits.slice(9)}`,
      ],
    };
  }
  view.setBigUint64(0, BigInt.asUintN(64, BigInt(Math.trunc(value))));
  const bits = bitsOf(value, 64);
  return {
    value: view.getFloat64(0),
    parts: [
      `sign ${bits[0]}`,
      `exponent ${bits.slice(1, 12)} (${parseInt(bits.slice(1, 12), 2) - 1023})`,
      `mantissa ${bits.slice(12)}`,
    ],
  };
}

export function decodeBits(value: number, width: number, as: BitsDecoding): DecodedBits {
  switch (as) {
    case "int":
    case "twos": {
      const signed = asTwos(value, width);
      return {
        label: "two's complement",
        text: String(signed),
        detail: signed < 0 ? [`−${asUint(-signed, width)} as ${width} bits`] : undefined,
      };
    }
    case "ieee32": {
      const { value: f, parts } = asFloat(value, 32);
      return { label: "float32", text: formatFloat(f), detail: parts };
    }
    case "ieee64": {
      const { value: f, parts } = asFloat(value, 64);
      return { label: "float64", text: formatFloat(f), detail: parts };
    }
    case "hex":
      return {
        label: "hex",
        text: `0x${asUint(value, width).toString(16).toUpperCase().padStart(Math.ceil(width / 4), "0")}`,
      };
    case "oct":
      return { label: "octal", text: `0o${asUint(value, width).toString(8)}` };
    case "raw":
      return { label: "bits", text: bitsOf(value, width) };
    case "uint":
    default:
      return { label: "unsigned", text: String(asUint(value, width)) };
  }
}

function formatFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (!Number.isFinite(f)) return f > 0 ? "+∞" : "−∞";
  if (Number.isInteger(f) && Math.abs(f) < 1e15) return String(f);
  // Enough digits to round-trip without printing 17 of them for 0.1.
  return String(Number(f.toPrecision(9)));
}

export interface BitField {
  /** Low bit position, inclusive. */
  from: number;
  /** High bit position, inclusive. */
  to: number;
  label: string;
  color?: string;
}

/** The value of a named field, read out of the pattern. */
export function fieldValue(value: number, field: BitField): number {
  const lo = Math.min(field.from, field.to);
  const hi = Math.max(field.from, field.to);
  const width = hi - lo + 1;
  return asUint(Math.trunc(value) >>> lo, width);
}

/** `value` with bit `bit` flipped. */
export function toggleBit(value: number, bit: number): number {
  if (bit >= 31) {
    return Number(BigInt.asUintN(53, BigInt(Math.trunc(value)) ^ (1n << BigInt(bit))));
  }
  return Math.trunc(value) ^ (1 << bit);
}
