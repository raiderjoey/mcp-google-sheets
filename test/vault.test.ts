import { describe, expect, it } from "vitest";
import { TOOL_NAMES, vaultAppend, vaultFind, type ToolDefinition, type ToolDeps } from "../src/tools";
import { appendMarkdown, parseVaultPath } from "../src/vault";
import { FakeGoogle, FOLDER_MIME } from "./helpers/fake-google";

function invoke(tool: ToolDefinition, deps: ToolDeps, args: Record<string, unknown>): Promise<any> {
  return tool.handler(deps, tool.inputSchema.parse(args));
}

const ROOT = "vault-root";

/** A vault with 01_Projects/Hermes/Plan.md and an empty 00_Inbox folder. */
function vaultSetup(vaultFolderId: string | null = ROOT) {
  const google = new FakeGoogle();
  google.addDriveFile({ id: "projects", name: "01_Projects", mimeType: FOLDER_MIME, parents: [ROOT] });
  google.addDriveFile({ id: "inbox", name: "00_Inbox", mimeType: FOLDER_MIME, parents: [ROOT] });
  google.addDriveFile({ id: "hermes", name: "Hermes", mimeType: FOLDER_MIME, parents: ["projects"] });
  google.addDriveFile({
    id: "plan",
    name: "Plan.md",
    mimeType: "text/markdown",
    parents: ["hermes"],
    content: "# Plan\n\n## Tasks\n\n- one\n\n## Notes\n\nSome notes.\n",
  });
  const deps: ToolDeps = { google: google.client(), vaultFolderId: vaultFolderId ?? undefined };
  return { google, deps };
}

describe("parseVaultPath", () => {
  it("splits a vault-relative path into folders and a file name", () => {
    expect(parseVaultPath("01_Projects/Hermes/Plan.md")).toEqual({ folders: ["01_Projects", "Hermes"], fileName: "Plan.md" });
    expect(parseVaultPath("Note.md")).toEqual({ folders: [], fileName: "Note.md" });
  });

  it("accepts backslashes and a leading slash", () => {
    expect(parseVaultPath("\\01_Projects\\Plan.md")).toEqual({ folders: ["01_Projects"], fileName: "Plan.md" });
  });

  it.each([
    ["", "empty"],
    ["01_Projects/", "folder, not a note"],
    ["01_Projects/../secret.md", "parent segment"],
    ["./Plan.md", "dot segment"],
    ["a//b.md", "empty segment"],
    [".obsidian/app.md", "hidden folder"],
    ["01_Projects/.trash/x.md", "hidden folder"],
    ["notes.txt", "not markdown"],
    ["image.png", "not markdown"],
  ])("rejects %j (%s)", (path) => {
    expect(() => parseVaultPath(path)).toThrow();
  });
});

