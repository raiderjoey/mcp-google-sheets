import { describe, expect, it } from "vitest";
import { TOOL_NAMES, vaultAppend, vaultEdit, vaultFind, vaultRead, type ToolDefinition, type ToolDeps } from "../src/tools";
import { appendMarkdown, editMarkdown, parseVaultPath, unifiedDiff } from "../src/vault";
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

describe("parseVaultPath and the private folder", () => {
  it.each([
    "90_Private/TTC.md",
    "90_private/x.md",
    "90_PRIVATE/x.md",
    "/90_Private/x.md",
    "\\90_Private\\x.md",
    "90_Private/deep/x.md",
    "90_Private (conflict)/x.md",
    "90_Private 2/x.md",
    " 90_Private/x.md",
    "90_Private /x.md",
    "01_Projects/90_Private/x.md",
    "00_Inbox/90_Private.md",
    "90_\u200bPrivate/x.md",
    "\uff19\uff10_Private/x.md",
    "\u00a090_Private/x.md",
  ])("rejects %j", (path) => {
    expect(() => parseVaultPath(path)).toThrow(/private/i);
  });

  it("does not echo the rest of a private path back", () => {
    let message = "";
    try {
      parseVaultPath("90_Private/Some Secret Title.md");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/Some Secret Title/);
  });

  it("still accepts names that only contain the word", () => {
    expect(parseVaultPath("00_Inbox/About 90_Private.md").fileName).toBe("About 90_Private.md");
    expect(parseVaultPath("190_Private/x.md").folders).toEqual(["190_Private"]);
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
    expect(result.next_step).toMatch(/vault_edit/);
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

  it("refuses the private folder without asking Drive anything", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "private", name: "90_Private", mimeType: FOLDER_MIME, parents: [ROOT] });
    google.addDriveFile({ id: "ttc", name: "TTC.md", mimeType: "text/markdown", parents: ["private"], content: "PRIVATE-MARKER" });
    for (const path of ["90_Private/TTC.md", "90_private/ttc.md", "90_Private/New.md"]) {
      const result = await invoke(vaultFind, deps, { path });
      expect(result).toEqual({ error: expect.stringMatching(/private/i) });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-MARKER/);
    }
    expect(google.calls).toEqual([]);
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

  it("refuses the private folder without reading or uploading", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "private", name: "90_Private", mimeType: FOLDER_MIME, parents: [ROOT] });
    google.addDriveFile({ id: "ttc", name: "TTC.md", mimeType: "text/markdown", parents: ["private"], content: "PRIVATE-MARKER" });
    for (const path of ["90_Private/TTC.md", "90_PRIVATE/TTC.md"]) {
      const result = await invoke(vaultAppend, deps, { path, text: "x" });
      expect(result.error).toMatch(/private/i);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-MARKER/);
    }
    expect(google.calls).toEqual([]);
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

describe("editMarkdown", () => {
  const note = "# Plan\n\n## Tasks\n\n- one\n- two\n";

  it("replaces a unique match", () => {
    expect(editMarkdown(note, [{ old_text: "- one", new_text: "- uno" }])).toEqual({
      content: "# Plan\n\n## Tasks\n\n- uno\n- two\n",
      replacements: 1,
    });
  });

  it("applies edits in order, each against the result of the last", () => {
    const result = editMarkdown(note, [
      { old_text: "- one", new_text: "- first" },
      { old_text: "- first\n- two", new_text: "- first\n- second" },
    ]);
    expect(result.content).toBe("# Plan\n\n## Tasks\n\n- first\n- second\n");
    expect(result.replacements).toBe(2);
  });

  it("deletes text when new_text is empty", () => {
    expect(editMarkdown(note, [{ old_text: "- two\n", new_text: "" }]).content).toBe("# Plan\n\n## Tasks\n\n- one\n");
  });

  it("refuses an old_text that is not in the note, naming the edit", () => {
    expect(() => editMarkdown(note, [{ old_text: "- one", new_text: "x" }, { old_text: "- three", new_text: "x" }])).toThrow(
      /Edit 2: old_text not found/,
    );
  });

  it("refuses an ambiguous old_text unless replace_all is set", () => {
    const twice = "a b a\n";
    expect(() => editMarkdown(twice, [{ old_text: "a", new_text: "c" }])).toThrow(/Edit 1: old_text appears 2 times/);
    expect(editMarkdown(twice, [{ old_text: "a", new_text: "c", replace_all: true }])).toEqual({ content: "c b c\n", replacements: 2 });
  });

  it("treats $ in new_text literally", () => {
    expect(editMarkdown("price\n", [{ old_text: "price", new_text: "$& $1 $$" }]).content).toBe("$& $1 $$\n");
  });

  it("matches LF text against a CRLF note and keeps CRLF and the BOM", () => {
    const crlf = "﻿# Plan\r\n\r\n- one\r\n- two\r\n";
    expect(editMarkdown(crlf, [{ old_text: "- one\n- two", new_text: "- one\n- 1.5\n- two" }]).content).toBe(
      "﻿# Plan\r\n\r\n- one\r\n- 1.5\r\n- two\r\n",
    );
  });

  it("replaces the whole note when given content, in the note's line endings", () => {
    expect(editMarkdown("﻿a\r\nb\r\n", { content: "x\ny\n" })).toEqual({ content: "﻿x\r\ny\r\n", replacements: 1 });
  });

  it("refuses an empty old_text", () => {
    expect(() => editMarkdown(note, [{ old_text: "", new_text: "x" }])).toThrow(/Edit 1: old_text is empty/);
  });
});

