/**
 * The interactive half of the OAuth authorization server: the consent page at
 * /authorize and the Google sign-in callback. The protocol endpoints
 * (metadata, /register, /token) are served by @cloudflare/workers-oauth-provider.
 *
 *   GET  /authorize  validate the client's request, show a consent page
 *   POST /authorize  on approval, send the browser to Google sign-in
 *   GET  /callback   exchange Google's code, admit only ALLOWED_EMAIL, issue our code
 */
import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ClientRegistrationCallbackOptions,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { errorMessage, type FetchLike } from "./google/auth";

/** claude.ai's custom-connector callback (also used by Desktop, mobile and Cowork). */
export const CLAUDE_CONNECTOR_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const CALLBACK_PATH = "/callback";

/**
 * Redirect URIs a client may register or use: claude.ai's connector callback,
 * exactly, and plain-http loopback on any port and path (Claude Code, MCP
 * Inspector, local testing). Anything else is refused.
 */
export function isAllowedRedirectUri(value: string): boolean {
  if (value === CLAUDE_CONNECTOR_CALLBACK) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;
}

/** Dynamic client registration hook: refuse any redirect URI outside the allowlist. */
export function checkClientRegistration({ clientMetadata }: ClientRegistrationCallbackOptions) {
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))) {
    return {
      code: "invalid_redirect_uri",
      description: `redirect_uris must be ${CLAUDE_CONNECTOR_CALLBACK} or a loopback http address`,
      status: 400,
    };
  }
}

interface GoogleSignInConfig {
  clientId: string;
  clientSecret: string;
  allowedEmail: string;
}

function googleSignInConfig(env: Env): GoogleSignInConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const allowedEmail = env.ALLOWED_EMAIL?.trim().toLowerCase();
  if (!clientId || !clientSecret || !allowedEmail) return null;
  return { clientId, clientSecret, allowedEmail };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on this computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  code { word-break: break-all; }
  button { font: inherit; padding: .5rem 1.25rem; margin-right: .5rem; }
</style>
<h1>Allow ${name} to use Google Sheets MCP?</h1>
<p>${origin}</p>
<p>It will be able to read and edit every spreadsheet shared with this server's service account.</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong><br><code>${escapeHtml(details.redirectUri)}</code></p>
${loopback}
<p>You'll sign in with Google next; only the owner's account is accepted.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>
</html>`;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

interface UpstreamData {
  verifier: string;
  nonce: string;
}

/**
 * Exchange Google's code and return the verified email, or null when the
 * identity is not acceptable. The ID token comes straight from Google's token
 * endpoint over TLS, authenticated with our client secret, so its signature
 * need not be re-verified (OIDC Core 3.1.3.7); the claims still are.
 */
async function signedInEmail(
  config: GoogleSignInConfig,
  code: string,
  data: UpstreamData,
  redirectUri: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: data.verifier,
    }).toString(),
  });
  if (!response.ok) {
    console.error(`Google code exchange failed with HTTP ${response.status}`);
    return null;
  }
  const body = (await response.json()) as { id_token?: unknown };
  const claims = typeof body.id_token === "string" ? decodeJwtPayload(body.id_token) : null;
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  const ok =
    GOOGLE_ISSUERS.has(String(claims.iss)) &&
    claims.aud === config.clientId &&
    claims.nonce === data.nonce &&
    typeof claims.exp === "number" &&
    claims.exp > now &&
    claims.email_verified === true &&
    typeof claims.email === "string";
  return ok ? (claims.email as string).toLowerCase() : null;
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

async function showConsent(oauth: OAuthHelpers, request: Request): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  // parseAuthRequest has already matched the redirect URI against the client's
  // registration; this also covers clients that did not come through /register.
  if (!isAllowedRedirectUri(authRequest.redirectUri)) {
    return textResponse("This app's redirect URI is not allowed by this server.", 400);
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("content-type", "text/html; charset=utf-8");
  consent.headers.set("cache-control", "no-store");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function submitConsent(oauth: OAuthHelpers, request: Request, config: GoogleSignInConfig, callbackUrl: string): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const data: UpstreamData = { verifier: randomToken(), nonce: randomToken() };
  const { state, headers } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
  const google = new URL(GOOGLE_AUTHORIZE_URL);
  google.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callbackUrl,
    scope: "openid email",
    state,
    nonce: data.nonce,
    code_challenge: await s256(data.verifier),
    code_challenge_method: "S256",
    login_hint: config.allowedEmail,
    prompt: "select_account",
  }).toString();
  return redirect(google.toString(), headers);
}

async function finishSignIn(
  oauth: OAuthHelpers,
  request: Request,
  config: GoogleSignInConfig,
  callbackUrl: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
  const code = new URL(request.url).searchParams.get("code");
  const email = code ? await signedInEmail(config, code, data, callbackUrl, fetchImpl) : null;
  if (email !== config.allowedEmail) {
    console.warn("Authorization refused: Google account is not the allowed owner");
    return redirect(authorizationErrorRedirect(original as AuthRequest, "access_denied"), headers);
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: email,
    metadata: { signedInAt: new Date().toISOString() },
    scope: original.scope,
    props: { email },
  });
  return redirect(redirectTo, headers);
}

/**
 * Handle /authorize and /callback. Returns null for any other path so the
 * caller can route it.
 */
export async function handleAuthorization(
  request: Request,
  env: Env,
  fetchImpl: FetchLike,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize" && url.pathname !== CALLBACK_PATH) return null;

  const config = googleSignInConfig(env);
  const oauth = env.OAUTH_PROVIDER;
  if (!config || !oauth) {
    console.error("Google sign-in is not configured (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, ALLOWED_EMAIL); refusing /authorize");
    return textResponse("Server is not configured for sign-in.", 503);
  }
  const callbackUrl = `${url.origin}${CALLBACK_PATH}`;

  try {
    if (url.pathname === CALLBACK_PATH && request.method === "GET") {
      return await finishSignIn(oauth, request, config, callbackUrl, fetchImpl);
    }
    if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(oauth, request);
    if (url.pathname === "/authorize" && request.method === "POST") return await submitConsent(oauth, request, config, callbackUrl);
    return textResponse("Method not allowed", 405);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // Only redirect once the library has validated the client and its exact redirect URI.
      if (error.redirectTo && isAllowedRedirectUri(error.redirectUri ?? "")) return redirect(error.redirectTo);
      return textResponse(error.description, 400);
    }
    console.error(`Authorization failed: ${errorMessage(error)}`);
    throw error;
  }
}
