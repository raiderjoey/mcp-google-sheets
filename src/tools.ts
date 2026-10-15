/**
 * Tool implementations. Each tool is a plain async function over `ToolDeps`
 * so it can be unit-tested without the MCP transport. Names, argument names,
 * and result shapes match the original Python server so existing prompts and
 * clients keep working.
 */
import { z } from "zod";
import { columnIndexToLetter, parseA1Notation, splitChartSourceRanges, type GridRange } from "./a1";
import { errorMessage } from "./google/auth";
import type { GoogleClient, SpreadsheetMetadata } from "./google/client";

export interface ToolDeps {
  google: GoogleClient;
  /** Default Drive folder for list/create operations. */
  folderId?: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (deps: ToolDeps, args: any) => Promise<unknown>;
}

function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: S;
  handler: (deps: ToolDeps, args: z.output<S>) => Promise<unknown>;
}): ToolDefinition {
  return def as ToolDefinition;
}

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const grid = z.array(z.array(cellValue));
const spreadsheetId = z.string().describe("The ID of the spreadsheet (found in the URL)");
const sheetName = z.string().describe("The name of the sheet/tab (e.g. 'Sheet1')");

function findSheetId(spreadsheet: SpreadsheetMetadata, title: string): number | undefined {
  for (const sheet of spreadsheet.sheets ?? []) {
    if (sheet.properties?.title === title) return sheet.properties.sheetId;
  }
  return undefined;
}

/** Resolve a sheet title to its numeric sheetId. Google API errors propagate to the caller. */
export async function lookupSheetId(google: GoogleClient, spreadsheetId: string, title: string): Promise<number | undefined> {
  const spreadsheet = await google.sheets.get(spreadsheetId, { fields: "sheets(properties(title,sheetId))" });
  return findSheetId(spreadsheet, title);
}

/** Escape a value for use inside a single-quoted Drive query string. */
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Sheets: reading
// ---------------------------------------------------------------------------

export const getSheetData = defineTool({
  name: "get_sheet_data",
  title: "Get Sheet Data",
  readOnly: true,
  description:
    "Get data from a specific sheet in a Google Spreadsheet. Returns values only by default; set include_grid_data to true for full cell formatting and metadata (much larger response).",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    range: z.string().optional().describe("Optional cell range in A1 notation (e.g. 'A1:C10'). If omitted, gets all data."),
    include_grid_data: z
      .boolean()
      .default(false)
      .describe("If true, includes cell formatting and other metadata. Significantly larger response."),
  }),
  async handler({ google }, { spreadsheet_id, sheet, range, include_grid_data }) {
    const fullRange = range ? `${sheet}!${range}` : sheet;
    if (include_grid_data) {
      return google.sheets.get(spreadsheet_id, { ranges: [fullRange], includeGridData: true });
    }
    const result = await google.sheets.valuesGet(spreadsheet_id, fullRange);
    return {
      spreadsheetId: spreadsheet_id,
      valueRanges: [{ range: fullRange, values: result.values ?? [] }],
    };
  },
});

export const getSheetFormulas = defineTool({
  name: "get_sheet_formulas",
  title: "Get Sheet Formulas",
  readOnly: true,
  description: "Get formulas from a specific sheet in a Google Spreadsheet. Returns a 2D array of the sheet formulas.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    range: z.string().optional().describe("Optional cell range in A1 notation (e.g. 'A1:C10'). If omitted, gets all formulas."),
  }),
  async handler({ google }, { spreadsheet_id, sheet, range }) {
    const fullRange = range ? `${sheet}!${range}` : sheet;
    const result = await google.sheets.valuesGet(spreadsheet_id, fullRange, { valueRenderOption: "FORMULA" });
    return result.values ?? [];
  },
});

