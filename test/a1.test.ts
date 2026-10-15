import { describe, expect, it } from "vitest";
import { columnIndexToLetter, letterToColumnIndex, parseA1Notation, splitChartSourceRanges } from "../src/a1";

describe("A1 helpers", () => {
  it("converts column indexes to letters", () => {
    expect(columnIndexToLetter(0)).toBe("A");
    expect(columnIndexToLetter(25)).toBe("Z");
    expect(columnIndexToLetter(26)).toBe("AA");
    expect(columnIndexToLetter(701)).toBe("ZZ");
  });

  it("converts letters back to column indexes", () => {
    expect(letterToColumnIndex("A")).toBe(0);
    expect(letterToColumnIndex("Z")).toBe(25);
    expect(letterToColumnIndex("AA")).toBe(26);
    expect(letterToColumnIndex("zz")).toBe(701);
  });

  it("parses a full A1 range", () => {
    expect(parseA1Notation("B2:D5")).toEqual({
      startColumnIndex: 1,
      startRowIndex: 1,
      endColumnIndex: 4,
      endRowIndex: 5,
    });
  });

  it("parses a column-only range", () => {
    expect(parseA1Notation("A:C")).toEqual({ startColumnIndex: 0, endColumnIndex: 3 });
  });

  it("parses a single cell as a one-cell range", () => {
    expect(parseA1Notation("c3")).toEqual({
      startColumnIndex: 2,
      startRowIndex: 2,
      endColumnIndex: 3,
      endRowIndex: 3,
    });
  });

  it("rejects invalid ranges", () => {
    expect(() => parseA1Notation("not a range")).toThrow(/Invalid A1 notation/);
  });

  it("rejects empty and half-empty ranges", () => {
    for (const bad of ["", ":", "A1:", ":B2", "A:"]) {
      expect(() => parseA1Notation(bad), bad).toThrow(/Invalid A1 notation/);
    }
  });

  it("splits a multi-column table into domain and series ranges", () => {
    const source = { sheetId: 123, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 };
    const [domain, series] = splitChartSourceRanges(source);
    expect(domain).toEqual({ sheetId: 123, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 });
    expect(series).toEqual([
      { sheetId: 123, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 },
      { sheetId: 123, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 },
    ]);
  });

  it("keeps a single-column range as both domain and series", () => {
    const source = { sheetId: 1, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 };
    expect(splitChartSourceRanges(source)).toEqual([source, [source]]);
  });
});
