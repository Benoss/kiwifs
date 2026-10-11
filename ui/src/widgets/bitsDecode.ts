/**
 * Interpretations of a bit pattern.
 *
 * Kept out of the component so each is unit-testable, and because the point of
 * `decode:` is to retire the one-off TwosComplementView / FloatView that every
 * numeric-representation page otherwise grows: a float *is* a bit pattern with
 * three named fields and one reading.
 */

export type BitsDecoding = "uint" | "int" | "twos" | "ieee32" | "ieee64" | "hex" | "oct" | "raw";

/**
 * A bit pattern. A number is exact up to 2^53, which is short of a double's 64
 * bits, so a bigint or a `"0x3FB999999999999A"` / `"0b1010"` string is how a
 * page spells a real float64 pattern.
 */
export type BitsValue = number | bigint | string;

export interface DecodedBits {
  /** Short label for the summary row, e.g. "two's complement". */
  label: string;
  /** The value as the reader should see it. */
  text: string;
  /** Extra lines — the sign/exponent/mantissa breakdown of a float. */
  detail?: string[];
}

const PREFIXED = /^([+-]?)(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i;

/** The pattern as a bigint; anything unreadable (NaN, "abc") is 0. */
export function toBigBits(value: BitsValue): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    const m = PREFIXED.exec(value.trim().replace(/_/g, ""));
    if (m) {
      const magnitude = BigInt(m[2]!);
      return m[1] === "-" ? -magnitude : magnitude;
    }
    return toBigBits(Number(value));
  }
  return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
}

function uintBig(value: BitsValue, width: number): bigint {
  return BigInt.asUintN(width, toBigBits(value));
}

function bitsOf(value: BitsValue, width: number): string {
  return uintBig(value, width).toString(2).padStart(width, "0");
}

/** Unsigned value of the low `width` bits. */
export function asUint(value: BitsValue, width: number): number {
  if (typeof value === "number" && width < 32) {
    return Number.isFinite(value) ? (Math.trunc(value) & (2 ** width - 1)) >>> 0 : 0;
  }
  return Number(uintBig(value, width));
}

/** Two's complement reading of the low `width` bits. */
export function asTwos(value: BitsValue, width: number): number {
  return Number(BigInt.asIntN(width, toBigBits(value)));
}

/** IEEE-754 single or double, from the raw bit pattern. */
export function asFloat(value: BitsValue, width: 32 | 64): { value: number; parts: string[] } {
  const view = new DataView(new ArrayBuffer(8));
  const bits = bitsOf(value, width);
  const expBits = width === 32 ? 8 : 11;
  const bias = width === 32 ? 127 : 1023;
  if (width === 32) view.setUint32(0, Number(uintBig(value, 32)));
  else view.setBigUint64(0, uintBig(value, 64));
  const expField = bits.slice(1, 1 + expBits);
  const raw = parseInt(expField, 2);
  // A zero exponent field is subnormal: the implicit leading bit is 0 and the
  // exponent is pinned at 1 - bias, not 0 - bias.
  const exponent = raw === 0 ? 1 - bias : raw - bias;
  return {
    value: width === 32 ? view.getFloat32(0) : view.getFloat64(0),
    parts: [`sign ${bits[0]}`, `exponent ${expField} (${exponent})`, `mantissa ${bits.slice(1 + expBits)}`],
  };
}

export function decodeBits(value: BitsValue, width: number, as: BitsDecoding): DecodedBits {
  switch (as) {
    case "int":
    case "twos": {
      const signed = BigInt.asIntN(width, toBigBits(value));
      return {
        label: "two's complement",
        text: String(signed),
        detail: signed < 0n ? [`−${-signed} as ${width} bits`] : undefined,
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
        text: `0x${uintBig(value, width).toString(16).toUpperCase().padStart(Math.ceil(width / 4), "0")}`,
      };
    case "oct":
      return { label: "octal", text: `0o${uintBig(value, width).toString(8)}` };
    case "raw":
      return { label: "bits", text: bitsOf(value, width) };
    case "uint":
    default:
      return { label: "unsigned", text: String(uintBig(value, width)) };
  }
}

function formatFloat(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (!Number.isFinite(f)) return f > 0 ? "+∞" : "−∞";
  if (Object.is(f, -0)) return "-0";
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
export function fieldValue(value: BitsValue, field: BitField): number {
  const lo = Math.min(field.from, field.to);
  const hi = Math.max(field.from, field.to);
  return Number(BigInt.asUintN(hi - lo + 1, toBigBits(value) >> BigInt(lo)));
}

/**
 * `value` with bit `bit` flipped. A number comes back as a number; a bigint or
 * string pattern comes back as a bigint so 64-bit patterns stay exact.
 */
export function toggleBit(value: number, bit: number): number;
export function toggleBit(value: BitsValue, bit: number): number | bigint;
export function toggleBit(value: BitsValue, bit: number): number | bigint {
  const flipped = toBigBits(value) ^ (1n << BigInt(bit));
  return typeof value === "number" ? Number(flipped) : flipped;
}