export const getMultipleSheetData = defineTool({
  name: "get_multiple_sheet_data",
  title: "Get Multiple Sheet Data",
  readOnly: true,
  description:
    "Get data from multiple specific ranges in Google Spreadsheets in one call. Each query needs 'spreadsheet_id', 'sheet', and 'range'. Returns each query with its fetched 'data' or an 'error'.",
  inputSchema: z.object({
    queries: z
      .array(z.record(z.string(), z.string()))
      .describe("List of objects with 'spreadsheet_id', 'sheet', and 'range' keys."),
  }),
  handler({ google }, { queries }) {
    return Promise.all(
      queries.map(async (query): Promise<Record<string, unknown>> => {
        const { spreadsheet_id, sheet, range } = query;
        if (!spreadsheet_id || !sheet || !range) {
          return { ...query, error: "Missing required keys (spreadsheet_id, sheet, range)" };
        }
        try {
          const result = await google.sheets.valuesGet(spreadsheet_id, `${sheet}!${range}`);
          return { ...query, data: result.values ?? [] };
        } catch (error) {
          return { ...query, error: errorMessage(error) };
        }
      }),
    );
  },
});

export const getMultipleSpreadsheetSummary = defineTool({
  name: "get_multiple_spreadsheet_summary",
  title: "Get Multiple Spreadsheet Summary",
  readOnly: true,
  description:
    "Get a summary of multiple Google Spreadsheets: title, sheet names, headers, and the first few rows of each sheet.",
  inputSchema: z.object({
    spreadsheet_ids: z.array(z.string()).describe("Spreadsheet IDs to summarize."),
    rows_to_fetch: z
      .number()
      .int()
      .default(5)
      .describe("Number of rows (including header) to fetch for the summary (default 5)."),
  }),
  handler({ google }, { spreadsheet_ids, rows_to_fetch }) {
    const maxRow = Math.max(1, rows_to_fetch);

    const summariseSheet = async (id: string, sheet: { properties?: { title?: string; sheetId?: number } }) => {
      const title = sheet.properties?.title;
      const sheetSummary: Record<string, unknown> = {
        title,
        sheet_id: sheet.properties?.sheetId,
        headers: [],
        first_rows: [],
        error: null,
      };
      if (!title) {
        sheetSummary.error = "Sheet title not found";
        return sheetSummary;
      }
      try {
        const result = await google.sheets.valuesGet(id, `${title}!A1:${maxRow}`);
        const values = result.values ?? [];
        if (values.length > 0) {
          sheetSummary.headers = values[0];
          if (values.length > 1) sheetSummary.first_rows = values.slice(1, maxRow);
        }
      } catch (error) {
        sheetSummary.error = `Error fetching data for sheet ${title}: ${errorMessage(error)}`;
      }
      return sheetSummary;
    };

    return Promise.all(
      spreadsheet_ids.map(async (id): Promise<Record<string, unknown>> => {
        const summary: Record<string, unknown> = { spreadsheet_id: id, title: null, sheets: [], error: null };
        try {
          const spreadsheet = await google.sheets.get(id, { fields: "properties.title,sheets(properties(title,sheetId))" });
          summary.title = spreadsheet.properties?.title ?? "Unknown Title";
          summary.sheets = await Promise.all((spreadsheet.sheets ?? []).map((sheet) => summariseSheet(id, sheet)));
        } catch (error) {
          summary.error = `Error fetching spreadsheet ${id}: ${errorMessage(error)}`;
        }
        return summary;
      }),
    );
  },
});

export const listSheets = defineTool({
  name: "list_sheets",
  title: "List Sheets",
  readOnly: true,
  description: "List all sheet/tab names in a Google Spreadsheet.",
  inputSchema: z.object({ spreadsheet_id: spreadsheetId }),
  async handler({ google }, { spreadsheet_id }) {
    const spreadsheet = await google.sheets.get(spreadsheet_id, { fields: "sheets(properties(title,sheetId))" });
    return (spreadsheet.sheets ?? []).map((sheet) => sheet.properties.title);
  },
});

