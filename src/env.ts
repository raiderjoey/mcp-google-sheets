/** Bindings the Worker reads. Secrets are set with `wrangler secret put`. */
export interface Env {
  /** Service-account key JSON, raw or base64-encoded. */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** Alias kept for parity with the original server (base64 service-account JSON). */
  CREDENTIALS_CONFIG?: string;
  /** Shared bearer token MCP clients must present. */
  MCP_AUTH_TOKEN?: string;
  /** Default Google Drive folder ID for list/create operations. */
  DRIVE_FOLDER_ID?: string;
  /** Comma-separated allow-list of tool names. Empty means all tools. */
  ENABLED_TOOLS?: string;
  /** Path the MCP endpoint is served on. Defaults to /mcp. */
  MCP_PATH?: string;
  /** Comma-separated hostnames allowed in the Host header (custom domains). */
  MCP_ALLOWED_HOSTNAMES?: string;
}

/**
 * Parse the ENABLED_TOOLS allow-list. Returns null when every tool should be
 * enabled, otherwise the set of enabled tool names.
 */
export function parseEnabledTools(value: string | undefined): Set<string> | null {
  if (!value) return null;
  const tools = new Set(
    value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  return tools.size > 0 ? tools : null;
}

export function parseHostnames(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : undefined;
}
