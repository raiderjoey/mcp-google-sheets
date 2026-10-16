import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Bindings the Worker reads. Secrets are set with `wrangler secret put`. */
export interface Env {
  /** KV namespace holding OAuth clients, grants and tokens. */
  OAUTH_KV?: KVNamespace;
  /** Injected by the OAuth provider into the default handler. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** Google OAuth client (Web application) used to sign the owner in at /authorize. */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** The only Google account allowed to complete /authorize. */
  ALLOWED_EMAIL?: string;
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

/** Split a comma-separated variable into trimmed, non-empty entries. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Parse the ENABLED_TOOLS allow-list. Returns null when every tool should be
 * enabled, otherwise the set of enabled tool names.
 */
export function parseEnabledTools(value: string | undefined): Set<string> | null {
  const tools = new Set(parseList(value));
  return tools.size > 0 ? tools : null;
}

export function parseHostnames(value: string | undefined): string[] | undefined {
  const names = parseList(value);
  return names.length > 0 ? names : undefined;
}
