import { describe, expect, it } from "vitest";
import { asFloat, asTwos, asUint, decodeBits, fieldValue, toggleBit } from "./bitsDecode";

describe("asUint", () => {
  it("masks to the given width", () => {
    expect(asUint(0b1111, 2)).toBe(0b11);
    expect(asUint(255, 8)).toBe(255);
    expect(asUint(256, 8)).toBe(0);
  });

  it("reads a negative as its bit pattern", () => {
    expect(asUint(-1, 8)).toBe(255);
    expect(asUint(-128, 8)).toBe(128);
  });
});

describe("asTwos", () => {
  it("reads the high bit as a sign", () => {
    expect(asTwos(0b0111, 4)).toBe(7);
    expect(asTwos(0b1000, 4)).toBe(-8);
    expect(asTwos(0b1111, 4)).toBe(-1);
  });

  it("agrees with asUint below the halfway point", () => {
    for (let v = 0; v < 128; v++) expect(asTwos(v, 8)).toBe(v);
  });

  it("round-trips the familiar 8-bit cases", () => {
    expect(asTwos(0xff, 8)).toBe(-1);
    expect(asTwos(0x80, 8)).toBe(-128);
    expect(asTwos(0x7f, 8)).toBe(127);
  });
});

describe("asFloat", () => {
  it("decodes the canonical float32 patterns", () => {
    expect(asFloat(0x3f800000, 32).value).toBe(1);
    expect(asFloat(0xc0000000, 32).value).toBe(-2);
    expect(asFloat(0x00000000, 32).value).toBe(0);
  });

  it("names the three fields", () => {
    const { parts } = asFloat(0x3f800000, 32);
    expect(parts[0]).toBe("sign 0");
    expect(parts[1]).toContain("exponent 01111111 (0)");
    expect(parts[2]).toContain("mantissa");
  });

  it("decodes a float64", () => {
    expect(asFloat(0x3ff0000000000000, 64).value).toBe(1);
  });
});

describe("decodeBits", () => {
  it("defaults to unsigned", () => {
    expect(decodeBits(5, 4, "uint")).toMatchObject({ label: "unsigned", text: "5" });
  });

  it("reads two's complement and says what the magnitude is", () => {
    const got = decodeBits(0b1111, 4, "twos");
    expect(got.text).toBe("-1");
    expect(got.label).toBe("two's complement");
  });

  it("formats hex to the pattern's width", () => {
    expect(decodeBits(0x0f, 8, "hex").text).toBe("0x0F");
    expect(decodeBits(5, 16, "hex").text).toBe("0x0005");
  });

  it("formats a float without printing seventeen digits", () => {
    expect(decodeBits(0x3f800000, 32, "ieee32").text).toBe("1");
    expect(decodeBits(0x3dcccccd, 32, "ieee32").text).toBe("0.100000001");
  });

  it("names the special float values", () => {
    expect(decodeBits(0x7f800000, 32, "ieee32").text).toBe("+∞");
    expect(decodeBits(0xff800000, 32, "ieee32").text).toBe("−∞");
    expect(decodeBits(0x7fc00000, 32, "ieee32").text).toBe("NaN");
  });

  it("prints the raw bit string padded to width", () => {
    expect(decodeBits(5, 8, "raw").text).toBe("00000101");
  });

  it("prints octal", () => {
    expect(decodeBits(8, 8, "oct").text).toBe("0o10");
  });
});

describe("fieldValue", () => {
  it("reads a named range out of the pattern", () => {
    // 0b1101_0110: low nibble 0110 = 6, high nibble 1101 = 13.
    expect(fieldValue(0b11010110, { from: 0, to: 3, label: "low" })).toBe(6);
    expect(fieldValue(0b11010110, { from: 4, to: 7, label: "high" })).toBe(13);
  });

  it("does not care which way round the bounds are written", () => {
    expect(fieldValue(0b1101, { from: 3, to: 0, label: "all" })).toBe(13);
  });

  it("reads a single-bit field", () => {
    expect(fieldValue(0b100, { from: 2, to: 2, label: "sign" })).toBe(1);
    expect(fieldValue(0b011, { from: 2, to: 2, label: "sign" })).toBe(0);
  });

  it("reads a float32's exponent field", () => {
    expect(fieldValue(0x3f800000, { from: 23, to: 30, label: "exp" })).toBe(127);
    expect(fieldValue(0x3f800000, { from: 31, to: 31, label: "sign" })).toBe(0);
  });
});

describe("toggleBit", () => {
  it("flips a bit both ways", () => {
    expect(toggleBit(0b0100, 1)).toBe(0b0110);
    expect(toggleBit(0b0110, 1)).toBe(0b0100);
  });

  it("handles the sign bit without going negative", () => {
    expect(toggleBit(0, 31)).toBe(2 ** 31);
    expect(toggleBit(2 ** 31, 31)).toBe(0);
  });

  it("does not wrap negative when a low bit flips above 2^31", () => {
    expect(toggleBit(2 ** 31 + 1, 0)).toBe(2 ** 31);
    expect(toggleBit(2 ** 32, 3)).toBe(2 ** 32 + 8);
  });

  it("keeps a bigint or string pattern exact", () => {
    expect(toggleBit(0n, 63)).toBe(1n << 63n);
    expect(toggleBit("0x8000000000000000", 63)).toBe(0n);
  });
});

describe("32 bits and wider", () => {
  it("masks at width 32 instead of collapsing to -1", () => {
    expect(asUint(0x80000000, 32)).toBe(0x80000000);
    expect(asUint(-1, 32)).toBe(0xffffffff);
    expect(asUint(2 ** 40 + 5, 32)).toBe(5);
    expect(decodeBits(0x80000000, 32, "hex").text).toBe("0x80000000");
    expect(decodeBits(0xffffffff, 32, "uint").text).toBe("4294967295");
  });

  it("reads fields above bit 31", () => {
    expect(fieldValue(2 ** 40, { from: 40, to: 40, label: "b40" })).toBe(1);
    expect(fieldValue("0x3FF0000000000000", { from: 52, to: 62, label: "exp" })).toBe(1023);
    expect(fieldValue(0xffffffff, { from: 0, to: 31, label: "all" })).toBe(0xffffffff);
  });

  it("treats non-finite numbers as zero rather than throwing", () => {
    expect(asUint(NaN, 64)).toBe(0);
    expect(asUint(Infinity, 40)).toBe(0);
    expect(decodeBits(NaN, 64, "ieee64").text).toBe("0");
  });

  it("decodes a real double from a hex string or bigint", () => {
    expect(decodeBits("0x3FB999999999999A", 64, "ieee64").text).toBe("0.1");
    expect(decodeBits(0x3fb999999999999an, 64, "ieee64").text).toBe("0.1");
    expect(decodeBits("0b11", 8, "uint").text).toBe("3");
    expect(decodeBits("0xFFFFFFFFFFFFFFFF", 64, "twos").text).toBe("-1");
    expect(decodeBits("0xFFFFFFFFFFFFFFFF", 64, "uint").text).toBe("18446744073709551615");
  });

  it("prints negative zero and subnormal exponents", () => {
    expect(decodeBits(0x80000000, 32, "ieee32").text).toBe("-0");
    expect(asFloat(0x00000001, 32).parts[1]).toBe("exponent 00000000 (-126)");
    expect(asFloat(1, 64).parts[1]).toContain("(-1022)");
  });
});
