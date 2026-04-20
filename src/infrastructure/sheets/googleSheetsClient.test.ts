import { describe, it, expect } from "vitest";
import { indexToColumnLetter } from "./googleSheetsClient";

describe("indexToColumnLetter", () => {
  it("0 → A, 25 → Z", () => {
    expect(indexToColumnLetter(0)).toBe("A");
    expect(indexToColumnLetter(25)).toBe("Z");
  });
  it("26 → AA, 27 → AB", () => {
    expect(indexToColumnLetter(26)).toBe("AA");
    expect(indexToColumnLetter(27)).toBe("AB");
  });
  it("51 → AZ, 52 → BA", () => {
    expect(indexToColumnLetter(51)).toBe("AZ");
    expect(indexToColumnLetter(52)).toBe("BA");
  });
  it("負の値は例外", () => {
    expect(() => indexToColumnLetter(-1)).toThrow();
  });
});
