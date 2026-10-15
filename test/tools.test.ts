import { describe, expect, it } from "vitest";
import { GoogleApiError } from "../src/google/client";
import {
  addChart,
  addColumns,
  addRows,
  batchUpdate,
  batchUpdateCells,
  copySheet,
  createSheet,
  createSpreadsheet,
  findInSpreadsheet,
  getMultipleSheetData,
  getMultipleSpreadsheetSummary,
  getSheetData,
  getSheetFormulas,
  getSpreadsheetInfo,
  listFolders,
  listSheets,
  listSpreadsheets,
  renameSheet,
  searchSpreadsheets,
  shareSpreadsheet,
  TOOL_NAMES,
  TOOLS,
  updateCells,
  type ToolDefinition,
  type ToolDeps,
} from "../src/tools";
import { errorResponse, FakeGoogle } from "./helpers/fake-google";

/** Run a tool the way the MCP layer does: validate/apply defaults, then call the handler. */
function invoke(tool: ToolDefinition, deps: ToolDeps, args: Record<string, unknown>) {
  return tool.handler(deps, tool.inputSchema.parse(args));
}

function setup(folderId?: string) {
  const google = new FakeGoogle();
  const deps: ToolDeps = { google: google.client(), folderId };
  return { google, deps };
}

describe("tool registry", () => {
  it("exposes the same 20 tools as the original server", () => {
    expect(TOOL_NAMES).toEqual([
      "get_sheet_data",
      "get_sheet_formulas",
      "update_cells",
      "batch_update_cells",
      "add_rows",
      "add_columns",
      "list_sheets",
      "copy_sheet",
      "rename_sheet",
      "get_multiple_sheet_data",
      "get_multiple_spreadsheet_summary",
      "create_spreadsheet",
      "create_sheet",
      "list_spreadsheets",
      "share_spreadsheet",
      "list_folders",
      "search_spreadsheets",
      "find_in_spreadsheet",
      "batch_update",
      "add_chart",
    ]);
    expect(new Set(TOOL_NAMES).size).toBe(TOOLS.length);
  });
});

