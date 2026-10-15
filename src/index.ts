/**
 * Cloudflare Worker entry point.
 *
 *   GET  /            health check (no auth)
 *   POST /mcp         MCP Streamable HTTP endpoint (bearer token required)
 */
import { createMcpHandler } from "agents/mcp/server";
import { parseEnabledTools, parseHostnames, type Env } from "./env";
import { errorMessage, parseServiceAccount, ServiceAccountTokenProvider, type FetchLike } from "./google/auth";
import { GoogleClient } from "./google/client";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";

const DEFAULT_MCP_PATH = "/mcp";

/** Token providers are cached per isolate so access tokens are reused across requests. */
const providerCache = new Map<string, ServiceAccountTokenProvider>();

export interface RuntimeOptions {
  /** Override outbound fetch (used by tests). */
  fetch?: FetchLike;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function getTokenProvider(env: Env, options: RuntimeOptions = {}): ServiceAccountTokenProvider {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.CREDENTIALS_CONFIG;
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured");
  }
  const cached = providerCache.get(raw);
  if (cached && !options.fetch) return cached;
  const provider = new ServiceAccountTokenProvider(parseServiceAccount(raw), { fetch: options.fetch });
  if (!options.fetch) providerCache.set(raw, provider);
  return provider;
}

/** Build a fresh MCP server bound to this Worker's configuration. */
export function createServerFromEnv(env: Env, options: RuntimeOptions = {}) {
  const provider = getTokenProvider(env, options);
  const google = new GoogleClient({ getAccessToken: () => provider.getAccessToken(), fetch: options.fetch });
  return createServer({
    deps: { google, folderId: env.DRIVE_FOLDER_ID || undefined },
    enabledTools: parseEnabledTools(env.ENABLED_TOOLS),
  });
}

async function secureEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

/** Returns a Response when the request must be rejected, otherwise null. */
export async function checkBearerAuth(request: Request, expectedToken: string | undefined): Promise<Response | null> {
  if (!expectedToken) {
    console.error("MCP_AUTH_TOKEN secret is not configured; refusing request");
    return json({ error: "Server is not configured: MCP_AUTH_TOKEN is missing" }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !(await secureEquals(match[1], expectedToken))) {
    return json({ error: "Unauthorized" }, 401, { "www-authenticate": 'Bearer realm="mcp"' });
  }
  return null;
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: RuntimeOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const mcpPath = env.MCP_PATH || DEFAULT_MCP_PATH;

  if (url.pathname === "/" || url.pathname === "/health") {
    return json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, endpoint: mcpPath });
  }
  if (url.pathname !== mcpPath) {
    return json({ error: "Not found" }, 404);
  }

  const rejected = await checkBearerAuth(request, env.MCP_AUTH_TOKEN);
  if (rejected) return rejected;

  let factory: () => ReturnType<typeof createServerFromEnv>;
  try {
    // Fail fast on misconfiguration before handing off to the MCP transport.
    createServerFromEnv(env, options);
    factory = () => createServerFromEnv(env, options);
  } catch (error) {
    console.error(`MCP server configuration error: ${errorMessage(error)}`);
    return json({ error: `Server is not configured: ${errorMessage(error)}` }, 503);
  }

  const handler = createMcpHandler(factory, {
    route: mcpPath,
    allowedHostnames: parseHostnames(env.MCP_ALLOWED_HOSTNAMES),
    onerror: (error) => console.error(`MCP handler error: ${errorMessage(error)}`),
  });
  return handler(request, env, ctx);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
