/**
 * Cloudflare Worker entry point.
 *
 *   GET     /, /health                              health check (no auth)
 *   GET     /.well-known/oauth-authorization-server OAuth metadata (RFC 8414)
 *   GET     /.well-known/oauth-protected-resource   resource metadata (RFC 9728)
 *   POST    /register                               dynamic client registration
 *   GET/POST /authorize, GET /callback              consent page + Google sign-in (src/oauth.ts)
 *   POST    /token                                  token endpoint
 *   OPTIONS /mcp                                    CORS preflight (no auth; carries no data)
 *   POST    /mcp                                    MCP endpoint (OAuth access token or MCP_AUTH_TOKEN)
 */
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { parseEnabledTools, parseHostnames, type Env } from "./env";
import { errorMessage, parseServiceAccount, ServiceAccountTokenProvider, type FetchLike } from "./google/auth";
import { GoogleClient } from "./google/client";
import { checkClientRegistration, handleAuthorization, LOOPBACK_HOSTS } from "./oauth";
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

/** Thrown when a secret the request depends on is unset; answered with 503. */
class ConfigurationError extends Error {}

/**
 * Accept the static MCP_AUTH_TOKEN (Claude Code, mcp-remote) alongside OAuth
 * access tokens. Called by the provider only for tokens it did not issue.
 */
async function resolveStaticToken(token: string, env: Env, resource: string) {
  if (!env.MCP_AUTH_TOKEN) {
    console.error("MCP_AUTH_TOKEN secret is not configured; refusing static bearer token");
    throw new ConfigurationError("MCP_AUTH_TOKEN is missing");
  }
  if (!(await secureEquals(token, env.MCP_AUTH_TOKEN))) return null;
  return { props: { auth: "static" }, audience: resource };
}

async function serveMcp(request: Request, env: Env, ctx: ExecutionContext, options: RuntimeOptions): Promise<Response> {
  const mcpPath = env.MCP_PATH || DEFAULT_MCP_PATH;
  if (request.method !== "OPTIONS") {
    try {
      // Fail fast on a missing or malformed service-account secret before
      // handing off to the MCP transport. The server itself is built once,
      // inside the factory, per request.
      getTokenProvider(env, options);
    } catch (error) {
      console.error(`MCP server configuration error: ${errorMessage(error)}`);
      return json({ error: `Server is not configured: ${errorMessage(error)}` }, 503);
    }
  }
  const handler = createMcpHandler(() => createServerFromEnv(env, options), {
    route: mcpPath,
    allowedHostnames: parseHostnames(env.MCP_ALLOWED_HOSTNAMES),
    onerror: (error) => console.error(`MCP handler error: ${errorMessage(error)}`),
  });
  return handler(request, env, ctx);
}

/**
 * Options for the OAuth provider wrapping this Worker. The protected resource
 * is the MCP endpoint on the origin the request arrived at, so the same build
 * serves workers.dev, a custom domain, and localhost.
 */
export function oauthOptions(env: Env, url: URL, options: RuntimeOptions): OAuthProviderOptions<Env> {
  const mcpPath = env.MCP_PATH || DEFAULT_MCP_PATH;
  const resource = `${url.origin}${mcpPath}`;
  return {
    apiRoute: mcpPath,
    apiHandler: { fetch: (request, env, ctx) => serveMcp(request as Request, env, ctx, options) },
    defaultHandler: {
      fetch: async (request, env) =>
        (await handleAuthorization(request as Request, env, options.fetch ?? fetch)) ?? json({ error: "Not found" }, 404),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientRegistrationCallback: checkClientRegistration,
    resolveExternalToken: ({ token, env }) => resolveStaticToken(token, env, resource),
    resourceMetadata: { resource, authorization_servers: [url.origin], resource_name: SERVER_NAME },
  };
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
  // OAuth resources must be https except on loopback; refuse rather than crash.
  if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return json({ error: "HTTPS is required" }, 400);
  }
  if (!env.OAUTH_KV) {
    console.error("OAUTH_KV binding is not configured; refusing request");
    return json({ error: "Server is not configured: OAUTH_KV binding is missing" }, 503);
  }

  try {
    // The library caches its helpers on env.OAUTH_PROVIDER, and Workers reuse
    // one env object across requests in an isolate. Hand it a per-request copy
    // so the helpers are bound to this request's origin.
    const requestEnv: Env = { ...env, OAUTH_PROVIDER: undefined };
    return await new OAuthProvider<Env>(oauthOptions(env, url, options)).fetch(request, requestEnv, ctx);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return json({ error: `Server is not configured: ${error.message}` }, 503);
    }
    throw error;
  }
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