describe("unifiedDiff", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "n.md")).toBe("");
  });

  it("shows a changed line with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n") + "\n";
    const after = before.replace("5\n", "five\n");
    expect(unifiedDiff(before, after, "n.md")).toBe(
      ["--- a/n.md", "+++ b/n.md", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8", ""].join("\n"),
    );
  });

  it("splits distant changes into separate hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const after = [...lines];
    after[1] = "two";
    after[17] = "eighteen";
    const diff = unifiedDiff(lines.join("\n") + "\n", after.join("\n") + "\n", "n.md");
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain("@@ -1,5 +1,5 @@");
    expect(diff).toContain("@@ -15,6 +15,6 @@");
  });

  it("shows pure insertions and deletions", () => {
    expect(unifiedDiff("a\nc\n", "a\nb\nc\n", "n.md")).toBe(["--- a/n.md", "+++ b/n.md", "@@ -1,2 +1,3 @@", " a", "+b", " c", ""].join("\n"));
    expect(unifiedDiff("a\nb\n", "", "n.md")).toBe(["--- a/n.md", "+++ b/n.md", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n"));
  });
});

describe("vault_edit", () => {
  const PATH = "01_Projects/Hermes/Plan.md";
  const ORIGINAL = "# Plan\n\n## Tasks\n\n- one\n\n## Notes\n\nSome notes.\n";
  const uploads = (google: FakeGoogle) => google.calls.filter((call) => call.method === "PATCH");

  it("is registered as a destructive write tool", () => {
    expect(TOOL_NAMES).toContain("vault_edit");
    expect(vaultEdit.readOnly).toBe(false);
  });

  it("edits the same file in place as markdown and returns the diff", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "Some notes.", new_text: "Better notes." }] });
    expect(result).toMatchObject({ success: true, path: PATH, file_id: "plan", mode: "edits", replacements: 1, md5: "md5-plan-1" });
    expect(result.diff).toContain("-Some notes.\n+Better notes.");
    expect(google.driveFile("plan")!.content).toBe(ORIGINAL.replace("Some notes.", "Better notes."));
    const [upload] = uploads(google);
    expect(upload.path).toBe("/upload/drive/v3/files/plan");
    expect(upload.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(google.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("dry_run returns the diff and the note's md5 without writing", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "- one", new_text: "- uno" }], dry_run: true });
    expect(result).toMatchObject({ dry_run: true, changed: true, file_id: "plan", md5: "md5-plan-0", replacements: 1 });
    expect(result.diff).toContain("-- one\n+- uno");
    expect(uploads(google)).toEqual([]);
    expect(google.driveFile("plan")!.content).toBe(ORIGINAL);
  });

  it("writes when expected_md5 matches the note", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "- one", new_text: "- uno" }], expected_md5: "md5-plan-0" });
    expect(result.success).toBe(true);
    expect(google.driveFile("plan")!.content).toContain("- uno");
  });

  it("refuses when expected_md5 no longer matches (changed after the preview)", async () => {
    const { google, deps } = vaultSetup();
    google.touchDriveFile("plan", ORIGINAL + "phone edit\n");
    const result = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "- one", new_text: "- uno" }], expected_md5: "md5-plan-0" });
    expect(result.error).toMatch(/changed since/);
    expect(uploads(google)).toEqual([]);
  });

  it("replaces the whole note with content when expected_md5 is given", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, { path: PATH, content: "# Plan\n\nRewritten.\n", expected_md5: "md5-plan-0" });
    expect(result).toMatchObject({ success: true, mode: "content" });
    expect(google.driveFile("plan")!.content).toBe("# Plan\n\nRewritten.\n");
  });

  it("refuses a whole-note replace without expected_md5, but previews it", async () => {
    const { google, deps } = vaultSetup();
    const refused = await invoke(vaultEdit, deps, { path: PATH, content: "x\n" });
    expect(refused.error).toMatch(/expected_md5/);
    const preview = await invoke(vaultEdit, deps, { path: PATH, content: "x\n", dry_run: true });
    expect(preview).toMatchObject({ dry_run: true, changed: true, md5: "md5-plan-0" });
    expect(uploads(google)).toEqual([]);
  });

  it("requires exactly one of edits and content", async () => {
    const { google, deps } = vaultSetup();
    expect((await invoke(vaultEdit, deps, { path: PATH })).error).toMatch(/either edits or content/);
    const both = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "a", new_text: "b" }], content: "x", expected_md5: "m" });
    expect(both.error).toMatch(/either edits or content/);
    expect(google.calls).toEqual([]);
  });

  it("writes nothing when an edit fails, even if earlier edits matched", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, {
      path: PATH,
      edits: [
        { old_text: "- one", new_text: "- uno" },
        { old_text: "missing", new_text: "x" },
      ],
    });
    expect(result.error).toMatch(/Edit 2: old_text not found/);
    expect(uploads(google)).toEqual([]);
  });

  it("does not upload when the edit changes nothing", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "- one", new_text: "- one" }] });
    expect(result).toMatchObject({ success: true, changed: false, diff: "" });
    expect(uploads(google)).toEqual([]);
  });

  it("refuses to upload when the note changed while it was being read", async () => {
    const { google, deps } = vaultSetup();
    let downloads = 0;
    google.override = (call) => {
      if (call.query.alt === "media" && ++downloads === 1) {
        const response = new Response(ORIGINAL);
        google.touchDriveFile("plan", ORIGINAL + "phone edit\n");
        return response;
      }
      return undefined;
    };
    const result = await invoke(vaultEdit, deps, { path: PATH, edits: [{ old_text: "- one", new_text: "- uno" }] });
    expect(result.error).toMatch(/changed/);
    expect(uploads(google)).toEqual([]);
    expect(google.driveFile("plan")!.content).toContain("phone edit");
  });

  it("refuses the private folder without asking Drive anything", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "private", name: "90_Private", mimeType: FOLDER_MIME, parents: [ROOT] });
    google.addDriveFile({ id: "ttc", name: "TTC.md", mimeType: "text/markdown", parents: ["private"], content: "PRIVATE-MARKER" });
    for (const path of ["90_Private/TTC.md", "90_private/TTC.md"]) {
      const result = await invoke(vaultEdit, deps, { path, edits: [{ old_text: "PRIVATE-MARKER", new_text: "x" }], dry_run: true });
      expect(result.error).toMatch(/private/i);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-MARKER/);
    }
    expect(google.calls).toEqual([]);
  });

  it("refuses missing notes, duplicates, non-text files and oversized notes", async () => {
    const { google, deps } = vaultSetup();
    const edit = [{ old_text: "x", new_text: "y" }];
    expect((await invoke(vaultEdit, deps, { path: "00_Inbox/Missing.md", edits: edit })).error).toMatch(/not found.*vault_find/s);
    google.addDriveFile({ id: "plan-dup", name: "plan.md", mimeType: "text/markdown", parents: ["hermes"], content: "" });
    expect((await invoke(vaultEdit, deps, { path: PATH, edits: edit })).error).toMatch(/2 files/);
    google.addDriveFile({ id: "gdoc", name: "Doc.md", mimeType: "application/vnd.google-apps.document", parents: [ROOT] });
    expect((await invoke(vaultEdit, deps, { path: "Doc.md", edits: edit })).error).toMatch(/not a plain-text/);
    google.addDriveFile({ id: "big", name: "Big.md", mimeType: "text/markdown", parents: [ROOT], content: "x".repeat(1_000_001) });
    expect((await invoke(vaultEdit, deps, { path: "Big.md", edits: edit })).error).toMatch(/too large/);
    expect(uploads(google)).toEqual([]);
  });

  it("refuses a result over the size limit", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultEdit, deps, {
      path: PATH,
      edits: [{ old_text: "Some notes.", new_text: "y".repeat(20_000), replace_all: false }],
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    google.addDriveFile({ id: "near", name: "Near.md", mimeType: "text/markdown", parents: [ROOT], content: "a".repeat(999_990) + "\nEND\n" });
    const tooBig = await invoke(vaultEdit, deps, { path: "Near.md", edits: [{ old_text: "END", new_text: "z".repeat(100) }] });
    expect(tooBig.error).toMatch(/too large/);
    expect(uploads(google)).toEqual([]);
  });

  it("caps edit counts and text lengths in its schema", () => {
    const edit = { old_text: "a", new_text: "b" };
    expect(() => vaultEdit.inputSchema.parse({ path: "a.md", edits: Array(21).fill(edit) })).toThrow();
    expect(() => vaultEdit.inputSchema.parse({ path: "a.md", edits: [{ old_text: "x".repeat(20_001), new_text: "" }] })).toThrow();
    expect(() => vaultEdit.inputSchema.parse({ path: "a.md", content: "x".repeat(1_000_001), expected_md5: "m" })).toThrow();
  });
});