export const findInSpreadsheet = defineTool({
  name: "find_in_spreadsheet",
  title: "Find Cells",
  readOnly: true,
  description:
    "Find cells containing a specific value in a Google Spreadsheet. Returns each match with its sheet, cell (A1 notation), and value.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    query: z.string().describe("The text to search for in cell values"),
    sheet: z.string().optional().describe("Optional sheet name to search in. If omitted, searches all sheets."),
    case_sensitive: z.boolean().default(false).describe("Whether the search is case-sensitive (default false)"),
    max_results: z.number().int().default(50).describe("Maximum number of results to return (default 50)"),
  }),
  async handler({ google }, { spreadsheet_id, query, sheet, case_sensitive, max_results }) {
    const results: Array<Record<string, unknown>> = [];
    try {
      const spreadsheet = await google.sheets.get(spreadsheet_id, { fields: "sheets(properties(title,sheetId))" });
      const sheetsToSearch = (spreadsheet.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((title): title is string => typeof title === "string" && (sheet === undefined || title === sheet));
      if (sheetsToSearch.length === 0) {
        return [{ error: sheet === undefined ? "No sheets found in spreadsheet" : `Sheet '${sheet}' not found` }];
      }
      const needle = case_sensitive ? query : query.toLowerCase();
      for (const name of sheetsToSearch) {
        if (results.length >= max_results) break;
        const response = await google.sheets.valuesGet(spreadsheet_id, name);
        const values = response.values ?? [];
        for (let rowIdx = 0; rowIdx < values.length && results.length < max_results; rowIdx++) {
          const row = values[rowIdx];
          for (let colIdx = 0; colIdx < row.length && results.length < max_results; colIdx++) {
            const value = row[colIdx];
            const cellStr = String(value);
            const compare = case_sensitive ? cellStr : cellStr.toLowerCase();
            if (compare.includes(needle)) {
              results.push({ sheet: name, cell: `${columnIndexToLetter(colIdx)}${rowIdx + 1}`, value });
            }
          }
        }
      }
      return results;
    } catch (error) {
      return [{ error: `Search failed: ${errorMessage(error)}` }];
    }
  },
});

// ---------------------------------------------------------------------------
// Sheets: writing
// ---------------------------------------------------------------------------

export const updateCells = defineTool({
  name: "update_cells",
  title: "Update Cells",
  readOnly: false,
  description: "Update cells in a Google Spreadsheet. Overwrites existing data in the range.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    range: z.string().describe("Cell range in A1 notation (e.g. 'A1:C10')"),
    data: grid.describe("2D array of values to write"),
  }),
  async handler({ google }, { spreadsheet_id, sheet, range, data }) {
    return google.sheets.valuesUpdate(spreadsheet_id, `${sheet}!${range}`, data, "USER_ENTERED");
  },
});

export const batchUpdateCells = defineTool({
  name: "batch_update_cells",
  title: "Batch Update Cells",
  readOnly: false,
  description:
    "Batch update multiple ranges in a Google Spreadsheet in one API call. 'ranges' maps A1 range strings to 2D arrays of values, e.g. {'A1:B2': [[1, 2], [3, 4]]}.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    ranges: z.record(z.string(), grid).describe("Mapping of A1 range strings to 2D arrays of values"),
  }),
  async handler({ google }, { spreadsheet_id, sheet, ranges }) {
    const data = Object.entries(ranges).map(([range, values]) => ({ range: `${sheet}!${range}`, values }));
    return google.sheets.valuesBatchUpdate(spreadsheet_id, { valueInputOption: "USER_ENTERED", data });
  },
});

async function insertDimension(
  deps: ToolDeps,
  spreadsheetId: string,
  sheet: string,
  dimension: "ROWS" | "COLUMNS",
  count: number,
  start: number | undefined,
) {
  const sheetId = await lookupSheetId(deps.google, spreadsheetId, sheet);
  if (sheetId === undefined) {
    return { error: `Sheet '${sheet}' not found` };
  }
  const startIndex = start ?? 0;
  return deps.google.sheets.batchUpdate(spreadsheetId, [
    {
      insertDimension: {
        range: { sheetId, dimension, startIndex, endIndex: startIndex + count },
        inheritFromBefore: start !== undefined && start > 0,
      },
    },
  ]);
}

