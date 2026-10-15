/**
 * Builds the MCP server: registers the tools (honouring ENABLED_TOOLS) and
 * the spreadsheet info resource.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { errorMessage } from "./google/auth";
import { getSpreadsheetInfo, TOOLS, type ToolDeps } from "./tools";

export const SERVER_NAME = "Google Spreadsheet";
export const SERVER_VERSION = "1.0.0";

export interface CreateServerOptions {
  deps: ToolDeps;
  /** null enables every tool. */
  enabledTools: Set<string> | null;
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export function createServer({ deps, enabledTools }: CreateServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of TOOLS) {
    if (enabledTools !== null && !enabledTools.has(tool.name)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.readOnly ? { readOnlyHint: true } : { destructiveHint: true },
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(deps, args);
          return { content: [{ type: "text" as const, text: formatResult(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error executing tool ${tool.name}: ${errorMessage(error)}` }],
          };
        }
      },
    );
  }

  server.registerResource(
    "spreadsheet_info",
    new ResourceTemplate("spreadsheet://{spreadsheet_id}/info", { list: undefined }),
    {
      title: "Spreadsheet Info",
      description: "Basic information about a Google Spreadsheet: title and sheets.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const spreadsheetId = String(variables.spreadsheet_id ?? "");
      const info = await getSpreadsheetInfo(deps, spreadsheetId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(info, null, 2) }],
      };
    },
  );

  return server;
}
