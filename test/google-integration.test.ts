/**
 * Live Google integration test. Opt in with:
 *
 *   RUN_GOOGLE_INTEGRATION=1 DRIVE_FOLDER_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' npm test -- test/google-integration.test.ts
 *
 * The folder must be disposable: the test creates and deletes spreadsheets.
 * GOOGLE_TEST_SHARE_EMAIL is optional and enables a real share call.
 */
import { env as workerEnv } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseServiceAccount, ServiceAccountTokenProvider } from "../src/google/auth";
import { GoogleClient } from "../src/google/client";
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
  lookupSheetId,
  listFolders,
  listSheets,
  listSpreadsheets,
  renameSheet,
  searchSpreadsheets,
  shareSpreadsheet,
  TOOL_NAMES,
  updateCells,
  type ToolDefinition,
  type ToolDeps,
} from "../src/tools";

const env = workerEnv as unknown as Record<string, string | undefined>;

/** Every tool the live test below exercises. Must match TOOL_NAMES so new tools get coverage. */
const TOOLS_WITH_INTEGRATION_COVERAGE = [
  "add_chart",
  "add_columns",
  "add_rows",
  "batch_update",
  "batch_update_cells",
  "copy_sheet",
  "create_sheet",
  "create_spreadsheet",
  "find_in_spreadsheet",
  "get_multiple_sheet_data",
  "get_multiple_spreadsheet_summary",
  "get_sheet_data",
  "get_sheet_formulas",
  "list_folders",
  "list_sheets",
  "list_spreadsheets",
  "rename_sheet",
  "search_spreadsheets",
  "share_spreadsheet",
  "update_cells",
];

describe("integration coverage declaration", () => {
  it("matches the current tool list", () => {
    expect([...TOOLS_WITH_INTEGRATION_COVERAGE].sort()).toEqual([...TOOL_NAMES].sort());
  });
});

const enabled = env.RUN_GOOGLE_INTEGRATION === "1";

function invoke(tool: ToolDefinition, deps: ToolDeps, args: Record<string, unknown>): Promise<any> {
  return tool.handler(deps, tool.inputSchema.parse(args));
}