export const addRows = defineTool({
  name: "add_rows",
  title: "Add Rows",
  readOnly: false,
  description: "Insert empty rows into a sheet at a 0-based row index (defaults to the beginning).",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    count: z.number().int().describe("Number of rows to add"),
    start_row: z.number().int().optional().describe("0-based row index to start adding. Defaults to 0."),
  }),
  handler: (deps, { spreadsheet_id, sheet, count, start_row }) =>
    insertDimension(deps, spreadsheet_id, sheet, "ROWS", count, start_row),
});

export const addColumns = defineTool({
  name: "add_columns",
  title: "Add Columns",
  readOnly: false,
  description: "Insert empty columns into a sheet at a 0-based column index (defaults to the beginning).",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    count: z.number().int().describe("Number of columns to add"),
    start_column: z.number().int().optional().describe("0-based column index to start adding. Defaults to 0."),
  }),
  handler: (deps, { spreadsheet_id, sheet, count, start_column }) =>
    insertDimension(deps, spreadsheet_id, sheet, "COLUMNS", count, start_column),
});

export const copySheet = defineTool({
  name: "copy_sheet",
  title: "Copy Sheet",
  readOnly: false,
  description: "Copy a sheet from one spreadsheet to another, renaming it to dst_sheet.",
  inputSchema: z.object({
    src_spreadsheet: z.string().describe("Source spreadsheet ID"),
    src_sheet: z.string().describe("Source sheet name"),
    dst_spreadsheet: z.string().describe("Destination spreadsheet ID"),
    dst_sheet: z.string().describe("Destination sheet name"),
  }),
  async handler({ google }, { src_spreadsheet, src_sheet, dst_spreadsheet, dst_sheet }) {
    const srcSheetId = await lookupSheetId(google, src_spreadsheet, src_sheet);
    if (srcSheetId === undefined) {
      return { error: `Source sheet '${src_sheet}' not found` };
    }
    const copy = await google.sheets.copyTo(src_spreadsheet, srcSheetId, dst_spreadsheet);
    if (copy.title !== undefined && copy.title !== dst_sheet) {
      const rename = await google.sheets.batchUpdate(dst_spreadsheet, [
        { updateSheetProperties: { properties: { sheetId: copy.sheetId, title: dst_sheet }, fields: "title" } },
      ]);
      return { copy, rename };
    }
    return { copy };
  },
});

export const renameSheet = defineTool({
  name: "rename_sheet",
  title: "Rename Sheet",
  readOnly: false,
  description: "Rename a sheet/tab in a Google Spreadsheet.",
  inputSchema: z.object({
    spreadsheet: z.string().describe("Spreadsheet ID"),
    sheet: z.string().describe("Current sheet name"),
    new_name: z.string().describe("New sheet name"),
  }),
  async handler({ google }, { spreadsheet, sheet, new_name }) {
    const sheetId = await lookupSheetId(google, spreadsheet, sheet);
    if (sheetId === undefined) {
      return { error: `Sheet '${sheet}' not found` };
    }
    return google.sheets.batchUpdate(spreadsheet, [
      { updateSheetProperties: { properties: { sheetId, title: new_name }, fields: "title" } },
    ]);
  },
});

export const createSheet = defineTool({
  name: "create_sheet",
  title: "Create Sheet",
  readOnly: false,
  description: "Create a new sheet tab in an existing Google Spreadsheet.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    title: z.string().describe("The title for the new sheet"),
  }),
  async handler({ google }, { spreadsheet_id, title }) {
    const result = await google.sheets.batchUpdate(spreadsheet_id, [{ addSheet: { properties: { title } } }]);
    const props = result.replies?.[0]?.addSheet?.properties ?? {};
    return { sheetId: props.sheetId, title: props.title, index: props.index, spreadsheetId: spreadsheet_id };
  },
});

