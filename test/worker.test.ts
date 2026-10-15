import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker, { handleRequest } from "../src/index";
import { TOOL_NAMES } from "../src/tools";
import { FakeGoogle } from "./helpers/fake-google";
import { initializeParams, readRpc, rpcRequest, toolJson } from "./helpers/mcp";
import { generateServiceAccount } from "./helpers/service-account";

const TOKEN = "top-secret-token";
let baseEnv: Env;

beforeAll(async () => {
  const { key } = await generateServiceAccount();
  baseEnv = { MCP_AUTH_TOKEN: TOKEN, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key), MCP_PATH: "/mcp" };
});

type IncomingRequest = Parameters<typeof worker.fetch>[0];

async function run(request: Request, env: Env = baseEnv) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as IncomingRequest, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("health and routing", () => {
  it("answers the health check without auth", async () => {
    const response = await run(new Request("http://localhost/"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", server: "Google Spreadsheet", version: "1.0.0", endpoint: "/mcp" });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await run(new Request("http://localhost/other", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(response.status).toBe(404);
  });
});

describe("bearer authentication", () => {
  it("rejects requests without a token", async () => {
    const response = await run(rpcRequest("initialize", initializeParams()));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: "nope" }));
    expect(response.status).toBe(401);
  });

  it("lets a CORS preflight through without a token so browser clients can proceed", async () => {
    const response = await run(
      new Request("http://localhost/mcp", {
        method: "OPTIONS",
        headers: {
          host: "localhost",
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );
    expect(response.status).not.toBe(401);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-allow-headers") ?? "").toMatch(/authorization/i);
  });

  it("fails closed when MCP_AUTH_TOKEN is not configured", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: TOKEN }), { ...baseEnv, MCP_AUTH_TOKEN: undefined });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Server is not configured: MCP_AUTH_TOKEN is missing" });
  });

  it("fails closed when Google credentials are missing or malformed", async () => {
    const missing = await run(rpcRequest("initialize", initializeParams(), { token: TOKEN }), { ...baseEnv, GOOGLE_SERVICE_ACCOUNT_JSON: undefined });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "Server is not configured: GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured" });

    const malformed = await run(rpcRequest("initialize", initializeParams(), { token: TOKEN }), { ...baseEnv, GOOGLE_SERVICE_ACCOUNT_JSON: "{oops" });
    expect(malformed.status).toBe(503);
  });
});

describe("MCP protocol", () => {
  it("initializes and reports server info", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: TOKEN }));
    expect(response.status).toBe(200);
    const message = await readRpc(response);
    expect(message.error).toBeUndefined();
    expect(message.result.serverInfo).toMatchObject({ name: "Google Spreadsheet", version: "1.0.0" });
    expect(message.result.capabilities.tools).toBeDefined();
    expect(message.result.capabilities.resources).toBeDefined();
  });

  it("lists every tool with annotations", async () => {
    const message = await readRpc(await run(rpcRequest("tools/list", {}, { token: TOKEN })));
    expect(message.error).toBeUndefined();
    const tools = message.result.tools as Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: any }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const getSheetData = tools.find((tool) => tool.name === "get_sheet_data")!;
    expect(getSheetData.annotations).toMatchObject({ readOnlyHint: true });
    expect(getSheetData.inputSchema.required).toEqual(["spreadsheet_id", "sheet"]);
    const updateCells = tools.find((tool) => tool.name === "update_cells")!;
    expect(updateCells.annotations).toMatchObject({ destructiveHint: true });
  });

  it("honours the ENABLED_TOOLS allow-list", async () => {
    const message = await readRpc(
      await run(rpcRequest("tools/list", {}, { token: TOKEN }), { ...baseEnv, ENABLED_TOOLS: "get_sheet_data, list_sheets" }),
    );
    expect(message.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["get_sheet_data", "list_sheets"]);
  });

  it("serves the MCP endpoint on a custom path", async () => {
    const env = { ...baseEnv, MCP_PATH: "/sheets" };
    const wrongPath = await run(rpcRequest("tools/list", {}, { token: TOKEN }), env);
    expect(wrongPath.status).toBe(404);
    const message = await readRpc(await run(rpcRequest("tools/list", {}, { token: TOKEN, url: "http://localhost/sheets" }), env));
    expect(message.result.tools).toHaveLength(TOOL_NAMES.length);
  });
});