describe.skipIf(!enabled)("live Google Sheets integration", () => {
  let deps: ToolDeps;
  let google: GoogleClient;
  let folderId: string;
  const createdFileIds: string[] = [];

  beforeAll(() => {
    folderId = env.DRIVE_FOLDER_ID ?? "";
    if (!folderId) throw new Error("DRIVE_FOLDER_ID is required for live integration tests");
    const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.CREDENTIALS_CONFIG;
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or CREDENTIALS_CONFIG is required");
    const provider = new ServiceAccountTokenProvider(parseServiceAccount(raw));
    google = new GoogleClient({ getAccessToken: () => provider.getAccessToken() });
    deps = { google, folderId };
  });

  afterAll(async () => {
    for (const fileId of createdFileIds) {
      try {
        await google.drive.filesDelete(fileId, { supportsAllDrives: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  async function createTestSpreadsheet(title: string): Promise<string> {
    const created = await invoke(createSpreadsheet, deps, { title });
    createdFileIds.push(created.spreadsheetId);
    expect(created.title).toBe(title);
    expect(created.folder).toBe(folderId);
    return created.spreadsheetId;
  }

  async function waitForSearchResult(title: string, spreadsheetId: string, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let last: any[] = [];
    while (Date.now() < deadline) {
      last = await invoke(searchSpreadsheets, deps, { query: title, max_results: 10 });
      if (last.some((sheet) => sheet.id === spreadsheetId)) return last;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`search_spreadsheets did not find ${spreadsheetId}: ${JSON.stringify(last)}`);
  }

  it(
    "exercises every tool against Google",
    async () => {
      const suffix = Date.now();
      const primaryTitle = `mcp-google-sheets-it-primary-${suffix}`;
      const copyTargetTitle = `mcp-google-sheets-it-copy-target-${suffix}`;

      const primaryId = await createTestSpreadsheet(primaryTitle);
      const copyTargetId = await createTestSpreadsheet(copyTargetTitle);

      const updateResult = await invoke(updateCells, deps, {
        spreadsheet_id: primaryId,
        sheet: "Sheet1",
        range: "A1:D3",
        data: [
          ["name", "score", "team", "double"],
          ["Ada", 42, "alpha", "=B2*2"],
          ["Grace", 37, "beta", "=B3*2"],
        ],
      });
      expect(updateResult.updatedCells ?? 0).toBeGreaterThanOrEqual(12);

      const data = await invoke(getSheetData, deps, { spreadsheet_id: primaryId, sheet: "Sheet1", range: "A1:D3" });
      expect(data.valueRanges[0].values[1][0]).toBe("Ada");
      expect(data.valueRanges[0].values[1][1]).toBe("42");

      const formulas = await invoke(getSheetFormulas, deps, { spreadsheet_id: primaryId, sheet: "Sheet1", range: "D2:D3" });
      expect(formulas).toEqual([["=B2*2"], ["=B3*2"]]);

      const batchCells = await invoke(batchUpdateCells, deps, {
        spreadsheet_id: primaryId,
        sheet: "Sheet1",
        ranges: { "E1:E2": [["status"], ["ready"]], "F1:F2": [["owner"], ["integration"]] },
      });
      expect(batchCells.totalUpdatedCells ?? 0).toBeGreaterThanOrEqual(4);

      expect(await invoke(addRows, deps, { spreadsheet_id: primaryId, sheet: "Sheet1", count: 1, start_row: 10 })).toHaveProperty("replies");
      expect(await invoke(addColumns, deps, { spreadsheet_id: primaryId, sheet: "Sheet1", count: 1, start_column: 10 })).toHaveProperty("replies");

      expect(await invoke(listSheets, deps, { spreadsheet_id: primaryId })).toContain("Sheet1");

      const createdSheet = await invoke(createSheet, deps, { spreadsheet_id: primaryId, title: "CreatedTab" });
      expect(createdSheet.title).toBe("CreatedTab");

      expect(await invoke(renameSheet, deps, { spreadsheet: primaryId, sheet: "CreatedTab", new_name: "RenamedTab" })).toHaveProperty("replies");
      expect(await invoke(listSheets, deps, { spreadsheet_id: primaryId })).toContain("RenamedTab");

      const sheet1Id = await lookupSheetId(google, primaryId, "Sheet1");
      expect(sheet1Id).toBeDefined();

      const batchResult = await invoke(batchUpdate, deps, {
        spreadsheet_id: primaryId,
        requests: [
          {
            repeatCell: {
              range: { sheetId: sheet1Id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { note: "integration-test-note" },
              fields: "note",
            },
          },
        ],
      });
      expect(batchResult).toHaveProperty("replies");

      const chartResult = await invoke(addChart, deps, {
        spreadsheet_id: primaryId,
        sheet: "Sheet1",
        chart_type: "COLUMN",
        data_range: "A1:B3",
        title: "Integration Chart",
        x_axis_label: "Name",
        y_axis_label: "Score",
      });
      expect(chartResult.success, JSON.stringify(chartResult)).toBe(true);
      expect(chartResult.chartId).toBeDefined();

      const copyResult = await invoke(copySheet, deps, {
        src_spreadsheet: primaryId,
        src_sheet: "Sheet1",
        dst_spreadsheet: copyTargetId,
        dst_sheet: "CopiedSheet",
      });
      expect(copyResult).toHaveProperty("copy");
      expect(await invoke(listSheets, deps, { spreadsheet_id: copyTargetId })).toContain("CopiedSheet");

      const multiData = await invoke(getMultipleSheetData, deps, {
        queries: [
          { spreadsheet_id: primaryId, sheet: "Sheet1", range: "A1:B3" },
          { spreadsheet_id: copyTargetId, sheet: "CopiedSheet", range: "A1:B3" },
        ],
      });
      expect(multiData).toHaveLength(2);
      expect(multiData[0].data[1][0]).toBe("Ada");
      expect(multiData[1]).not.toHaveProperty("error");

      const summaries = await invoke(getMultipleSpreadsheetSummary, deps, { spreadsheet_ids: [primaryId, copyTargetId], rows_to_fetch: 3 });
      expect(summaries).toHaveLength(2);
      expect(summaries[0].spreadsheet_id).toBe(primaryId);
      expect(summaries[0].error).toBeNull();
      expect(summaries[0].sheets.length).toBeGreaterThan(0);

      const spreadsheets = await invoke(listSpreadsheets, deps, { folder_id: folderId });
      expect(spreadsheets.some((sheet: { id: string }) => sheet.id === primaryId)).toBe(true);

      expect(Array.isArray(await invoke(listFolders, deps, { parent_folder_id: folderId }))).toBe(true);

      const found = await waitForSearchResult(primaryTitle, primaryId);
      expect(found.some((sheet) => sheet.id === primaryId)).toBe(true);

      const foundCells = await invoke(findInSpreadsheet, deps, { spreadsheet_id: primaryId, query: "Ada" });
      expect(foundCells.some((cell: { sheet: string; cell: string }) => cell.sheet === "Sheet1" && cell.cell === "A2"), JSON.stringify(foundCells)).toBe(true);

      const shareEmail = env.GOOGLE_TEST_SHARE_EMAIL;
      if (shareEmail) {
        const shareResult = await invoke(shareSpreadsheet, deps, {
          spreadsheet_id: primaryId,
          recipients: [{ email_address: shareEmail, role: "reader" }],
          send_notification: false,
        });
        expect(shareResult.successes.length, JSON.stringify(shareResult)).toBeGreaterThan(0);
      } else {
        const shareResult = await invoke(shareSpreadsheet, deps, {
          spreadsheet_id: primaryId,
          recipients: [{ email_address: "nobody@example.invalid", role: "invalid-role" }],
          send_notification: false,
        });
        expect(shareResult.successes).toEqual([]);
        expect(shareResult.failures).toHaveLength(1);
      }
    },
    240_000,
  );
});