export const batchUpdate = defineTool({
  name: "batch_update",
  title: "Batch Update",
  readOnly: false,
  description:
    "Execute a batch update on a Google Spreadsheet using the full batchUpdate endpoint. Each request may be any valid batchUpdate operation: addSheet, updateSheetProperties, insertDimension, deleteDimension, updateCells, repeatCell, updateBorders, addConditionalFormatRule, updateDimensionProperties, and more. Returns the replies for each request.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    requests: z.array(z.record(z.string(), z.unknown())).describe("List of batchUpdate request objects"),
  }),
  async handler({ google }, { spreadsheet_id, requests }) {
    if (requests.length === 0) {
      return { error: "requests list cannot be empty" };
    }
    return google.sheets.batchUpdate(spreadsheet_id, requests);
  },
});

const CHART_TYPES = ["COLUMN", "BAR", "LINE", "AREA", "PIE", "SCATTER", "COMBO", "HISTOGRAM"] as const;

export const addChart = defineTool({
  name: "add_chart",
  title: "Add Chart",
  readOnly: false,
  description:
    "Add a floating chart to a sheet from a data range. Supported chart_type values: COLUMN, BAR, LINE, AREA, PIE, SCATTER, COMBO, HISTOGRAM. The first column of data_range is the domain (labels) and the first row is treated as headers.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    sheet: sheetName,
    chart_type: z.string().describe("COLUMN, BAR, LINE, AREA, PIE, SCATTER, COMBO, or HISTOGRAM"),
    data_range: z.string().describe("A1 notation range for chart data (e.g. 'A1:C10')"),
    title: z.string().optional().describe("Optional chart title"),
    x_axis_label: z.string().optional().describe("Optional label for the X (bottom) axis"),
    y_axis_label: z.string().optional().describe("Optional label for the Y (left) axis"),
    position_x: z.number().int().default(0).describe("Horizontal offset in pixels from the top-left corner"),
    position_y: z.number().int().default(0).describe("Vertical offset in pixels from the top-left corner"),
    width: z.number().int().default(600).describe("Chart width in pixels"),
    height: z.number().int().default(400).describe("Chart height in pixels"),
  }),
  async handler({ google }, args) {
    const chartType = args.chart_type.toUpperCase();
    if (!(CHART_TYPES as readonly string[]).includes(chartType)) {
      return { error: `Invalid chart type '${args.chart_type}'. Must be one of: ${CHART_TYPES.join(", ")}` };
    }
    const sheetId = await lookupSheetId(google, args.spreadsheet_id, args.sheet);
    if (sheetId === undefined) {
      return { error: `Sheet '${args.sheet}' not found in spreadsheet` };
    }
    let rangeIndices;
    try {
      rangeIndices = parseA1Notation(args.data_range);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    const sourceRange: GridRange = { sheetId, ...rangeIndices };
    const [domainRange, seriesRanges] = splitChartSourceRanges(sourceRange);

    let spec: Record<string, unknown>;
    if (chartType === "PIE") {
      spec = {
        pieChart: {
          legendPosition: "RIGHT_LEGEND",
          domain: { sourceRange: { sources: [domainRange] } },
          series: { sourceRange: { sources: [seriesRanges[0]] } },
        },
      };
    } else {
      const axis: Array<Record<string, unknown>> = [
        args.x_axis_label ? { position: "BOTTOM_AXIS", title: args.x_axis_label } : { position: "BOTTOM_AXIS" },
        args.y_axis_label ? { position: "LEFT_AXIS", title: args.y_axis_label } : { position: "LEFT_AXIS" },
      ];
      spec = {
        basicChart: {
          chartType,
          legendPosition: "RIGHT_LEGEND",
          axis,
          domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
          series: seriesRanges.map((range) => ({
            series: { sourceRange: { sources: [range] } },
            targetAxis: "LEFT_AXIS",
          })),
          headerCount: 1,
        },
      };
    }
    if (args.title) spec.title = args.title;

    const request = {
      addChart: {
        chart: {
          spec,
          position: {
            overlayPosition: {
              anchorCell: { sheetId, rowIndex: 0, columnIndex: 0 },
              offsetXPixels: args.position_x,
              offsetYPixels: args.position_y,
              widthPixels: args.width,
              heightPixels: args.height,
            },
          },
        },
      },
    };

    try {
      const result = await google.sheets.batchUpdate(args.spreadsheet_id, [request]);
      return {
        success: true,
        message: `Chart '${args.title || chartType}' added successfully`,
        chartId: result.replies?.[0]?.addChart?.chart?.chartId,
        result,
      };
    } catch (error) {
      return { error: `Failed to add chart: ${errorMessage(error)}` };
    }
  },
});

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export const createSpreadsheet = defineTool({
  name: "create_spreadsheet",
  title: "Create Spreadsheet",
  readOnly: false,
  description:
    "Create a new Google Spreadsheet. If folder_id is omitted, uses the configured default folder or creates in the root.",
  inputSchema: z.object({
    title: z.string().describe("The title of the new spreadsheet"),
    folder_id: z.string().optional().describe("Optional Google Drive folder ID to create the spreadsheet in"),
  }),
  async handler({ google, folderId }, { title, folder_id }) {
    const targetFolderId = folder_id || folderId;
    const body: Record<string, unknown> = { name: title, mimeType: SPREADSHEET_MIME };
    if (targetFolderId) body.parents = [targetFolderId];
    const file = await google.drive.filesCreate(body, { supportsAllDrives: true, fields: "id, name, parents" });
    console.info(`Spreadsheet created with ID: ${file.id}${targetFolderId ? ` in folder ${targetFolderId}` : " in root"}`);
    return {
      spreadsheetId: file.id,
      title: file.name ?? title,
      folder: file.parents?.[0] ?? "root",
    };
  },
});

