/** Helpers for driving the MCP Streamable HTTP endpoint in tests. */

export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcRequest(
  method: string,
  params: unknown = {},
  { id = 1, token, url = "http://localhost/mcp" }: { id?: number; token?: string; url?: string } = {},
): Request {
  const headers: Record<string, string> = {
    // Requests constructed inside the Workers test runtime carry no Host
    // header, but the MCP handler validates it.
    host: new URL(url).host,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

export function initializeParams() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  };
}

/** Parse a JSON or SSE-framed JSON-RPC response body, returning the last message. */
export async function readRpc(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as JsonRpcResponse);
    if (messages.length === 0) throw new Error(`No SSE data frames in response: ${text}`);
    return messages[messages.length - 1];
  }
  if (!text) throw new Error(`Empty response body (status ${response.status})`);
  return JSON.parse(text) as JsonRpcResponse;
}

/** Extract the JSON payload from a tools/call text result. */
export function toolJson(result: any): any {
  const text = result?.content?.find((block: any) => block.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`No text content in tool result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}
