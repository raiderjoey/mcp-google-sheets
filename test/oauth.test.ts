import { createExecutionContext, env as bindings, waitOnExecutionContext } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleRequest, oauthOptions } from "../src/index";
import { isAllowedRedirectUri } from "../src/oauth";
import { initializeParams, readRpc, rpcRequest } from "./helpers/mcp";
import { generateServiceAccount } from "./helpers/service-account";

const ORIGIN = "http://localhost";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const OWNER = "owner@example.com";
const STATIC_TOKEN = "static-bearer-token";

let baseEnv: Env;

beforeAll(async () => {
  const { key } = await generateServiceAccount();
  baseEnv = {
    MCP_AUTH_TOKEN: STATIC_TOKEN,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key),
    MCP_PATH: "/mcp",
    OAUTH_KV: (bindings as unknown as Env).OAUTH_KV,
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    ALLOWED_EMAIL: OWNER,
  };
});

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An ID token as Google's token endpoint returns it (the signature is not checked over TLS). */
function idToken(claims: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.sig`;
}

interface GoogleIdentity {
  email: string;
  /** Replace Google's token response entirely (e.g. a non-JSON error page). */
  rawTokenResponse?: () => Response;
  email_verified?: boolean;
  aud?: string;
  iss?: string;
}

/** Fake Google: the OIDC token endpoint (authorization_code) and the service-account token endpoint. */
function fakeGoogle(identity: GoogleIdentity, seen: { nonce?: string; exchanges: URLSearchParams[] }) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("grant_type") === "authorization_code") {
        seen.exchanges.push(body);
        if (identity.rawTokenResponse) return identity.rawTokenResponse();
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          access_token: "google-user-access-token",
          id_token: idToken({
            iss: identity.iss ?? "https://accounts.google.com",
            aud: identity.aud ?? baseEnv.GOOGLE_OAUTH_CLIENT_ID,
            sub: "1234567890",
            email: identity.email,
            email_verified: identity.email_verified ?? true,
            nonce: seen.nonce,
            iat: now,
            exp: now + 3600,
          }),
        });
      }
      return Response.json({ access_token: "service-account-access-token", expires_in: 3600 });
    }
    return Response.json({ error: { message: `unexpected fetch ${input}` } }, { status: 500 });
  };
}

async function run(request: Request, env: Env = baseEnv, fetchImpl?: ReturnType<typeof fakeGoogle>) {
  const ctx = createExecutionContext();
  const response = await handleRequest(request, env, ctx, fetchImpl ? { fetch: fetchImpl } : {});
  await waitOnExecutionContext(ctx);
  return response;
}

/** Minimal cookie jar: the consent and upstream helpers bind each step to the browser with cookies. */
class Jar {
  private cookies = new Map<string, string>();
  store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function register(redirectUris: string[]) {
  return run(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
    }),
  );
}

async function pkce() {
  const verifier = base64url(crypto.randomUUID() + crypto.randomUUID());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

function authorizeUrl(clientId: string, redirectUri: string, challenge: string, origin = ORIGIN) {
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${origin}/mcp`,
  }).toString();
  return url.toString();
}

/**
 * Drive the browser leg: consent page, approve, Google redirect, callback.
 * Returns the final response from /callback.
 */
async function authorizeAs(identity: GoogleIdentity, clientId: string, challenge: string, redirectUri = CLAUDE_CALLBACK) {
  const jar = new Jar();
  const consent = await run(new Request(authorizeUrl(clientId, redirectUri, challenge)));
  expect(consent.status).toBe(200);
  jar.store(consent);
  const page = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
  expect(handle).toBeTruthy();

  const approve = await run(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ handle: handle!, decision: "approve" }).toString(),
    }),
  );
  expect(approve.status).toBe(302);
  jar.store(approve);
  const google = new URL(approve.headers.get("location")!);
  expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");

  const seen: { nonce?: string; exchanges: URLSearchParams[] } = { nonce: google.searchParams.get("nonce") ?? undefined, exchanges: [] };
  const callback = await run(
    new Request(`${ORIGIN}/callback?code=google-code&state=${encodeURIComponent(google.searchParams.get("state")!)}`, {
      headers: { cookie: jar.header() },
    }),
    baseEnv,
    fakeGoogle(identity, seen),
  );
  return { google, callback, seen, page };
}

