/**
 * A1-notation helpers, ported one-to-one from the original Python server.
 */

export interface GridRange {
  sheetId?: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

export type A1Indices = Omit<GridRange, "sheetId">;

/** Convert a 0-based column index to its A1 letters (0 = "A", 25 = "Z", 26 = "AA"). */
export function columnIndexToLetter(index: number): string {
  let result = "";
  let i = index;
  while (i >= 0) {
    result = String.fromCharCode((i % 26) + 65) + result;
    i = Math.floor(i / 26) - 1;
  }
  return result;
}

/** Convert A1 column letters to a 0-based index ("A" = 0, "Z" = 25, "AA" = 26). */
export function letterToColumnIndex(letter: string): number {
  let result = 0;
  for (const ch of letter.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
}

/**
 * Parse an A1 range ("A1:C10", "A:B", "1:10", "B2") into 0-based, end-exclusive
 * grid indices. Keys are only present when the range constrains that axis.
 */
export function parseA1Notation(rangeStr: string): A1Indices {
  const match = /^([A-Z]+)?(\d+)?(?::([A-Z]+)?(\d+)?)?$/.exec(rangeStr.toUpperCase());
  if (!match) {
    throw new Error(`Invalid A1 notation: ${rangeStr}`);
  }
  const [, startCol, startRow, endCol, endRow] = match;
  const result: A1Indices = {};

  if (startCol) {
    result.startColumnIndex = letterToColumnIndex(startCol);
  }
  if (startRow) {
    result.startRowIndex = Number.parseInt(startRow, 10) - 1;
  }
  if (endCol) {
    result.endColumnIndex = letterToColumnIndex(endCol) + 1;
  } else if (startCol) {
    result.endColumnIndex = result.startColumnIndex! + 1;
  }
  if (endRow) {
    result.endRowIndex = Number.parseInt(endRow, 10);
  } else if (startRow) {
    result.endRowIndex = result.startRowIndex! + 1;
  }
  return result;
}

/**
 * Split a chart source range into one domain range (first column) and one
 * series range per remaining column. Google chart sources must be a single
 * row or column each.
 */
export function splitChartSourceRanges(sourceRange: GridRange): [GridRange, GridRange[]] {
  const startCol = sourceRange.startColumnIndex;
  const endCol = sourceRange.endColumnIndex;

  if (startCol === undefined || endCol === undefined || endCol - startCol <= 1) {
    return [sourceRange, [sourceRange]];
  }

  const domainRange: GridRange = { ...sourceRange, endColumnIndex: startCol + 1 };
  const seriesRanges: GridRange[] = [];
  for (let col = startCol + 1; col < endCol; col++) {
    seriesRanges.push({ ...sourceRange, startColumnIndex: col, endColumnIndex: col + 1 });
  }
  return [domainRange, seriesRanges];
}
