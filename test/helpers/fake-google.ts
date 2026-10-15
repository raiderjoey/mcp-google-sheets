/**
 * In-memory stand-in for the Google Sheets/Drive REST APIs. Records every
 * request so tests can assert on the exact calls the tools make.
 */
import type { FetchLike } from "../../src/google/auth";
import { GoogleClient, type CellValue, type SpreadsheetMetadata } from "../../src/google/client";

export interface RecordedCall {
  method: string;
  url: URL;
  /** Decoded pathname, e.g. /v4/spreadsheets/id/values/Sheet1!A1:B2 */
  path: string;
  query: Record<string, string | string[]>;
  body?: any;
}

function decodePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}

export class FakeGoogle {
  calls: RecordedCall[] = [];

  metadata: SpreadsheetMetadata = {
    properties: { title: "Book" },
    sheets: [
      { properties: { title: "Sheet1", sheetId: 123, gridProperties: { rowCount: 10, columnCount: 5 } } },
      { properties: { title: "Data", sheetId: 456 } },
    ],
  };
  valuesByRange: Record<string, CellValue[][]> = {};
  updateResult: unknown = { updatedCells: 4 };
  batchValuesResult: unknown = { totalUpdatedCells: 4 };
  batchUpdateResult: unknown = { replies: [{ addChart: { chart: { chartId: 7 } } }] };
  copyResult: unknown = { sheetId: 99, title: "Copy of Sheet1" };
  createFileResult: unknown = { id: "spreadsheet-id", name: "Created Sheet", parents: ["folder-id"] };
  listFilesResult: unknown = {
    files: [
      {
        id: "one",
        name: "Budget 2026",
        createdTime: "2026-01-01T00:00:00Z",
        modifiedTime: "2026-01-02T00:00:00Z",
        owners: [{ emailAddress: "owner@example.com" }],
        webViewLink: "https://example.test/sheet",
        parents: ["folder-id"],
      },
    ],
  };
  permissionResult: unknown = { id: "perm-1" };
  /** Optional hook to force a specific response (e.g. an error) for a call. */
  override?: (call: RecordedCall) => Response | undefined;

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: decodePath(url.pathname),
      query: queryObject(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    const forced = this.override?.(call);
    if (forced) return forced;
    return Response.json(this.route(call));
  };

  get lastCall(): RecordedCall {
    return this.calls[this.calls.length - 1];
  }

  client(): GoogleClient {
    return new GoogleClient({ getAccessToken: async () => "test-token", fetch: this.fetch });
  }

  private route(call: RecordedCall): unknown {
    const { method, path } = call;
    if (path.startsWith("/v4/spreadsheets/")) {
      if (path.endsWith(":batchUpdate") && path.includes("/values:batchUpdate")) return this.batchValuesResult;
      if (path.endsWith(":batchUpdate")) return this.batchUpdateResult;
      if (path.endsWith(":copyTo")) return this.copyResult;
      const values = /^\/v4\/spreadsheets\/[^/]+\/values\/(.+)$/.exec(path);
      if (values) {
        if (method === "PUT") return this.updateResult;
        return { range: values[1], values: this.valuesByRange[values[1]] ?? [] };
      }
      return this.metadata;
    }
    if (path.startsWith("/drive/v3/files")) {
      if (path.endsWith("/permissions")) return this.permissionResult;
      if (method === "POST") return this.createFileResult;
      if (method === "DELETE") return {};
      return this.listFilesResult;
    }
    throw new Error(`FakeGoogle has no route for ${method} ${path}`);
  }
}

export function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { code: status, message, status: "ERROR" } }, { status });
}
