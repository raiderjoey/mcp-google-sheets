/**
 * Live Google integration test. Opt in with:
 *
 *   RUN_GOOGLE_INTEGRATION=1 DRIVE_FOLDER_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' \
 *   GOOGLE_TEST_SPREADSHEET_ID=... GOOGLE_TEST_COPY_TARGET_ID=... npm run test:integration
 *
 * The two spreadsheets must be owned by a real user, live in DRIVE_FOLDER_ID, and be
 * shared with the service account as editor. The test works in tabs named `it-*` and
 * deletes them afterwards (and sweeps leftovers from failed runs first); it never
 * creates Drive files, because service accounts have no storage quota.
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

/**
 * Tools the live test cannot exercise, with the reason. Service accounts have no Drive
 * storage quota, so any call that makes the service account own a new file fails with
 * "The user's Drive storage quota has been exceeded" unless the folder is on a Shared Drive.
 */
const TOOLS_WITHOUT_INTEGRATION_COVERAGE: Record<string, string> = {
  create_spreadsheet: "service accounts cannot own new Drive files outside a Shared Drive",
};

describe("integration coverage declaration", () => {
  it("covers or explicitly excuses every tool", () => {
    const excused = Object.keys(TOOLS_WITHOUT_INTEGRATION_COVERAGE);
    expect(TOOLS_WITH_INTEGRATION_COVERAGE.filter((name) => excused.includes(name))).toEqual([]);
    expect([...TOOLS_WITH_INTEGRATION_COVERAGE, ...excused].sort()).toEqual([...TOOL_NAMES].sort());
  });
});

const enabled = env.RUN_GOOGLE_INTEGRATION === "1";

function invoke(tool: ToolDefinition, deps: ToolDeps, args: Record<string, unknown>): Promise<any> {
  return tool.handler(deps, tool.inputSchema.parse(args));
}

/** Delete every `it-*` tab, leaving the fixture's own tabs alone. */
async function deleteTestTabs(google: GoogleClient, spreadsheetId: string): Promise<void> {
  const meta = await google.sheets.get(spreadsheetId, { fields: "sheets(properties(title,sheetId))" });
  const requests = (meta.sheets ?? [])
    .filter((sheet) => sheet.properties?.title?.startsWith(TEST_TAB_PREFIX))
    .map((sheet) => ({ deleteSheet: { sheetId: sheet.properties!.sheetId } }));
  if (requests.length) await google.sheets.batchUpdate(spreadsheetId, requests);
}

const TEST_TAB_PREFIX = "it-";

