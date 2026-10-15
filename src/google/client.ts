/**
 * Minimal typed client for the Sheets v4 and Drive v3 REST endpoints the
 * tools need. Uses fetch directly so it runs inside Cloudflare Workers.
 */
import type { FetchLike } from "./auth";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export type CellValue = string | number | boolean | null;

export interface SheetProperties {
  title: string;
  sheetId: number;
  index?: number;
  gridProperties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SpreadsheetMetadata {
  spreadsheetId?: string;
  properties?: { title?: string; [key: string]: unknown };
  sheets?: Array<{ properties: SheetProperties; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ValueRange {
  range?: string;
  majorDimension?: string;
  values?: CellValue[][];
}

export interface BatchUpdateResponse {
  spreadsheetId?: string;
  replies?: Array<Record<string, any>>;
  [key: string]: unknown;
}

export interface DriveFile {
  id: string;
  name: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{ emailAddress?: string; [key: string]: unknown }>;
  webViewLink?: string;
  [key: string]: unknown;
}

export interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string;
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface GoogleClientOptions {
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
}

function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === "object" && data !== null) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
    if (typeof error === "string" && error) return error;
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  return `Google API request failed with status ${status}`;
}

export class GoogleClient {
  constructor(private readonly options: GoogleClientOptions) {}

  async request<T = unknown>(
    method: string,
    url: string,
    { query, body }: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const target = new URL(url);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) target.searchParams.append(key, item);
        } else {
          target.searchParams.set(key, String(value));
        }
      }
    }
    const token = await this.options.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const fetchImpl = this.options.fetch ?? ((input, init) => fetch(input, init));
    const response = await fetchImpl(target.toString(), { method, headers, body: payload });
    const text = await response.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      throw new GoogleApiError(extractErrorMessage(data, response.status), response.status, data);
    }
    return (data ?? {}) as T;
  }

  readonly sheets = {
    get: (
      spreadsheetId: string,
      options: { ranges?: string[]; includeGridData?: boolean; fields?: string } = {},
    ) =>
      this.request<SpreadsheetMetadata>("GET", `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}`, {
        query: {
          ranges: options.ranges,
          includeGridData: options.includeGridData,
          fields: options.fields,
        },
      }),

    valuesGet: (spreadsheetId: string, range: string, options: { valueRenderOption?: string } = {}) =>
      this.request<ValueRange>(
        "GET",
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        { query: { valueRenderOption: options.valueRenderOption } },
      ),

    valuesUpdate: (spreadsheetId: string, range: string, values: CellValue[][], valueInputOption = "USER_ENTERED") =>
      this.request<Record<string, unknown>>(
        "PUT",
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        { query: { valueInputOption }, body: { values } },
      ),

    valuesBatchUpdate: (spreadsheetId: string, body: { valueInputOption: string; data: ValueRange[] }) =>
      this.request<Record<string, unknown>>(
        "POST",
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        { body },
      ),

    batchUpdate: (spreadsheetId: string, requests: Array<Record<string, unknown>>) =>
      this.request<BatchUpdateResponse>(
        "POST",
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        { body: { requests } },
      ),

    copyTo: (spreadsheetId: string, sheetId: number, destinationSpreadsheetId: string) =>
      this.request<SheetProperties>(
        "POST",
        `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/sheets/${sheetId}:copyTo`,
        { body: { destinationSpreadsheetId } },
      ),
  };

  readonly drive = {
    filesCreate: (body: Record<string, unknown>, options: { fields?: string; supportsAllDrives?: boolean } = {}) =>
      this.request<DriveFile>("POST", `${DRIVE_BASE}/files`, {
        query: { fields: options.fields, supportsAllDrives: options.supportsAllDrives },
        body,
      }),

    filesList: (query: Query) => this.request<DriveFileList>("GET", `${DRIVE_BASE}/files`, { query }),

    filesDelete: (fileId: string, options: { supportsAllDrives?: boolean } = {}) =>
      this.request<Record<string, unknown>>("DELETE", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`, {
        query: { supportsAllDrives: options.supportsAllDrives },
      }),

    permissionsCreate: (
      fileId: string,
      body: Record<string, unknown>,
      options: { sendNotificationEmail?: boolean; fields?: string } = {},
    ) =>
      this.request<{ id?: string }>("POST", `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`, {
        query: { sendNotificationEmail: options.sendNotificationEmail, fields: options.fields },
        body,
      }),
  };
}
