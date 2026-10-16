# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fork of `xing5/mcp-google-sheets` ported from Python to TypeScript so it runs as a
remote MCP server on Cloudflare Workers (Streamable HTTP). The 20 tool names, argument
names, and result shapes are a compatibility contract with the original server: do not
rename or reshape them. Project-specific rules live in `.claude/rules/`.

## Commands

```bash
npm install
npm run dev                 # wrangler dev on http://localhost:8787 (needs .dev.vars, see .dev.vars.example)
npm run typecheck           # runs `wrangler types` first, then tsc --noEmit
npm test                    # all credential-free tests (pretest regenerates worker-configuration.d.ts)
npx vitest run test/tools.test.ts            # one file
npx vitest run -t "add_rows"                 # tests whose name matches
npm run test:integration    # live Google tests; needs RUN_GOOGLE_INTEGRATION=1, DRIVE_FOLDER_ID,
                            # GOOGLE_TEST_SPREADSHEET_ID, GOOGLE_TEST_COPY_TARGET_ID (two user-owned
                            # sheets; service accounts can't create files), and
                            # GOOGLE_SERVICE_ACCOUNT_JSON (or CREDENTIALS_CONFIG) in the host env
npm run deploy              # wrangler deploy
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # and MCP_AUTH_TOKEN
```

Tests execute inside the Workers runtime via `@cloudflare/vitest-plugin`, which requires
Vitest 4.x; Vitest 5 fails to boot the pool. `worker-configuration.d.ts` is generated and
gitignored; tsconfig references it, so run typecheck (not bare `tsc`) after changing
`wrangler.jsonc`.

## Architecture

Request flow, one Worker request at a time:

1. `src/index.ts` answers `/` and `/health` (no auth), returns 503 when the `OAUTH_KV`
   binding is missing, and hands everything else to an `OAuthProvider`
   (`@cloudflare/workers-oauth-provider` 1.x) built per request by `oauthOptions(env, url)`.
   It is built per request because the protected resource (`<request origin><MCP_PATH>`)
   must be an absolute URL and differs between workers.dev, custom domains and localhost.
   The provider serves the `.well-known` metadata, `/register` (DCR, gated by
   `checkClientRegistration`), `/token` and CORS preflights itself, validates OAuth access
   tokens on `MCP_PATH`, and sends tokens it did not issue to `resolveStaticToken`, which
   compares against `MCP_AUTH_TOKEN` (SHA-256 then `timingSafeEqual`) and throws
   `ConfigurationError` (answered 503) when it is unset. The 401 challenge with
   `resource_metadata` comes from the provider. `serveMcp` then fails closed with 503 on a
   missing service-account secret and creates the stateless `createMcpHandler`
   (`agents/mcp/server`) handler per request, because the factory needs `env`; the
   `McpServer` is built once per request, inside the factory.
   `src/oauth.ts` is the provider's default handler for `/authorize` and `/callback`: a
   consent page (library `beginConsent`/`approveConsent`, browser-bound handle), then Google
   sign-in (`beginUpstream`/`finishUpstream`, PKCE + nonce), then `completeAuthorization`
   only if the ID token's verified `email` equals `ALLOWED_EMAIL`. Redirect URIs are
   limited by `isAllowedRedirectUri` (claude.ai's connector callback exactly, or http
   loopback) at both registration and authorize time.
2. `src/server.ts` `createServer` registers every entry in `TOOLS` (filtered by
   `ENABLED_TOOLS`) plus the `spreadsheet://{spreadsheet_id}/info` resource. It is the only
   place that knows about MCP result framing: tool return values become one JSON text
   block (`JSON.stringify(result, null, 2)`, matching FastMCP), and thrown errors become
   `isError` results with `Error executing tool <name>: <message>`.
3. `src/tools.ts` holds the tools as `defineTool({...})` entries: a Zod input schema plus a
   handler `(deps, args) => result` with no MCP types. Tools return `{ error: "..." }`
   objects for the validation failures the Python version returned inline (missing sheet,
   bad chart type, empty requests) and only throw for transport or API failures.
4. `src/google/client.ts` is a thin typed `fetch` wrapper over the Sheets v4 and Drive v3
   REST endpoints; non-2xx responses throw `GoogleApiError` with Google's `error.message`.
5. `src/google/auth.ts` mints service-account access tokens (RS256 JWT via WebCrypto,
   exchanged at `token_uri`) and caches them with a 60 s refresh skew, coalescing
   concurrent refreshes. `src/index.ts` keeps one provider per isolate keyed by the raw
   secret string. `parseServiceAccount` accepts raw or base64 JSON.

`src/a1.ts` holds the A1-notation helpers, ported line for line from upstream; the chart
code depends on its exact index semantics (0-based, end-exclusive).

The `agents` handler imports `node:async_hooks`, so `nodejs_compat` in `wrangler.jsonc`
is required.

## Tests

- `test/helpers/fake-google.ts` is an in-memory Sheets/Drive backend injected through the
  `fetch` option. It routes on decoded URL path and records every call
  (`calls`, `lastCall`) so tests assert on exact query strings and bodies. Set
  `override` to force an error response.
- `test/helpers/mcp.ts` builds JSON-RPC requests and parses either JSON or SSE replies.
  Requests built inside workerd carry no `Host` header, and the handler rejects that, so
  the helper sets it explicitly.
- `test/worker.test.ts` exercises the real service-account signing path end to end: it
  generates an RSA key per run and serves the token endpoint from the fake.
- `test/oauth.test.ts` drives the whole OAuth flow (DCR, consent, a fake Google token
  endpoint returning an ID token, `/token`, then `/mcp`) with a small cookie jar, using the
  test runtime's `OAUTH_KV`. Test envs must include `OAUTH_KV` from `cloudflare:test`.
- Tool handlers are called through `tool.inputSchema.parse(args)` in tests so Zod defaults
  apply exactly as they do in production.

Adding a tool means: a `defineTool` entry appended to `TOOLS` in `src/tools.ts`, unit
coverage in `test/tools.test.ts`, its name added to `TOOLS_WITH_INTEGRATION_COVERAGE` and
a call added to the live flow in `test/google-integration.test.ts` (a declaration test
fails otherwise), and a bullet in the README tool list.

## Configuration

Secrets (`wrangler secret put`): `GOOGLE_SERVICE_ACCOUNT_JSON` (alias `CREDENTIALS_CONFIG`),
`MCP_AUTH_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ALLOWED_EMAIL`.
KV binding: `OAUTH_KV` (id in `wrangler.jsonc`). Vars: `DRIVE_FOLDER_ID`, `ENABLED_TOOLS`, `MCP_PATH`,
`MCP_ALLOWED_HOSTNAMES`. `vitest.config.ts` forwards the live-test variables from the host
environment into the test runtime as bindings; nothing else reads `process.env`.

## Git and CI

- `origin` uses SSH. Pushing changes under `.github/workflows/` over HTTPS fails unless
  the token has the `workflow` scope.
- `deploy.yml` runs on push to `main` and needs `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` repository secrets. Setting the repository variable
  `RUN_LIVE_TESTS_BEFORE_DEPLOY=true` gates deploys on the live Google suite.