describe.skipIf(!enabled)("live Google Sheets integration", () => {
  let deps: ToolDeps;
  let google: GoogleClient;
  let folderId: string;
  let primaryId: string;
  let copyTargetId: string;

  beforeAll(async () => {
    folderId = env.DRIVE_FOLDER_ID ?? "";
    if (!folderId) throw new Error("DRIVE_FOLDER_ID is required for live integration tests");
    primaryId = env.GOOGLE_TEST_SPREADSHEET_ID ?? "";
    copyTargetId = env.GOOGLE_TEST_COPY_TARGET_ID ?? "";
    if (!primaryId || !copyTargetId) {
      throw new Error("GOOGLE_TEST_SPREADSHEET_ID and GOOGLE_TEST_COPY_TARGET_ID are required for live integration tests");
    }
    const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.CREDENTIALS_CONFIG;
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or CREDENTIALS_CONFIG is required");
    const provider = new ServiceAccountTokenProvider(parseServiceAccount(raw));
    google = new GoogleClient({ getAccessToken: () => provider.getAccessToken() });
    deps = { google, folderId };
    await deleteTestTabs(google, primaryId);
    await deleteTestTabs(google, copyTargetId);
  });

  afterAll(async () => {
    for (const spreadsheetId of [primaryId, copyTargetId]) {
      try {
        if (spreadsheetId) await deleteTestTabs(google, spreadsheetId);
      } catch {
        // best effort cleanup; the next run sweeps leftovers
      }
    }
  });

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
      const tab = `${TEST_TAB_PREFIX}run-${suffix}`;
      const copiedTab = `${TEST_TAB_PREFIX}copied-${suffix}`;

      const createdSheet = await invoke(createSheet, deps, { spreadsheet_id: primaryId, title: `${tab}-new` });
      expect(createdSheet.title).toBe(`${tab}-new`);

      expect(await invoke(renameSheet, deps, { spreadsheet: primaryId, sheet: `${tab}-new`, new_name: tab })).toHaveProperty("replies");
      expect(await invoke(listSheets, deps, { spreadsheet_id: primaryId })).toContain(tab);

      const updateResult = await invoke(updateCells, deps, {
        spreadsheet_id: primaryId,
        sheet: tab,
        range: "A1:D3",
        data: [
          ["name", "score", "team", "double"],
          ["Ada", 42, "alpha", "=B2*2"],
          ["Grace", 37, "beta", "=B3*2"],
        ],
      });
      expect(updateResult.updatedCells ?? 0).toBeGreaterThanOrEqual(12);

      const data = await invoke(getSheetData, deps, { spreadsheet_id: primaryId, sheet: tab, range: "A1:D3" });
      expect(data.valueRanges[0].values[1][0]).toBe("Ada");
      expect(data.valueRanges[0].values[1][1]).toBe("42");

      const formulas = await invoke(getSheetFormulas, deps, { spreadsheet_id: primaryId, sheet: tab, range: "D2:D3" });
      expect(formulas).toEqual([["=B2*2"], ["=B3*2"]]);

      const batchCells = await invoke(batchUpdateCells, deps, {
        spreadsheet_id: primaryId,
        sheet: tab,
        ranges: { "E1:E2": [["status"], ["ready"]], "F1:F2": [["owner"], ["integration"]] },
      });
      expect(batchCells.totalUpdatedCells ?? 0).toBeGreaterThanOrEqual(4);

      expect(await invoke(addRows, deps, { spreadsheet_id: primaryId, sheet: tab, count: 1, start_row: 10 })).toHaveProperty("replies");
      expect(await invoke(addColumns, deps, { spreadsheet_id: primaryId, sheet: tab, count: 1, start_column: 10 })).toHaveProperty("replies");

      const tabId = await lookupSheetId(google, primaryId, tab);
      expect(tabId).toBeDefined();

      const batchResult = await invoke(batchUpdate, deps, {
        spreadsheet_id: primaryId,
        requests: [
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { note: "integration-test-note" },
              fields: "note",
            },
          },
        ],
      });
      expect(batchResult).toHaveProperty("replies");

      const chartResult = await invoke(addChart, deps, {
        spreadsheet_id: primaryId,
        sheet: tab,
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
        src_sheet: tab,
        dst_spreadsheet: copyTargetId,
        dst_sheet: copiedTab,
      });
      expect(copyResult).toHaveProperty("copy");
      expect(await invoke(listSheets, deps, { spreadsheet_id: copyTargetId })).toContain(copiedTab);

      const multiData = await invoke(getMultipleSheetData, deps, {
        queries: [
          { spreadsheet_id: primaryId, sheet: tab, range: "A1:B3" },
          { spreadsheet_id: copyTargetId, sheet: copiedTab, range: "A1:B3" },
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

      const primaryTitle = spreadsheets.find((sheet: { id: string; title: string }) => sheet.id === primaryId).title;
      const found = await waitForSearchResult(primaryTitle, primaryId);
      expect(found.some((sheet) => sheet.id === primaryId)).toBe(true);

      const foundCells = await invoke(findInSpreadsheet, deps, { spreadsheet_id: primaryId, query: "Ada" });
      expect(foundCells.some((cell: { sheet: string; cell: string }) => cell.sheet === tab && cell.cell === "A2"), JSON.stringify(foundCells)).toBe(true);

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