export const listSpreadsheets = defineTool({
  name: "list_spreadsheets",
  title: "List Spreadsheets",
  readOnly: true,
  description:
    "List spreadsheets in a Google Drive folder. If folder_id is omitted, uses the configured default folder or lists everything the account can access.",
  inputSchema: z.object({
    folder_id: z.string().optional().describe("Optional Google Drive folder ID to search in"),
  }),
  async handler({ google, folderId }, { folder_id }) {
    const targetFolderId = folder_id || folderId;
    let q = `mimeType='${SPREADSHEET_MIME}'`;
    if (targetFolderId) q += ` and '${escapeDriveQuery(targetFolderId)}' in parents`;
    const result = await google.drive.filesList({
      q,
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "files(id, name)",
      orderBy: "modifiedTime desc",
    });
    return (result.files ?? []).map((file) => ({ id: file.id, title: file.name }));
  },
});

export const listFolders = defineTool({
  name: "list_folders",
  title: "List Folders",
  readOnly: true,
  description:
    "List folders in a Google Drive folder. If parent_folder_id is omitted, lists folders in the root of 'My Drive'.",
  inputSchema: z.object({
    parent_folder_id: z.string().optional().describe("Optional Google Drive folder ID to search within"),
  }),
  async handler({ google }, { parent_folder_id }) {
    let q = `mimeType='${FOLDER_MIME}'`;
    q += parent_folder_id ? ` and '${escapeDriveQuery(parent_folder_id)}' in parents` : " and 'root' in parents";
    const result = await google.drive.filesList({
      q,
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "files(id, name, parents)",
      orderBy: "name",
    });
    return (result.files ?? []).map((folder) => ({
      id: folder.id,
      name: folder.name,
      parent: folder.parents?.[0] ?? "root",
    }));
  },
});

