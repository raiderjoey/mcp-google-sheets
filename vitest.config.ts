import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Live Google integration tests are opt-in. The values are forwarded from the
// host environment into the Workers test runtime as plain bindings.
const liveBindings: Record<string, string> = {};
for (const name of [
  "RUN_GOOGLE_INTEGRATION",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "CREDENTIALS_CONFIG",
  "DRIVE_FOLDER_ID",
  "GOOGLE_TEST_SHARE_EMAIL",
  "GOOGLE_TEST_SPREADSHEET_ID",
  "GOOGLE_TEST_COPY_TARGET_ID",
]) {
  const value = process.env[name];
  if (value) liveBindings[name] = value;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: liveBindings },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