describe("vault_read", () => {
  const PATH = "01_Projects/Hermes/Plan.md";
  const ORIGINAL = "# Plan\n\n## Tasks\n\n- one\n\n## Notes\n\nSome notes.\n";

  it("is registered as a read-only tool", () => {
    expect(TOOL_NAMES).toContain("vault_read");
    expect(vaultRead.readOnly).toBe(true);
  });

  it("returns the note's exact text and md5, case-insensitively, without writing", async () => {
    const { google, deps } = vaultSetup();
    const result = await invoke(vaultRead, deps, { path: "01_projects/hermes/PLAN.md" });
    expect(result).toMatchObject({ path: "01_projects/hermes/PLAN.md", file_id: "plan", md5: "md5-plan-0", content: ORIGINAL });
    expect(google.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("returns an md5 that vault_edit accepts as expected_md5", async () => {
    const { google, deps } = vaultSetup();
    const read = await invoke(vaultRead, deps, { path: PATH });
    const edit = await invoke(vaultEdit, deps, { path: PATH, content: read.content.replace("one", "uno"), expected_md5: read.md5 });
    expect(edit.success).toBe(true);
    expect(google.driveFile("plan")!.content).toBe(ORIGINAL.replace("one", "uno"));
  });

  it("refuses when the note changed while it was being read, so content and md5 always agree", async () => {
    const { google, deps } = vaultSetup();
    google.override = (call) => {
      if (call.query.alt === "media") {
        const response = new Response(ORIGINAL);
        google.touchDriveFile("plan", ORIGINAL + "phone edit\n");
        return response;
      }
      return undefined;
    };
    const result = await invoke(vaultRead, deps, { path: PATH });
    expect(result.error).toMatch(/changed while it was being read/);
    expect(result.content).toBeUndefined();
  });

  it("refuses the private folder without asking Drive anything", async () => {
    const { google, deps } = vaultSetup();
    google.addDriveFile({ id: "private", name: "90_Private", mimeType: FOLDER_MIME, parents: [ROOT] });
    google.addDriveFile({ id: "ttc", name: "TTC.md", mimeType: "text/markdown", parents: ["private"], content: "PRIVATE-MARKER" });
    for (const path of ["90_Private/TTC.md", "90_PRIVATE/TTC.md", "90_private (1)/TTC.md"]) {
      const result = await invoke(vaultRead, deps, { path });
      expect(result.error).toMatch(/private/i);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE-MARKER/);
    }
    expect(google.calls).toEqual([]);
  });

  it("refuses missing notes, duplicates, non-text files and oversized notes without downloading", async () => {
    const { google, deps } = vaultSetup();
    expect((await invoke(vaultRead, deps, { path: "00_Inbox/Missing.md" })).error).toMatch(/not found.*vault_find/s);
    google.addDriveFile({ id: "gdoc", name: "Doc.md", mimeType: "application/vnd.google-apps.document", parents: [ROOT] });
    expect((await invoke(vaultRead, deps, { path: "Doc.md" })).error).toMatch(/not a plain-text/);
    google.addDriveFile({ id: "big", name: "Big.md", mimeType: "text/markdown", parents: [ROOT], content: "x".repeat(1_000_001) });
    expect((await invoke(vaultRead, deps, { path: "Big.md" })).error).toMatch(/too large/);
    google.addDriveFile({ id: "plan-dup", name: "plan.md", mimeType: "text/markdown", parents: ["hermes"], content: "" });
    expect((await invoke(vaultRead, deps, { path: PATH })).error).toMatch(/2 files/);
    expect(google.calls.some((call) => call.query.alt === "media")).toBe(false);
  });

  it("errors when VAULT_FOLDER_ID is not configured", async () => {
    const { google, deps } = vaultSetup(null);
    expect((await invoke(vaultRead, deps, { path: PATH })).error).toMatch(/VAULT_FOLDER_ID/);
    expect(google.calls).toEqual([]);
  });
});