describe("appendMarkdown", () => {
  it("appends at the end, adding a newline when the file lacks one", () => {
    expect(appendMarkdown("line", "added")).toBe("line\nadded\n");
    expect(appendMarkdown("line\n", "added")).toBe("line\nadded\n");
    expect(appendMarkdown("", "added")).toBe("added\n");
  });

  it("keeps the text's own leading blank line and drops trailing newlines", () => {
    expect(appendMarkdown("para\n", "\nnew para\n\n\n")).toBe("para\n\nnew para\n");
  });

  it("preserves CRLF line endings and a BOM", () => {
    expect(appendMarkdown("﻿a\r\nb\r\n", "c\nd")).toBe("﻿a\r\nb\r\nc\r\nd\r\n");
  });

  it("inserts under a heading, after its last line and before the next heading", () => {
    const doc = "# Plan\n\n## Tasks\n\n- one\n\n## Notes\n\nSome notes.\n";
    expect(appendMarkdown(doc, "- two", "Tasks")).toBe("# Plan\n\n## Tasks\n\n- one\n- two\n\n## Notes\n\nSome notes.\n");
  });

  it("matches the heading ignoring case and leading #s, and includes subsections", () => {
    const doc = "## Tasks\n- one\n### Sub\n- deep\n## Notes\n";
    expect(appendMarkdown(doc, "- two", "## tasks")).toBe("## Tasks\n- one\n### Sub\n- deep\n- two\n## Notes\n");
  });

  it("appends under the last heading at the end of the file", () => {
    expect(appendMarkdown("## Notes\n\nSome notes.\n", "More.", "Notes")).toBe("## Notes\n\nSome notes.\nMore.\n");
  });

  it("inserts directly under an empty section's heading", () => {
    expect(appendMarkdown("## A\n## B\n", "x", "A")).toBe("## A\nx\n## B\n");
  });

  it("ignores headings inside frontmatter and code fences", () => {
    const doc = "---\n# not: heading\n---\n```\n## Tasks\n```\n## Tasks\n- one\n";
    expect(appendMarkdown(doc, "- two", "Tasks")).toBe("---\n# not: heading\n---\n```\n## Tasks\n```\n## Tasks\n- one\n- two\n");
  });

  it("refuses a missing heading and lists the ones that exist", () => {
    expect(() => appendMarkdown("## A\n## B\n", "x", "C")).toThrow(/Heading 'C' not found.*A.*B/s);
  });

  it("refuses an ambiguous heading", () => {
    expect(() => appendMarkdown("## A\n## A\n", "x", "A")).toThrow(/appears 2 times/);
  });

  it("refuses empty text", () => {
    expect(() => appendMarkdown("a\n", " \n\n ")).toThrow(/empty/);
  });
});

describe("vault_find", () => {
  it("is registered", () => {
    expect(TOOL_NAMES).toContain("vault_find");
    expect(vaultFind.readOnly).toBe(true);
  });

  it("finds an existing note case-insensitively and says to append", async () => {
    const { deps } = vaultSetup();
    const result = await invoke(vaultFind, deps, { path: "01_projects/hermes/plan.md" });
    expect(result).toMatchObject({
      exists: true,
      folder_id: "hermes",
      missing_folders: [],
      file: { id: "plan", name: "Plan.md", mime_type: "text/markdown" },
    });
    expect(result.next_step).toMatch(/vault_append/);
  });

  it("gives create instructions when the folder exists but the note does not", async () => {
    const { deps } = vaultSetup();
    const result = await invoke(vaultFind, deps, { path: "00_Inbox/New idea.md" });
    expect(result).toMatchObject({ exists: false, folder_id: "inbox", missing_folders: [], file: null });
    expect(result.next_step).toMatch(/create_file/);
    expect(result.next_step).toContain("New idea.md");
    expect(result.next_step).toContain("inbox");
    expect(result.next_step).toMatch(/disableConversionToGoogleType/);
  });

  it("reports missing folders and says to ask first", async () => {
    const { deps } = vaultSetup();
    const result = await invoke(vaultFind, deps, { path: "01_Projects/Garden/Beds/Plan.md" });
    expect(result).toMatchObject({ exists: false, folder_id: null, missing_folders: ["Garden", "Beds"], file: null });
    expect(result.next_step).toMatch(/ask/i);
  });

  it("lists duplicates instead of picking one", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "plan-dup", name: "plan.md", mimeType: "text/markdown", parents: ["hermes"], content: "" });
    const result = await invoke(vaultFind, deps, { path: "01_Projects/Hermes/Plan.md" });
    expect(result.exists).toBe(true);
    expect(result.duplicates.map((file: { id: string }) => file.id).sort()).toEqual(["plan", "plan-dup"]);
  });

  it("does not match a folder with the note's name", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "weird", name: "Odd.md", mimeType: FOLDER_MIME, parents: [ROOT] });
    expect((await invoke(vaultFind, deps, { path: "Odd.md" })).exists).toBe(false);
  });

  it("errors when VAULT_FOLDER_ID is not configured", async () => {
    const { deps } = vaultSetup(null);
    expect(await invoke(vaultFind, deps, { path: "Note.md" })).toEqual({ error: expect.stringMatching(/VAULT_FOLDER_ID/) });
  });

  it("returns an error for an invalid path", async () => {
    const { deps } = vaultSetup();
    expect(await invoke(vaultFind, deps, { path: "../x.md" })).toEqual({ error: expect.any(String) });
  });
});