describe("end to end against a fake Google backend", () => {
  function callWithFake(fake: FakeGoogle, request: Request, env: Env = baseEnv) {
    // Serve the OAuth token endpoint from the fake as well, so the real
    // service-account signing path is exercised.
    const fetchImpl: typeof fake.fetch = async (input, init) => {
      if (input === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "fake-access-token", expires_in: 3600 });
      }
      return fake.fetch(input, init);
    };
    return handleRequest(request, env, createExecutionContext(), { fetch: fetchImpl });
  }

  it("calls a tool and returns its JSON result as text", async () => {
    const fake = new FakeGoogle();
    fake.valuesByRange["Sheet1!A1:B2"] = [["a", "b"], ["c", "d"]];
    const response = await callWithFake(
      fake,
      rpcRequest("tools/call", { name: "get_sheet_data", arguments: { spreadsheet_id: "sid", sheet: "Sheet1", range: "A1:B2" } }, { token: TOKEN }),
    );
    const message = await readRpc(response);
    expect(message.error).toBeUndefined();
    expect(message.result.isError).toBeFalsy();
    expect(toolJson(message.result)).toEqual({
      spreadsheetId: "sid",
      valueRanges: [{ range: "Sheet1!A1:B2", values: [["a", "b"], ["c", "d"]] }],
    });
    const sheetsCall = fake.calls.find((call) => call.path.startsWith("/v4/"))!;
    expect(sheetsCall.path).toBe("/v4/spreadsheets/sid/values/Sheet1!A1:B2");
  });

  it("returns Google API failures as tool errors instead of protocol errors", async () => {
    const fake = new FakeGoogle();
    fake.override = () => Response.json({ error: { message: "The caller does not have permission" } }, { status: 403 });
    const message = await readRpc(
      await callWithFake(fake, rpcRequest("tools/call", { name: "list_sheets", arguments: { spreadsheet_id: "sid" } }, { token: TOKEN })),
    );
    expect(message.error).toBeUndefined();
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toBe("Error executing tool list_sheets: The caller does not have permission");
  });

  it("rejects invalid tool arguments", async () => {
    const fake = new FakeGoogle();
    const message = await readRpc(
      await callWithFake(fake, rpcRequest("tools/call", { name: "update_cells", arguments: { spreadsheet_id: "sid" } }, { token: TOKEN })),
    );
    // Either a JSON-RPC invalid-params error or an isError tool result is acceptable; what matters is no Google call was made.
    expect(message.error !== undefined || message.result?.isError === true).toBe(true);
    expect(fake.calls.filter((call) => call.path.startsWith("/v4/"))).toEqual([]);
  });

  it("reads the spreadsheet info resource", async () => {
    const fake = new FakeGoogle();
    const message = await readRpc(
      await callWithFake(fake, rpcRequest("resources/read", { uri: "spreadsheet://sid/info" }, { token: TOKEN })),
    );
    expect(message.error).toBeUndefined();
    const [content] = message.result.contents;
    expect(content.uri).toBe("spreadsheet://sid/info");
    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text)).toEqual({
      title: "Book",
      sheets: [
        { title: "Sheet1", sheetId: 123, gridProperties: { rowCount: 10, columnCount: 5 } },
        { title: "Data", sheetId: 456, gridProperties: {} },
      ],
    });
    expect(fake.lastCall.path).toBe("/v4/spreadsheets/sid");
  });

  it("lists the resource template", async () => {
    const fake = new FakeGoogle();
    const message = await readRpc(await callWithFake(fake, rpcRequest("resources/templates/list", {}, { token: TOKEN })));
    expect(message.result.resourceTemplates.map((t: { uriTemplate: string }) => t.uriTemplate)).toEqual(["spreadsheet://{spreadsheet_id}/info"]);
  });
});
