<div align="center">
  <b>mcp-google-sheets</b>
  <p align="center"><i>Your AI assistant's gateway to Google Sheets, running on Cloudflare Workers.</i> 📊</p>

![GitHub License](https://img.shields.io/github/license/raiderjoey/mcp-google-sheets)
![Tests](https://img.shields.io/github/actions/workflow/status/raiderjoey/mcp-google-sheets/tests.yml?label=tests)
</div>

---

## 🤔 What is this?

`mcp-google-sheets` is a remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets MCP clients such as Claude Code, Claude Desktop, and Cursor read and write Google Sheets and browse Google Drive.

This fork is a TypeScript port of [xing5/mcp-google-sheets](https://github.com/xing5/mcp-google-sheets) that runs on **Cloudflare Workers** using the **Streamable HTTP** transport. It exposes the same 20 tools and the same tool and argument names, so prompts written for the original server keep working.

Why Workers:

*   No server to run. Deploy once, get a globally available HTTPS endpoint.
*   No Python toolchain on the client. Any MCP client that speaks HTTP can connect.
*   Secrets live in Cloudflare, not in a config file on every machine.

**Key features**

*   **Comprehensive tools:** read, write, batch update, insert rows and columns, copy and rename sheets, search, find, share, charts, and raw `batchUpdate` access.
*   **Drive aware:** list and create spreadsheets inside a chosen folder, browse folders, search by name or content.
*   **Tool filtering:** register only the tools you need with `ENABLED_TOOLS` to keep the client's context small.
*   **Secure by default:** bearer-token gate, constant-time comparison, fail-closed configuration, service-account scope limited to what you share.
*   **Tested:** 66 unit and end-to-end tests run inside the Workers runtime, plus an opt-in live suite that exercises every tool against Google.

---

## 🚀 Quick Start

**Prerequisites**

*   Node.js 20 or newer and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
*   A Google Cloud project with the **Google Sheets API** and **Google Drive API** enabled, and a **service account** key file (see [Google Cloud setup](#️-google-cloud-setup)).

**1. Install and log in**

```bash
git clone https://github.com/raiderjoey/mcp-google-sheets.git
cd mcp-google-sheets
npm install
npx wrangler login
```

**2. Set the secrets**

```bash
# Pipe the service-account JSON key file in directly.
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < service-account-key.json

# Any long random string. MCP clients must send it as a bearer token.
openssl rand -base64 32 | npx wrangler secret put MCP_AUTH_TOKEN
```

On Windows PowerShell:

```powershell
Get-Content service-account-key.json -Raw | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
-join ((1..48) | ForEach-Object { [char](Get-Random -InputObject ([char[]]"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")) }) | npx wrangler secret put MCP_AUTH_TOKEN
```

The key can also be supplied base64-encoded (handy for CI variables or pasting into the Cloudflare dashboard): `base64 -w 0 service-account-key.json` on Linux, `base64 -i service-account-key.json` on macOS, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account-key.json"))` in PowerShell. Avoid pasting credentials into online encoders.

**3. Deploy**

```bash
npm run deploy
```

Wrangler prints your Worker URL, for example `https://mcp-google-sheets.<your-subdomain>.workers.dev`. The MCP endpoint is `/mcp` on that host.

**4. Share a Drive folder with the service account**

Create a folder in Google Drive, share it with the service account's email address (`...@...iam.gserviceaccount.com`) as an **Editor**, and optionally set that folder as the default with:

```bash
npx wrangler secret put DRIVE_FOLDER_ID   # or add it under "vars" in wrangler.jsonc
```

**5. Connect a client**

See [Connecting MCP clients](#-connecting-mcp-clients).

---

## ☁️ Google Cloud setup

1.  **Create or select a project** in the [Google Cloud Console](https://console.cloud.google.com/).
2.  **Enable the APIs.** Go to **APIs & Services → Library** and enable both **Google Sheets API** and **Google Drive API**.
3.  **Create a service account.** Go to **IAM & Admin → Service Accounts → Create service account**, name it (for example `mcp-sheets-service`), and click Done. No project roles are required: access is granted by sharing Drive items with the account.
4.  **Create a key.** Open the account, choose **Keys → Add key → Create new key → JSON**, and download the file. Store it securely; it is the only credential the server uses.
5.  **Create and share a Drive folder.** In [Google Drive](https://drive.google.com/) create a folder (for example "AI Managed Sheets"), note its ID from the URL, then **Share** it with the service account's email address (the `client_email` value in the key file) as **Editor**. Untick "Notify people".
6.  **Point the server at the folder** by setting `DRIVE_FOLDER_ID` to that ID. Anything else the account needs must be shared with it the same way.

> **Service accounts and Drive storage.** A service account has no My Drive quota, so it cannot own new files in its own root. Always create spreadsheets inside a folder you own that is shared with the service account, or in a Shared Drive. `DRIVE_FOLDER_ID` makes that the default.

---

## 🔑 Configuration

Secrets are set with `npx wrangler secret put <NAME>`. Plain variables can go under `vars` in `wrangler.jsonc` or also be set as secrets.

| Name | Required | Description |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | Service-account key file contents, either raw JSON or base64-encoded. `CREDENTIALS_CONFIG` is accepted as an alias for compatibility with the original server. |
| `MCP_AUTH_TOKEN` | yes | Shared secret. Every request to the MCP endpoint must carry `Authorization: Bearer <token>`. The server refuses all requests if this is unset. |
| `DRIVE_FOLDER_ID` | no | Default folder for `list_spreadsheets` and `create_spreadsheet`. |
| `ENABLED_TOOLS` | no | Comma-separated allow-list of tool names, e.g. `get_sheet_data,update_cells`. Unset enables every tool. |
| `MCP_PATH` | no | Path of the MCP endpoint. Defaults to `/mcp`. |
| `MCP_ALLOWED_HOSTNAMES` | no | Comma-separated hostnames to accept in the `Host` header. Only needed when serving from a custom domain; `workers.dev` and localhost are allowed by default. |

**Authentication model.** The Worker authenticates to Google as the service account by signing a JWT with WebCrypto and exchanging it for an access token, which is cached per isolate. The interactive OAuth flow, token files, and Application Default Credentials from the original server do not exist on Workers and are not supported.

---

## 🔌 Connecting MCP clients

Replace `https://mcp-google-sheets.example.workers.dev` with your Worker URL and `<token>` with your `MCP_AUTH_TOKEN`.

**Claude Code**

```bash
claude mcp add --transport http google-sheets https://mcp-google-sheets.example.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

**Clients that support remote servers with custom headers** (Cursor, Windsurf, VS Code, and similar). Add an entry like:

```json
{
  "mcpServers": {
    "google-sheets": {
      "type": "http",
      "url": "https://mcp-google-sheets.example.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Clients that only speak stdio** (Claude Desktop's `claude_desktop_config.json`). Bridge with [`mcp-remote`](https://github.com/geelen/mcp-remote):

```json
{
  "mcpServers": {
    "google-sheets": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp-google-sheets.example.workers.dev/mcp",
        "--header", "Authorization: Bearer ${SHEETS_MCP_TOKEN}"
      ],
      "env": { "SHEETS_MCP_TOKEN": "<token>" }
    }
  }
}
```

> Claude.ai's web **Custom connectors** expect OAuth rather than a static bearer token, so they cannot connect directly yet. Adding an OAuth layer on top of this server is possible with Cloudflare's `workers-oauth-provider` but is not included.

---

## 🎯 Tool filtering (reduce context usage)

Set `ENABLED_TOOLS` to a comma-separated list of tool names to register only those tools. This keeps the tool list small for clients with limited context.

```bash
npx wrangler secret put ENABLED_TOOLS   # e.g. get_sheet_data,update_cells,list_spreadsheets
```

By default all 20 tools are registered, which costs roughly 13K tokens of context before the conversation starts. A common minimal subset:

```
get_sheet_data,update_cells,list_spreadsheets,list_sheets
```

All tool names, for copy and paste:

```
add_chart, add_columns, add_rows, batch_update, batch_update_cells, copy_sheet, create_sheet,
create_spreadsheet, find_in_spreadsheet, get_multiple_sheet_data, get_multiple_spreadsheet_summary,
get_sheet_data, get_sheet_formulas, list_folders, list_sheets, list_spreadsheets, rename_sheet,
search_spreadsheets, share_spreadsheet, update_cells
```

Whitespace around names is ignored. If `ENABLED_TOOLS` is unset or empty, every tool is enabled.

---

## 🛠️ Available tools and resources

_Refer to the [ID Reference Guide](#-id-reference-guide) for more information about the IDs used below._

*(Input parameters are strings unless otherwise specified.)*

*   **`list_spreadsheets`**: Lists spreadsheets in a Drive folder.
    *   `folder_id` (optional): Folder ID to search in. If omitted, uses `DRIVE_FOLDER_ID` or lists everything the service account can access.
    *   _Returns:_ `[{id, title}]`
*   **`create_spreadsheet`**: Creates a new spreadsheet.
    *   `title`: Title for the spreadsheet.
    *   `folder_id` (optional): Folder to create it in. Defaults to `DRIVE_FOLDER_ID`, then root.
    *   _Returns:_ `{spreadsheetId, title, folder}`
*   **`get_sheet_data`**: Reads data from a range in a sheet/tab.
    *   `spreadsheet_id`, `sheet`, `range` (optional A1 notation, e.g. `A1:C10`).
    *   `include_grid_data` (optional boolean, default `false`): Return full grid data with formatting (much larger).
    *   _Returns:_ Values result `{spreadsheetId, valueRanges: [{range, values}]}`, or the full [`spreadsheets.get`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get#response-body) response when `include_grid_data` is `true`.
*   **`get_sheet_formulas`**: Reads formulas from a range.
    *   `spreadsheet_id`, `sheet`, `range` (optional).
    *   _Returns:_ 2D array of formulas.
*   **`update_cells`**: Writes a 2D array to a range. Overwrites existing data.
    *   `spreadsheet_id`, `sheet`, `range`, `data` (array of arrays, e.g. `[[1, 2, 3], ["a", "b", "c"]]`).
    *   _Returns:_ [`values.update`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update#response-body) response.
*   **`batch_update_cells`**: Updates several ranges in one call.
    *   `spreadsheet_id`, `sheet`, `ranges` (object mapping A1 ranges to 2D arrays, e.g. `{"A1:B2": [[1, 2], [3, 4]], "D5": [["Hello"]]}`).
    *   _Returns:_ [`values.batchUpdate`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate#response-body) response.
*   **`add_rows`**: Inserts empty rows.
    *   `spreadsheet_id`, `sheet`, `count` (integer), `start_row` (optional integer, 0-based, default `0`).
*   **`add_columns`**: Inserts empty columns.
    *   `spreadsheet_id`, `sheet`, `count` (integer), `start_column` (optional integer, 0-based, default `0`).
*   **`list_sheets`**: Lists sheet/tab names in a spreadsheet.
    *   `spreadsheet_id`.
    *   _Returns:_ `["Sheet1", "Sheet2"]`
*   **`create_sheet`**: Adds a new sheet/tab.
    *   `spreadsheet_id`, `title`.
    *   _Returns:_ `{sheetId, title, index, spreadsheetId}`
*   **`copy_sheet`**: Copies a sheet/tab to another spreadsheet and renames it.
    *   `src_spreadsheet`, `src_sheet`, `dst_spreadsheet`, `dst_sheet`.
*   **`rename_sheet`**: Renames a sheet/tab.
    *   `spreadsheet`, `sheet`, `new_name`.
*   **`get_multiple_sheet_data`**: Fetches several ranges, possibly across spreadsheets, in one call.
    *   `queries`: array of `{spreadsheet_id, sheet, range}`.
    *   _Returns:_ Each query with `data` or `error`.
*   **`get_multiple_spreadsheet_summary`**: Titles, sheet names, headers, and first rows of several spreadsheets.
    *   `spreadsheet_ids` (array of strings), `rows_to_fetch` (optional integer, default `5`).
*   **`share_spreadsheet`**: Shares a spreadsheet with users.
    *   `spreadsheet_id`, `recipients` (array of `{email_address, role}` where role is `reader`, `commenter`, or `writer`), `send_notification` (optional boolean, default `true`).
    *   _Returns:_ `{successes, failures}`
*   **`list_folders`**: Lists folders in a Drive folder.
    *   `parent_folder_id` (optional): Defaults to the root of My Drive.
    *   _Returns:_ `[{id, name, parent}]`
*   **`search_spreadsheets`**: Searches Drive for spreadsheets by name or content.
    *   `query`, `max_results` (optional integer, default `20`, max `100`).
    *   _Returns:_ `[{id, name, created_time, modified_time, owners, web_link}]`
*   **`find_in_spreadsheet`**: Finds cells containing text.
    *   `spreadsheet_id`, `query`, `sheet` (optional), `case_sensitive` (optional boolean, default `false`), `max_results` (optional integer, default `50`).
    *   _Returns:_ `[{sheet, cell, value}]`
*   **`batch_update`**: Runs arbitrary [`spreadsheets.batchUpdate`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate) requests (formatting, borders, conditional formats, dimension changes, and more).
    *   `spreadsheet_id`, `requests` (array of request objects).
*   **`add_chart`**: Adds a floating chart from a data range.
    *   `spreadsheet_id`, `sheet`, `chart_type` (`COLUMN`, `BAR`, `LINE`, `AREA`, `PIE`, `SCATTER`, `COMBO`, `HISTOGRAM`), `data_range` (A1 notation, first row treated as headers).
    *   `title`, `x_axis_label`, `y_axis_label` (optional), `position_x`, `position_y` (optional integers, default `0`), `width`, `height` (optional integers, default `600` × `400`).
    *   _Returns:_ `{success, message, chartId, result}`

**MCP resources**

*   **`spreadsheet://{spreadsheet_id}/info`**: Basic metadata about a spreadsheet as JSON (title and sheets).

---

## 🧪 Local development and testing

```bash
cp .dev.vars.example .dev.vars   # fill in a service-account key and a token
npm run dev                      # http://localhost:8787
```

Smoke test the running server:

```bash
curl http://localhost:8787/                       # health check, no auth
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

To point an MCP client at the local server while developing, use `http://localhost:8787/mcp` with the token from `.dev.vars`, for example:

```bash
claude mcp add --transport http google-sheets-local http://localhost:8787/mcp \
  --header "Authorization: Bearer <token from .dev.vars>"
```

Tests run inside the Workers runtime with Vitest and need no Google credentials:

```bash
npm run typecheck
npm test
```

The live integration test creates and deletes spreadsheets in a disposable folder and exercises every tool against Google:

```bash
RUN_GOOGLE_INTEGRATION=1 \
DRIVE_FOLDER_ID=<disposable folder id> \
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
npm run test:integration
```

Set `GOOGLE_TEST_SHARE_EMAIL` to also exercise a real share call.

---

## 🚢 Deploying from GitHub Actions

`.github/workflows/deploy.yml` deploys on every push to `main` after the unit tests pass. Add these repository secrets:

*   `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission.
*   `CLOUDFLARE_ACCOUNT_ID`: your account ID from the Cloudflare dashboard.

Worker secrets (`GOOGLE_SERVICE_ACCOUNT_JSON`, `MCP_AUTH_TOKEN`) are set once with `wrangler secret put` and persist across deploys.

To gate deploys on the live Google tests, set the repository variable `RUN_LIVE_TESTS_BEFORE_DEPLOY` to `true` and add the Google secrets used by `.github/workflows/google-integration.yml` (`GOOGLE_DRIVE_FOLDER_ID` plus `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_CREDENTIALS_CONFIG`).

---

## 🔒 Security notes

*   The endpoint fails closed: with no `MCP_AUTH_TOKEN` configured it answers `503`, and a missing or wrong token answers `401`. Token comparison is constant-time.
*   The service account can only reach files explicitly shared with it. Share single folders rather than your whole Drive.
*   The health check at `/` needs no token and reveals only the server name and version. CORS preflight (`OPTIONS`) requests are also answered without a token, since they carry no credentials and return no data; this is what lets browser-hosted MCP clients connect.
*   For extra protection put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or restrict it to a custom domain with `MCP_ALLOWED_HOSTNAMES`.

---

## 🔁 Differences from the original Python server

*   Transport is Streamable HTTP only. There is no stdio or SSE mode.
*   Authentication is service account only. OAuth, token files, and Application Default Credentials are not available on Workers.
*   Configuration comes from Worker secrets and vars, not command-line flags or key files on disk.
*   Drive search queries escape quotes and backslashes in the search text.
*   Sheet lookups request only the fields they need, which reduces response size without changing results.

---

## 💬 Example prompts

*   "List all spreadsheets in my AI Managed Sheets folder."
*   "Create a new spreadsheet titled 'Quarterly Sales Report Q3'."
*   "In the 'Quarterly Sales Report' spreadsheet, get the data from Sheet1 range A1 to E10."
*   "Add a new sheet named 'Summary' to the spreadsheet with ID `1aBcDeFgHiJkLmNoPqRsTuVwXyZ`."
*   "In my 'Project Tasks' spreadsheet, Sheet 'Tasks', update cell B2 to 'In Progress'."
*   "Get a summary of the spreadsheets 'Sales Data' and 'Inventory Count'."
*   "Share the 'Team Vacation Schedule' spreadsheet with `team@example.com` as a reader. Don't send notifications."
*   "Create a column chart in my 'Sales Report' spreadsheet showing monthly revenue from range A1:B13."

---

## 🆔 ID Reference Guide

```
Google Cloud Project ID:
  https://console.cloud.google.com/apis/dashboard?project=sheets-mcp-server-123456
                                                          └───── Project ID ─────┘

Google Drive Folder ID:
  https://drive.google.com/drive/u/0/folders/1xcRQCU9xrNVBPTeNzHqx4hrG7yR91WIa
                                             └────────── Folder ID ──────────┘

Google Sheets Spreadsheet ID:
  https://docs.google.com/spreadsheets/d/25_-_raTaKjaVxu9nJzA7-FCrNhnkd3cXC54BPAOXemI/edit
                                         └───────────── Spreadsheet ID ─────────────┘
```

---

## 🤝 Contributing

Contributions are welcome. Please open an issue to discuss bugs or feature requests. New tools must add unit coverage and be added to the live integration test.

## 📄 License

MIT. See [LICENSE](LICENSE).

## 🙏 Credits

*   Original server: [xing5/mcp-google-sheets](https://github.com/xing5/mcp-google-sheets) by Xing Wu.
*   Built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