describe("redirect URI allowlist", () => {
  it("allows only claude.ai's connector callback and loopback addresses", () => {
    expect(isAllowedRedirectUri(CLAUDE_CALLBACK)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:8080/cb")).toBe(true);

    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback/extra")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(isAllowedRedirectUri("http://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://localhost.evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://user@localhost/cb")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describe("discovery metadata", () => {
  it("serves authorization server metadata", async () => {
    const response = await run(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
    });
    expect(metadata.code_challenge_methods_supported).toContain("S256");
  });

  it("serves protected resource metadata for the MCP endpoint", async () => {
    const response = await run(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });
});

describe("dynamic client registration", () => {
  it("registers a client with claude.ai's callback", async () => {
    const response = await register([CLAUDE_CALLBACK]);
    expect(response.status).toBe(201);
    const client = (await response.json()) as { client_id: string; redirect_uris: string[] };
    expect(client.client_id).toBeTruthy();
    expect(client.redirect_uris).toEqual([CLAUDE_CALLBACK]);
  });

  it("rejects a registration with any redirect URI outside the allowlist", async () => {
    const response = await register([CLAUDE_CALLBACK, "https://evil.example/callback"]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });
});

describe("authorization", () => {
  it("round-trips authorize → Google sign-in → token, and the token opens /mcp", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { verifier, challenge } = await pkce();
    const { google, callback, seen, page } = await authorizeAs({ email: OWNER }, client.client_id, challenge);

    // The consent page names the client and where the tokens go.
    expect(page).toContain("Claude");
    expect(page).toContain("claude.ai");

    // Google is asked for the owner's identity only, with PKCE and a nonce,
    // and the redirect does not reveal which account is allowed.
    expect(google.searchParams.get("client_id")).toBe(baseEnv.GOOGLE_OAUTH_CLIENT_ID);
    expect(google.searchParams.has("login_hint")).toBe(false);
    expect(google.toString()).not.toContain(encodeURIComponent(OWNER));
    expect(google.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(google.searchParams.get("scope")).toBe("openid email");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("nonce")).toBeTruthy();
    expect(seen.exchanges).toHaveLength(1);
    expect(seen.exchanges[0].get("code")).toBe("google-code");
    expect(seen.exchanges[0].get("code_verifier")).toBeTruthy();

    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("state")).toBe("client-state");
    const code = back.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await run(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: CLAUDE_CALLBACK,
          client_id: client.client_id,
          code_verifier: verifier,
          resource: `${ORIGIN}/mcp`,
        }).toString(),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");

    const mcp = await run(rpcRequest("initialize", initializeParams(), { token: tokens.access_token }));
    expect(mcp.status).toBe(200);
    expect((await readRpc(mcp)).result.serverInfo.name).toBe("Google Spreadsheet");
  });

  it("refuses a Google account other than ALLOWED_EMAIL and issues no code", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const { callback } = await authorizeAs({ email: "someone-else@example.com" }, client.client_id, challenge);
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("refuses the right email when Google has not verified it", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const { callback } = await authorizeAs({ email: OWNER, email_verified: false }, client.client_id, challenge);
    expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses an ID token minted for another Google client", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const { callback } = await authorizeAs({ email: OWNER, aud: "someone-elses-client" }, client.client_id, challenge);
    expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("treats a non-JSON answer from Google's token endpoint as a refused sign-in", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const { callback } = await authorizeAs(
      { email: OWNER, rawTokenResponse: () => new Response("<html>oops</html>", { headers: { "content-type": "text/html" } }) },
      client.client_id,
      challenge,
    );
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("serves /authorize on a second hostname after a first one through the same env", async () => {
    // Workers reuse one env object across requests in an isolate; each request
    // must still get helpers bound to its own origin's resource.
    const env = { ...baseEnv };
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const first = await run(new Request(authorizeUrl(client.client_id, CLAUDE_CALLBACK, challenge, "http://localhost")), env);
    expect(first.status).toBe(200);
    const second = await run(new Request(authorizeUrl(client.client_id, CLAUDE_CALLBACK, challenge, "http://127.0.0.1")), env);
    expect(second.status).toBe(200);
  });

  it("refuses plain http on a public hostname with a 400 instead of crashing", async () => {
    const response = await run(new Request("http://mcp.example.com/.well-known/oauth-authorization-server"));
    expect(response.status).toBe(400);
  });

  it("refuses at /authorize a client whose redirect URI is outside the allowlist, without redirecting", async () => {
    // Bypass DCR (which would refuse it) to prove /authorize checks independently.
    const api = getOAuthApi(oauthOptions(baseEnv, new URL(`${ORIGIN}/authorize`), {}), baseEnv);
    const client = await api.createClient({ redirectUris: ["https://evil.example/callback"], clientName: "Evil", tokenEndpointAuthMethod: "none" });
    const { challenge } = await pkce();
    const response = await run(new Request(authorizeUrl(client.clientId, "https://evil.example/callback", challenge)));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not start Google sign-in when the consent form is posted without its browser cookie", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    const consent = await run(new Request(authorizeUrl(client.client_id, CLAUDE_CALLBACK, challenge)));
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
    const forged = await run(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "approve" }).toString(),
      }),
    );
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
  });

  it("fails closed with 503 when the Google sign-in secrets are missing", async () => {
    const client = (await (await register([CLAUDE_CALLBACK])).json()) as { client_id: string };
    const { challenge } = await pkce();
    for (const missing of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "ALLOWED_EMAIL"] as const) {
      const response = await run(new Request(authorizeUrl(client.client_id, CLAUDE_CALLBACK, challenge)), { ...baseEnv, [missing]: undefined });
      expect(response.status, missing).toBe(503);
    }
  });

  it("fails closed with 503 when the OAUTH_KV binding is missing", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: STATIC_TOKEN }), { ...baseEnv, OAUTH_KV: undefined });
    expect(response.status).toBe(503);
  });
});

describe("protected MCP endpoint", () => {
  it("still accepts the static MCP_AUTH_TOKEN", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: STATIC_TOKEN }));
    expect(response.status).toBe(200);
  });

  it("challenges a request without a token with a pointer to the resource metadata", async () => {
    const response = await run(rpcRequest("initialize", initializeParams()));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("challenges a bad token the same way", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: "wrong" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("returns 503 for a static token when MCP_AUTH_TOKEN is unset", async () => {
    const response = await run(rpcRequest("initialize", initializeParams(), { token: STATIC_TOKEN }), { ...baseEnv, MCP_AUTH_TOKEN: undefined });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Server is not configured: MCP_AUTH_TOKEN is missing" });
  });

  it("keeps the health check unauthenticated", async () => {
    for (const path of ["/", "/health"]) {
      const response = await run(new Request(`${ORIGIN}${path}`));
      expect(response.status).toBe(200);
    }
  });
});