describe("GoogleClient", () => {
  it("sends a bearer token and surfaces Google error messages", async () => {
    const { google, deps } = setup();
    google.override = () => errorResponse(403, "The caller does not have permission");
    await expect(deps.google.sheets.get("spreadsheet-id")).rejects.toMatchObject({
      name: "GoogleApiError",
      status: 403,
      message: "The caller does not have permission",
    });
    expect(google.lastCall.method).toBe("GET");
  });

  it("wraps non-JSON error bodies", async () => {
    const { google, deps } = setup();
    google.override = () => new Response("gateway exploded", { status: 502 });
    const error = await deps.google.sheets.get("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).message).toBe("gateway exploded");
  });
});

describe("reading tools", () => {
  it("get_sheet_data uses the values API by default", async () => {
    const { google, deps } = setup();
    google.valuesByRange["Sheet1!A1:B2"] = [["a", "b"]];

    const result = await invoke(getSheetData, deps, { spreadsheet_id: "spreadsheet-id", sheet: "Sheet1", range: "A1:B2" });

    expect(result).toEqual({
      spreadsheetId: "spreadsheet-id",
      valueRanges: [{ range: "Sheet1!A1:B2", values: [["a", "b"]] }],
    });
    expect(google.lastCall.method).toBe("GET");
    expect(google.lastCall.path).toBe("/v4/spreadsheets/spreadsheet-id/values/Sheet1!A1:B2");
  });

  it("get_sheet_data reads the whole sheet when no range is given", async () => {
    const { google, deps } = setup();
    await invoke(getSheetData, deps, { spreadsheet_id: "spreadsheet-id", sheet: "Sheet1" });
    expect(google.lastCall.path).toBe("/v4/spreadsheets/spreadsheet-id/values/Sheet1");
  });

  it("get_sheet_data uses spreadsheets.get with includeGridData when requested", async () => {
    const { google, deps } = setup();
    const result = await invoke(getSheetData, deps, {
      spreadsheet_id: "spreadsheet-id",
      sheet: "Sheet1",
      range: "A1:B2",
      include_grid_data: true,
    });
    expect(result).toEqual(google.metadata);
    expect(google.lastCall.path).toBe("/v4/spreadsheets/spreadsheet-id");
    expect(google.lastCall.query).toEqual({ ranges: "Sheet1!A1:B2", includeGridData: "true" });
  });

  it("get_sheet_formulas requests FORMULA rendering", async () => {
    const { google, deps } = setup();
    google.valuesByRange["Sheet1!D2:D3"] = [["=B2*2"], ["=B3*2"]];
    const result = await invoke(getSheetFormulas, deps, { spreadsheet_id: "id", sheet: "Sheet1", range: "D2:D3" });
    expect(result).toEqual([["=B2*2"], ["=B3*2"]]);
    expect(google.lastCall.query).toEqual({ valueRenderOption: "FORMULA" });
  });

  it("list_sheets returns sheet titles", async () => {
    const { deps } = setup();
    expect(await invoke(listSheets, deps, { spreadsheet_id: "id" })).toEqual(["Sheet1", "Data"]);
  });

  it("get_multiple_sheet_data reports missing keys and per-query errors", async () => {
    const { google, deps } = setup();
    google.valuesByRange["Sheet1!A1:B1"] = [["x", "y"]];
    google.override = (call) => (call.path.includes("/bad/") ? errorResponse(404, "Requested entity was not found.") : undefined);

    const result = await invoke(getMultipleSheetData, deps, {
      queries: [
        { spreadsheet_id: "good", sheet: "Sheet1", range: "A1:B1" },
        { spreadsheet_id: "bad", sheet: "Sheet1", range: "A1:B1" },
        { spreadsheet_id: "missing-range", sheet: "Sheet1" },
      ],
    });

    expect(result).toEqual([
      { spreadsheet_id: "good", sheet: "Sheet1", range: "A1:B1", data: [["x", "y"]] },
      { spreadsheet_id: "bad", sheet: "Sheet1", range: "A1:B1", error: "Requested entity was not found." },
      { spreadsheet_id: "missing-range", sheet: "Sheet1", error: "Missing required keys (spreadsheet_id, sheet, range)" },
    ]);
  });

  it("get_multiple_spreadsheet_summary returns headers and first rows", async () => {
    const { google, deps } = setup();
    google.valuesByRange["Sheet1!A1:3"] = [["name", "score"], ["Ada", 42], ["Grace", 37], ["extra", 0]];
    google.valuesByRange["Data!A1:3"] = [];

    const [summary] = (await invoke(getMultipleSpreadsheetSummary, deps, {
      spreadsheet_ids: ["id"],
      rows_to_fetch: 3,
    })) as any[];

    expect(summary.title).toBe("Book");
    expect(summary.error).toBeNull();
    expect(summary.sheets[0]).toEqual({
      title: "Sheet1",
      sheet_id: 123,
      headers: ["name", "score"],
      first_rows: [["Ada", 42], ["Grace", 37]],
      error: null,
    });
    expect(summary.sheets[1].headers).toEqual([]);
  });

  it("find_in_spreadsheet locates cells case-insensitively and honours max_results", async () => {
    const { google, deps } = setup();
    google.valuesByRange["Sheet1"] = [["Name", "Team"], ["Ada", "alpha"], ["adam", "beta"]];
    google.valuesByRange["Data"] = [["ADA"]];

    const all = await invoke(findInSpreadsheet, deps, { spreadsheet_id: "id", query: "ada" });
    expect(all).toEqual([
      { sheet: "Sheet1", cell: "A2", value: "Ada" },
      { sheet: "Sheet1", cell: "A3", value: "adam" },
      { sheet: "Data", cell: "A1", value: "ADA" },
    ]);

    const limited = await invoke(findInSpreadsheet, deps, { spreadsheet_id: "id", query: "ada", max_results: 1 });
    expect(limited).toHaveLength(1);

    const sensitive = await invoke(findInSpreadsheet, deps, { spreadsheet_id: "id", query: "Ada", case_sensitive: true });
    expect(sensitive).toEqual([{ sheet: "Sheet1", cell: "A2", value: "Ada" }]);

    expect(await invoke(findInSpreadsheet, deps, { spreadsheet_id: "id", query: "x", sheet: "Nope" })).toEqual([
      { error: "Sheet 'Nope' not found" },
    ]);
  });

  it("find_in_spreadsheet reports a spreadsheet with no sheets without naming an undefined sheet", async () => {
    const { google, deps } = setup();
    google.metadata = { properties: { title: "Empty" }, sheets: [] };
    expect(await invoke(findInSpreadsheet, deps, { spreadsheet_id: "id", query: "x" })).toEqual([
      { error: "No sheets found in spreadsheet" },
    ]);
  });

  it("spreadsheet info resource summarises sheets", async () => {
    const { deps } = setup();
    expect(await getSpreadsheetInfo(deps, "id")).toEqual({
      title: "Book",
      sheets: [
        { title: "Sheet1", sheetId: 123, gridProperties: { rowCount: 10, columnCount: 5 } },
        { title: "Data", sheetId: 456, gridProperties: {} },
      ],
    });
  });
});

describe("writing tools", () => {
  it("update_cells uses USER_ENTERED values", async () => {
    const { google, deps } = setup();
    const result = await invoke(updateCells, deps, {
      spreadsheet_id: "spreadsheet-id",
      sheet: "Sheet1",
      range: "A1:B2",
      data: [[1, 2], [3, 4]],
    });
    expect(result).toEqual({ updatedCells: 4 });
    expect(google.lastCall.method).toBe("PUT");
    expect(google.lastCall.path).toBe("/v4/spreadsheets/spreadsheet-id/values/Sheet1!A1:B2");
    expect(google.lastCall.query).toEqual({ valueInputOption: "USER_ENTERED" });
    expect(google.lastCall.body).toEqual({ values: [[1, 2], [3, 4]] });
  });

  it("batch_update_cells prefixes each range with the sheet name", async () => {
    const { google, deps } = setup();
    await invoke(batchUpdateCells, deps, {
      spreadsheet_id: "id",
      sheet: "Sheet1",
      ranges: { "A1:B2": [[1, 2]], D1: [["x"]] },
    });
    expect(google.lastCall.path).toBe("/v4/spreadsheets/id/values:batchUpdate");
    expect(google.lastCall.body).toEqual({
      valueInputOption: "USER_ENTERED",
      data: [
        { range: "Sheet1!A1:B2", values: [[1, 2]] },
        { range: "Sheet1!D1", values: [["x"]] },
      ],
    });
  });

  it("batch_update rejects empty requests before calling the API", async () => {
    const { google, deps } = setup();
    expect(await invoke(batchUpdate, deps, { spreadsheet_id: "id", requests: [] })).toEqual({
      error: "requests list cannot be empty",
    });
    expect(google.calls).toEqual([]);
  });

  it("batch_update sends raw requests", async () => {
    const { google, deps } = setup();
    const requests = [{ updateSheetProperties: { fields: "title" } }];
    const result = await invoke(batchUpdate, deps, { spreadsheet_id: "spreadsheet-id", requests });
    expect(result).toEqual(google.batchUpdateResult);
    expect(google.lastCall.path).toBe("/v4/spreadsheets/spreadsheet-id:batchUpdate");
    expect(google.lastCall.body).toEqual({ requests });
  });

  it("add_rows builds an insertDimension request", async () => {
    const { google, deps } = setup();
    await invoke(addRows, deps, { spreadsheet_id: "spreadsheet-id", sheet: "Sheet1", count: 3, start_row: 2 });
    expect(google.lastCall.body.requests[0].insertDimension).toEqual({
      range: { sheetId: 123, dimension: "ROWS", startIndex: 2, endIndex: 5 },
      inheritFromBefore: true,
    });
  });

  it("add_rows returns an error for a missing sheet", async () => {
    const { deps } = setup();
    expect(await invoke(addRows, deps, { spreadsheet_id: "id", sheet: "Missing", count: 1 })).toEqual({
      error: "Sheet 'Missing' not found",
    });
  });

  it("add_columns inserts at the start by default without inheriting", async () => {
    const { google, deps } = setup();
    await invoke(addColumns, deps, { spreadsheet_id: "id", sheet: "Data", count: 2 });
    expect(google.lastCall.body.requests[0].insertDimension).toEqual({
      range: { sheetId: 456, dimension: "COLUMNS", startIndex: 0, endIndex: 2 },
      inheritFromBefore: false,
    });
  });

  it("copy_sheet copies then renames when the title differs", async () => {
    const { google, deps } = setup();
    const result = (await invoke(copySheet, deps, {
      src_spreadsheet: "src",
      src_sheet: "Sheet1",
      dst_spreadsheet: "dst",
      dst_sheet: "CopiedSheet",
    })) as any;
    expect(result.copy).toEqual(google.copyResult);
    expect(result.rename).toEqual(google.batchUpdateResult);
    const [, copyCall, renameCall] = google.calls;
    expect(copyCall.path).toBe("/v4/spreadsheets/src/sheets/123:copyTo");
    expect(copyCall.body).toEqual({ destinationSpreadsheetId: "dst" });
    expect(renameCall.path).toBe("/v4/spreadsheets/dst:batchUpdate");
    expect(renameCall.body.requests[0].updateSheetProperties).toEqual({
      properties: { sheetId: 99, title: "CopiedSheet" },
      fields: "title",
    });
  });

  it("rename_sheet issues updateSheetProperties", async () => {
    const { google, deps } = setup();
    await invoke(renameSheet, deps, { spreadsheet: "id", sheet: "Data", new_name: "Renamed" });
    expect(google.lastCall.body.requests[0].updateSheetProperties).toEqual({
      properties: { sheetId: 456, title: "Renamed" },
      fields: "title",
    });
  });

  it("create_sheet returns the new sheet properties", async () => {
    const { google, deps } = setup();
    google.batchUpdateResult = { replies: [{ addSheet: { properties: { sheetId: 5, title: "New", index: 2 } } }] };
    expect(await invoke(createSheet, deps, { spreadsheet_id: "id", title: "New" })).toEqual({
      sheetId: 5,
      title: "New",
      index: 2,
      spreadsheetId: "id",
    });
  });

  it("add_chart builds a basic chart with split series and axis titles", async () => {
    const { google, deps } = setup();
    const result = (await invoke(addChart, deps, {
      spreadsheet_id: "id",
      sheet: "Sheet1",
      chart_type: "column",
      data_range: "A1:C4",
      title: "Scores",
      x_axis_label: "Name",
      y_axis_label: "Score",
    })) as any;
    expect(result.success).toBe(true);
    expect(result.chartId).toBe(7);
    const chart = google.lastCall.body.requests[0].addChart.chart;
    expect(chart.spec.title).toBe("Scores");
    expect(chart.spec.basicChart.chartType).toBe("COLUMN");
    expect(chart.spec.basicChart.axis).toEqual([
      { position: "BOTTOM_AXIS", title: "Name" },
      { position: "LEFT_AXIS", title: "Score" },
    ]);
    expect(chart.spec.basicChart.domains[0].domain.sourceRange.sources[0]).toEqual({
      sheetId: 123,
      startRowIndex: 0,
      endRowIndex: 4,
      startColumnIndex: 0,
      endColumnIndex: 1,
    });
    expect(chart.spec.basicChart.series).toHaveLength(2);
    expect(chart.position.overlayPosition).toEqual({
      anchorCell: { sheetId: 123, rowIndex: 0, columnIndex: 0 },
      offsetXPixels: 0,
      offsetYPixels: 0,
      widthPixels: 600,
      heightPixels: 400,
    });
  });

  it("add_chart builds a pie chart spec", async () => {
    const { google, deps } = setup();
    await invoke(addChart, deps, { spreadsheet_id: "id", sheet: "Sheet1", chart_type: "PIE", data_range: "A1:B5" });
    const spec = google.lastCall.body.requests[0].addChart.chart.spec;
    expect(spec.pieChart.domain.sourceRange.sources[0].endColumnIndex).toBe(1);
    expect(spec.pieChart.series.sourceRange.sources[0].startColumnIndex).toBe(1);
    expect(spec.title).toBeUndefined();
  });

  it("add_chart surfaces Google API errors instead of reporting the sheet missing", async () => {
    const { google, deps } = setup();
    google.override = () => errorResponse(403, "The caller does not have permission");
    await expect(
      invoke(addChart, deps, { spreadsheet_id: "id", sheet: "Sheet1", chart_type: "LINE", data_range: "A1:B2" }),
    ).rejects.toMatchObject({ status: 403, message: "The caller does not have permission" });
  });

  it("add_chart validates chart type, sheet, and range", async () => {
    const { deps } = setup();
    expect(await invoke(addChart, deps, { spreadsheet_id: "id", sheet: "Sheet1", chart_type: "DONUT", data_range: "A1:B2" })).toEqual({
      error: "Invalid chart type 'DONUT'. Must be one of: COLUMN, BAR, LINE, AREA, PIE, SCATTER, COMBO, HISTOGRAM",
    });
    expect(await invoke(addChart, deps, { spreadsheet_id: "id", sheet: "Nope", chart_type: "LINE", data_range: "A1:B2" })).toEqual({
      error: "Sheet 'Nope' not found in spreadsheet",
    });
    expect(await invoke(addChart, deps, { spreadsheet_id: "id", sheet: "Sheet1", chart_type: "LINE", data_range: "bad range" })).toEqual({
      error: "Invalid A1 notation: bad range",
    });
  });
});

describe("drive tools", () => {
  it("create_spreadsheet targets the requested folder", async () => {
    const { google, deps } = setup();
    const result = await invoke(createSpreadsheet, deps, { title: "Created Sheet", folder_id: "folder-id" });
    expect(result).toEqual({ spreadsheetId: "spreadsheet-id", title: "Created Sheet", folder: "folder-id" });
    expect(google.lastCall.method).toBe("POST");
    expect(google.lastCall.path).toBe("/drive/v3/files");
    expect(google.lastCall.query).toEqual({ supportsAllDrives: "true", fields: "id, name, parents" });
    expect(google.lastCall.body).toEqual({
      name: "Created Sheet",
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: ["folder-id"],
    });
  });

  it("create_spreadsheet falls back to the configured folder, then root", async () => {
    const configured = setup("default-folder");
    await invoke(createSpreadsheet, configured.deps, { title: "T" });
    expect(configured.google.lastCall.body.parents).toEqual(["default-folder"]);

    const unconfigured = setup();
    unconfigured.google.createFileResult = { id: "x", name: "T" };
    const result = await invoke(createSpreadsheet, unconfigured.deps, { title: "T" });
    expect(unconfigured.google.lastCall.body.parents).toBeUndefined();
    expect(result).toEqual({ spreadsheetId: "x", title: "T", folder: "root" });
  });

  it("list_spreadsheets scopes the query to a folder", async () => {
    const { google, deps } = setup("default-folder");
    const result = await invoke(listSpreadsheets, deps, {});
    expect(result).toEqual([{ id: "one", title: "Budget 2026" }]);
    expect(google.lastCall.query).toEqual({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and 'default-folder' in parents",
      spaces: "drive",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      fields: "files(id, name)",
      orderBy: "modifiedTime desc",
    });
  });

  it("list_folders defaults to the My Drive root", async () => {
    const { google, deps } = setup();
    const result = await invoke(listFolders, deps, {});
    expect(result).toEqual([{ id: "one", name: "Budget 2026", parent: "folder-id" }]);
    expect(google.lastCall.query.q).toBe("mimeType='application/vnd.google-apps.folder' and 'root' in parents");

    await invoke(listFolders, deps, { parent_folder_id: "p" });
    expect(google.lastCall.query.q).toBe("mimeType='application/vnd.google-apps.folder' and 'p' in parents");
  });

  it("search_spreadsheets escapes quotes and clamps max_results", async () => {
    const { google, deps } = setup();
    const result = await invoke(searchSpreadsheets, deps, { query: "Bob's budget", max_results: 500 });
    expect(result).toEqual([
      {
        id: "one",
        name: "Budget 2026",
        created_time: "2026-01-01T00:00:00Z",
        modified_time: "2026-01-02T00:00:00Z",
        owners: ["owner@example.com"],
        web_link: "https://example.test/sheet",
      },
    ]);
    expect(google.lastCall.query.pageSize).toBe("100");
    expect(google.lastCall.query.q).toBe(
      "mimeType='application/vnd.google-apps.spreadsheet' and (name contains 'Bob\\'s budget' or fullText contains 'Bob\\'s budget')",
    );
  });

  it("share_spreadsheet validates recipients and reports API failures", async () => {
    const { google, deps } = setup();
    google.override = (call) =>
      call.body?.emailAddress === "denied@example.com" ? errorResponse(403, "Permission denied") : undefined;

    const result = await invoke(shareSpreadsheet, deps, {
      spreadsheet_id: "id",
      recipients: [
        { email_address: "ok@example.com", role: "reader" },
        { email_address: "denied@example.com", role: "writer" },
        { role: "reader" },
        { email_address: "bad@example.com", role: "owner" },
      ],
      send_notification: false,
    });

    expect(result).toEqual({
      successes: [{ email_address: "ok@example.com", role: "reader", permissionId: "perm-1" }],
      failures: [
        { email_address: "denied@example.com", error: "Failed to share: Permission denied" },
        { email_address: null, error: "Missing email_address in recipient entry." },
        { email_address: "bad@example.com", error: "Invalid role 'owner'. Must be 'reader', 'commenter', or 'writer'." },
      ],
    });
    const okCall = google.calls[0];
    expect(okCall.path).toBe("/drive/v3/files/id/permissions");
    expect(okCall.query).toEqual({ sendNotificationEmail: "false", fields: "id" });
    expect(okCall.body).toEqual({ type: "user", role: "reader", emailAddress: "ok@example.com" });
  });
});
