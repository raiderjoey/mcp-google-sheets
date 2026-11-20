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
  headers: Record<string, string>;
}

/** A Drive file in the fake's vault tree. `md5Checksum` changes on every write. */
export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
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
  /** Files served for `'<id>' in parents` listings, metadata gets, downloads and uploads. */
  driveFiles: FakeDriveFile[] = [];
  private writes = 0;
  /** Optional hook to force a specific response (e.g. an error) for a call. */
  override?: (call: RecordedCall) => Response | undefined;

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: decodePath(url.pathname),
      query: queryObject(url),
      body: typeof init?.body === "string" ? parseBody(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    this.calls.push(call);
    const forced = this.override?.(call);
    if (forced) return forced;
    const driveResponse = this.routeDriveFiles(call);
    if (driveResponse) return driveResponse;
    return Response.json(this.route(call));
  };

  get lastCall(): RecordedCall {
    return this.calls[this.calls.length - 1];
  }

  client(): GoogleClient {
    return new GoogleClient({ getAccessToken: async () => "test-token", fetch: this.fetch });
  }

  /** Add a folder or file to the vault tree. Files get a starting md5 and size. */
  addDriveFile(file: Omit<FakeDriveFile, "md5Checksum" | "size"> & { md5Checksum?: string }): FakeDriveFile {
    const stored: FakeDriveFile = { modifiedTime: "2026-11-20T00:00:00Z", ...file };
    if (stored.mimeType !== FOLDER_MIME) {
      stored.md5Checksum ??= `md5-${stored.id}-0`;
      stored.size = String(new TextEncoder().encode(stored.content ?? "").length);
    }
    this.driveFiles.push(stored);
    return stored;
  }

  driveFile(id: string): FakeDriveFile | undefined {
    return this.driveFiles.find((file) => file.id === id);
  }

  /** Simulate an edit made elsewhere (phone, Drive for desktop). */
  touchDriveFile(id: string, content: string): void {
    const file = this.driveFile(id);
    if (!file) throw new Error(`no fake drive file ${id}`);
    file.content = content;
    file.md5Checksum = `md5-${id}-external-${++this.writes}`;
  }

  private driveMetadata(file: FakeDriveFile): Record<string, unknown> {
    const { content: _content, parents: _parents, ...meta } = file;
    return { ...meta, parents: file.parents };
  }

  private routeDriveFiles(call: RecordedCall): Response | undefined {
    const { method, path, query } = call;
    const upload = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (upload && method === "PATCH") {
      const file = this.driveFile(upload[1]);
      if (!file) return Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
      file.content = call.body as string;
      file.md5Checksum = `md5-${file.id}-${++this.writes}`;
      file.size = String(new TextEncoder().encode(file.content).length);
      file.modifiedTime = "2026-11-20T12:00:00Z";
      return Response.json(this.driveMetadata(file));
    }
    const single = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (single && method === "GET") {
      const file = this.driveFile(single[1]);
      if (!file) return undefined;
      if (query.alt === "media") return new Response(file.content ?? "", { headers: { "content-type": file.mimeType } });
      return Response.json(this.driveMetadata(file));
    }
    const q = typeof query.q === "string" ? /^'([^']+)' in parents and trashed = false$/.exec(query.q) : null;
    if (path === "/drive/v3/files" && method === "GET" && q) {
      const files = this.driveFiles
        .filter((file) => file.parents.includes(q[1]) && !file.trashed)
        .map((file) => this.driveMetadata(file));
      return Response.json({ files });
    }
    return undefined;
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