export const searchSpreadsheets = defineTool({
  name: "search_spreadsheets",
  title: "Search Spreadsheets by Name or Content",
  readOnly: true,
  description: "Search Google Drive for spreadsheets whose name or content matches a query.",
  inputSchema: z.object({
    query: z.string().describe("Search text, matched against file name and full text (e.g. 'budget 2024')"),
    max_results: z.number().int().default(20).describe("Maximum number of results (default 20, max 100)"),
  }),
  async handler({ google }, { query, max_results }) {
    const pageSize = Math.min(Math.max(1, max_results), 100);
    const escaped = escapeDriveQuery(query);
    const q = `mimeType='${SPREADSHEET_MIME}' and (name contains '${escaped}' or fullText contains '${escaped}')`;
    try {
      const result = await google.drive.filesList({
        q,
        pageSize,
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: "files(id, name, createdTime, modifiedTime, owners, webViewLink)",
        orderBy: "modifiedTime desc",
      });
      return (result.files ?? []).map((file) => ({
        id: file.id,
        name: file.name,
        created_time: file.createdTime,
        modified_time: file.modifiedTime,
        owners: (file.owners ?? []).map((owner) => owner.emailAddress),
        web_link: file.webViewLink,
      }));
    } catch (error) {
      return [{ error: `Search failed: ${errorMessage(error)}` }];
    }
  },
});

const SHARE_ROLES = ["reader", "commenter", "writer"];

export const shareSpreadsheet = defineTool({
  name: "share_spreadsheet",
  title: "Share Spreadsheet",
  readOnly: false,
  description:
    "Share a spreadsheet with users by email. Each recipient needs 'email_address' and 'role' (reader, commenter, or writer). Returns 'successes' and 'failures'.",
  inputSchema: z.object({
    spreadsheet_id: spreadsheetId,
    recipients: z
      .array(z.record(z.string(), z.string()))
      .describe("List of objects with 'email_address' and 'role' keys"),
    send_notification: z.boolean().default(true).describe("Whether to send a notification email (default true)"),
  }),
  async handler({ google }, { spreadsheet_id, recipients, send_notification }) {
    const successes: Array<Record<string, unknown>> = [];
    const failures: Array<Record<string, unknown>> = [];
    for (const recipient of recipients) {
      const emailAddress = recipient.email_address;
      const role = recipient.role ?? "writer";
      if (!emailAddress) {
        failures.push({ email_address: null, error: "Missing email_address in recipient entry." });
        continue;
      }
      if (!SHARE_ROLES.includes(role)) {
        failures.push({
          email_address: emailAddress,
          error: `Invalid role '${role}'. Must be 'reader', 'commenter', or 'writer'.`,
        });
        continue;
      }
      try {
        const result = await google.drive.permissionsCreate(
          spreadsheet_id,
          { type: "user", role, emailAddress },
          { sendNotificationEmail: send_notification, fields: "id" },
        );
        successes.push({ email_address: emailAddress, role, permissionId: result.id });
      } catch (error) {
        failures.push({ email_address: emailAddress, error: `Failed to share: ${errorMessage(error)}` });
      }
    }
    return { successes, failures };
  },
});

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export async function getSpreadsheetInfo({ google }: ToolDeps, spreadsheetId: string) {
  const spreadsheet = await google.sheets.get(spreadsheetId);
  return {
    title: spreadsheet.properties?.title ?? "Unknown",
    sheets: (spreadsheet.sheets ?? []).map((sheet) => ({
      title: sheet.properties.title,
      sheetId: sheet.properties.sheetId,
      gridProperties: sheet.properties.gridProperties ?? {},
    })),
  };
}

/** Every tool, in the order they are registered. */
export const TOOLS: ToolDefinition[] = [
  getSheetData,
  getSheetFormulas,
  updateCells,
  batchUpdateCells,
  addRows,
  addColumns,
  listSheets,
  copySheet,
  renameSheet,
  getMultipleSheetData,
  getMultipleSpreadsheetSummary,
  createSpreadsheet,
  createSheet,
  listSpreadsheets,
  shareSpreadsheet,
  listFolders,
  searchSpreadsheets,
  findInSpreadsheet,
  batchUpdate,
  addChart,
];

export const TOOL_NAMES: string[] = TOOLS.map((tool) => tool.name);