describe("vault_append", () => {
  it("is registered as a write tool", () => {
    expect(TOOL_NAMES).toContain("vault_append");
    expect(vaultAppend.readOnly).toBe(false);
  });

  it("uploads the appended note to the same file as markdown", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultAppend, deps, { path: "01_Projects/Hermes/Plan.md", text: "- two", under_heading: "Tasks" });
    expect(result).toMatchObject({ success: true, file_id: "plan", under_heading: "Tasks" });
    expect(google.driveFile("plan")!.content).toBe("# Plan\n\n## Tasks\n\n- one\n- two\n\n## Notes\n\nSome notes.\n");
    const upload = google.calls.find((call) => call.method === "PATCH")!;
    expect(upload.path).toBe("/upload/drive/v3/files/plan");
    expect(upload.query.uploadType).toBe("media");
    expect(upload.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(google.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("appends at the end when no heading is given", async () => {
    const { google, deps } = vaultSetup();
    await invoke(vaultAppend, deps, { path: "01_Projects/Hermes/Plan.md", text: "Tail." });
    expect(google.driveFile("plan")!.content).toBe("# Plan\n\n## Tasks\n\n- one\n\n## Notes\n\nSome notes.\nTail.\n");
  });

  it("refuses to upload when the note changed while it was being read", async () => {
    const { google, deps } = vaultSetup();
    let downloads = 0;
    google.override = (call) => {
      if (call.query.alt === "media" && ++downloads === 1) {
        const original = google.driveFile("plan")!.content!;
        const response = new Response(original);
        google.touchDriveFile("plan", original + "phone edit\n");
        return response;
      }
      return undefined;
    };
    const result = await invoke(vaultAppend, deps, { path: "01_Projects/Hermes/Plan.md", text: "late" });
    expect(result.error).toMatch(/changed/);
    expect(google.calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(google.driveFile("plan")!.content).toContain("phone edit");
  });

  it("refuses a note that does not exist and points at vault_find", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultAppend, deps, { path: "00_Inbox/Missing.md", text: "x" });
    expect(result.error).toMatch(/not found.*vault_find/s);
    expect(google.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("refuses duplicates", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "plan-dup", name: "Plan.md", mimeType: "text/markdown", parents: ["hermes"], content: "" });
    const result = await invoke(vaultAppend, deps, { path: "01_Projects/Hermes/Plan.md", text: "x" });
    expect(result.error).toMatch(/2 files/);
  });

  it("refuses Google Docs and other non-text files", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "gdoc", name: "Doc.md", mimeType: "application/vnd.google-apps.document", parents: [ROOT] });
    const result = await invoke(vaultAppend, deps, { path: "Doc.md", text: "x" });
    expect(result.error).toMatch(/not a plain-text/);
  });

  it("refuses notes over the size limit", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "big", name: "Big.md", mimeType: "text/markdown", parents: [ROOT], content: "x".repeat(1_000_001) });
    const result = await invoke(vaultAppend, deps, { path: "Big.md", text: "x" });
    expect(result.error).toMatch(/too large/);
  });

  it("returns heading errors without uploading", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultAppend, deps, { path: "01_Projects/Hermes/Plan.md", text: "x", under_heading: "Nope" });
    expect(result.error).toMatch(/Heading 'Nope' not found/);
    expect(google.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("caps the text length in its schema", () => {
    expect(() => vaultAppend.inputSchema.parse({ path: "a.md", text: "x".repeat(20_001) })).toThrow();
  });
});
