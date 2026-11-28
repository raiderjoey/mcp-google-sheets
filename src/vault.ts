/**
 * Obsidian vault helpers for the vault_* tools. The vault is a Drive folder
 * (VAULT_FOLDER_ID) mirrored to a desktop by Drive for desktop; notes are
 * plain `.md` files. Paths are vault-relative, e.g. `01_Projects/Hermes/Plan.md`.
 *
 * Name matching is case-insensitive because the desktop copy lives on a
 * case-insensitive filesystem (NTFS): `plan.md` and `Plan.md` are the same note there.
 *
 * `90_Private/` is the vault's private folder (Vault Conventions, 2026-11-22). No
 * tool here reads or writes it: `parseVaultPath`, which every vault tool goes
 * through, refuses any path with a segment whose name starts with `90_private`,
 * in any letter case and at any depth, so look-alikes and sync-conflict copies
 * are refused too.
 */
import type { DriveFile, GoogleClient } from "./google/client";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface VaultPath {
  folders: string[];
  fileName: string;
}

const PRIVATE_PREFIX = "90_private";
const PRIVATE_ERROR = "That path is in the vault's private folder (90_Private), which this server does not read or write.";

/** True when a path segment names the private folder or a look-alike of it. */
export function isPrivateSegment(segment: string): boolean {
  const key = segment
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\p{Zs}/gu, " ")
    .trim()
    .toLowerCase();
  return key.startsWith(PRIVATE_PREFIX);
}

/** Split and validate a vault-relative note path. Throws with a readable message. */
export function parseVaultPath(raw: string): VaultPath {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) throw new Error("Path is empty.");
  if (path.length > 1000) throw new Error("Path is too long.");
  // First, and without echoing the path: the message must not repeat a private note's name.
  if (path.split("/").some(isPrivateSegment)) throw new Error(PRIVATE_ERROR);
  if (path.endsWith("/")) throw new Error(`'${raw}' is a folder, not a note.`);
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.trim() === "") throw new Error(`'${raw}' has an empty path segment.`);
    if (segment.startsWith(".")) {
      throw new Error(`'${raw}' contains '${segment}'; relative and hidden segments (like .obsidian) are not allowed.`);
    }
  }
  const fileName = segments.pop()!;
  if (!/\.md$/i.test(fileName)) throw new Error(`'${fileName}' is not a Markdown note (.md).`);
  return { folders: segments, fileName };
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every non-trashed child of a folder, across pages. */
export async function listChildren(google: GoogleClient, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await google.drive.filesList({
      q: `'${folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum, size)",
      pageSize: 1000,
      pageToken,
    });
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

export interface ResolvedPath {
  /** ID of the note's folder, or null when some folder on the path is missing. */
  folderId: string | null;
  missingFolders: string[];
  /** Non-folder files in the note's folder whose name matches, ignoring case. */
  matches: DriveFile[];
}

/** Walk the path from the vault root. Throws when a folder name is ambiguous. */
export async function resolveVaultPath(google: GoogleClient, rootId: string, path: VaultPath): Promise<ResolvedPath> {
  let folderId = rootId;
  for (let i = 0; i < path.folders.length; i++) {
    const name = path.folders[i];
    const folders = (await listChildren(google, folderId)).filter(
      (file) => file.mimeType === FOLDER_MIME && sameName(file.name, name),
    );
    if (folders.length === 0) return { folderId: null, missingFolders: path.folders.slice(i), matches: [] };
    if (folders.length > 1) {
      throw new Error(`Folder '${name}' exists ${folders.length} times; fix the duplicate folders in Drive first.`);
    }
    folderId = folders[0].id;
  }
  const matches = (await listChildren(google, folderId)).filter(
    (file) => file.mimeType !== FOLDER_MIME && sameName(file.name, path.fileName),
  );
  return { folderId, missingFolders: [], matches };
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function normalizeHeading(text: string): string {
  return text.replace(/^\s*#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Headings outside frontmatter and fenced code, as [lineIndex, level, text]. */
function findHeadings(lines: string[]): Array<[number, number, string]> {
  const headings: Array<[number, number, string]> = [];
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.findIndex((line, i) => i > 0 && (line === "---" || line === "..."));
    if (end > 0) start = end + 1;
  }
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const fenceMatch = FENCE.exec(lines[i]);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = HEADING.exec(lines[i]);
    if (heading) headings.push([i, heading[1].length, heading[2]]);
  }
  return headings;
}

/**
 * Return `content` with `text` added, either at the end or at the end of the
 * section under `heading` (before the next heading of the same or higher level).
 * Preserves CRLF line endings and a UTF-8 BOM. Throws on empty text or a
 * missing or ambiguous heading.
 */
export function appendMarkdown(content: string, text: string, heading?: string): string {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const body = content.slice(bom.length).replace(/\r\n/g, "\n");
  const addition = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (addition.trim() === "") throw new Error("Text to append is empty.");

  let result: string;
  if (heading === undefined || heading.trim() === "") {
    result = body + (body === "" || body.endsWith("\n") ? "" : "\n") + addition + "\n";
  } else {
    const lines = body.split("\n");
    const headings = findHeadings(lines);
    const wanted = normalizeHeading(heading);
    const hits = headings.filter(([, , title]) => normalizeHeading(title) === wanted);
    if (hits.length === 0) {
      const available = headings.map(([, level, title]) => `${"#".repeat(level)} ${title}`).join(", ") || "none";
      throw new Error(`Heading '${heading}' not found. Headings in this note: ${available}.`);
    }
    if (hits.length > 1) throw new Error(`Heading '${heading}' appears ${hits.length} times; cannot tell which section to use.`);
    const [startLine, level] = hits[0];
    const next = headings.find(([line, lvl]) => line > startLine && lvl <= level);
    const end = next ? next[0] : lines.length;
    let last = startLine;
    for (let i = startLine + 1; i < end; i++) if (lines[i].trim() !== "") last = i;
    lines.splice(last + 1, 0, ...addition.split("\n"));
    result = lines.join("\n");
    if (!result.endsWith("\n")) result += "\n";
  }
  return bom + (eol === "\n" ? result : result.replace(/\n/g, eol));
}

export interface TextEdit {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

/**
 * Return `content` changed by `change`: either find-and-replace `edits`, applied
 * in order (each against the result of the one before), or a whole-note
 * `{ content }` replacement. Matching ignores line-ending style (LF text matches
 * a CRLF note); the note's line endings and UTF-8 BOM are kept. Throws, naming
 * the edit, when an old_text is empty, missing, or matches more than once
 * without replace_all, so a failed call changes nothing.
 */
export function editMarkdown(
  content: string,
  change: TextEdit[] | { content: string },
): { content: string; replacements: number } {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lf = (text: string) => text.replace(/\r\n?/g, "\n");
  let body = lf(content.slice(bom.length));
  let replacements = 0;

  if (Array.isArray(change)) {
    change.forEach((edit, index) => {
      const label = `Edit ${index + 1}`;
      const oldText = lf(edit.old_text);
      const newText = lf(edit.new_text);
      if (oldText === "") throw new Error(`${label}: old_text is empty.`);
      const count = body.split(oldText).length - 1;
      if (count === 0) throw new Error(`${label}: old_text not found in the note (it must match exactly, including spaces).`);
      if (count > 1 && !edit.replace_all) {
        throw new Error(`${label}: old_text appears ${count} times; add surrounding text to make it unique, or set replace_all.`);
      }
      body = body.split(oldText).join(newText);
      replacements += count;
    });
  } else {
    body = lf(change.content.startsWith("﻿") ? change.content.slice(1) : change.content);
    replacements = 1;
  }
  return { content: bom + (eol === "\n" ? body : body.replace(/\n/g, eol)), replacements };
}

/** Largest changed region (lines before x lines after) diffed line by line; bigger ones show as one block. */
const DIFF_CELL_LIMIT = 4_000_000;
const DIFF_CONTEXT = 3;

/**
 * A unified diff (3 lines of context) between two versions of a note, or ""
 * when they are equal. Line endings are normalised first, so a CRLF note
 * diffs cleanly against LF text.
 */
export function unifiedDiff(before: string, after: string, path: string): string {
  const split = (text: string) => {
    const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (body === "") return [];
    const lines = body.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const a = split(before);
  const b = split(after);
  if (a.length === b.length && a.every((line, i) => line === b[i])) return "";

  // Common prefix and suffix, then a line LCS over the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  type Op = [" " | "-" | "+", string];
  const ops: Op[] = a.slice(0, start).map((line): Op => [" ", line]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > DIFF_CELL_LIMIT) {
    ops.push(...midA.map((line): Op => ["-", line]), ...midB.map((line): Op => ["+", line]));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push([" ", midA[i++]]);
        j++;
      } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        ops.push(["-", midA[i++]]);
      } else {
        ops.push(["+", midB[j++]]);
      }
    }
  }
  ops.push(...a.slice(endA).map((line): Op => [" ", line]));

  // Group changes into hunks with DIFF_CONTEXT lines of context.
  const changed = ops.map((op, index) => (op[0] === " " ? -1 : index)).filter((index) => index >= 0);
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let h = 0;
  while (h < changed.length) {
    let hunkEnd = changed[h];
    let next = h;
    while (next + 1 < changed.length && changed[next + 1] - hunkEnd <= 2 * DIFF_CONTEXT) hunkEnd = changed[++next];
    const from = Math.max(0, changed[h] - DIFF_CONTEXT);
    const to = Math.min(ops.length, hunkEnd + DIFF_CONTEXT + 1);
    let oldStart = 1;
    let newStart = 1;
    for (let x = 0; x < from; x++) {
      if (ops[x][0] !== "+") oldStart++;
      if (ops[x][0] !== "-") newStart++;
    }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op[0] !== "+").length;
    const newCount = slice.filter((op) => op[0] !== "-").length;
    const range = (startLine: number, count: number) => `${count === 0 ? startLine - 1 : startLine},${count}`;
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    out.push(...slice.map(([sign, line]) => sign + line));
    h = next + 1;
  }
  return out.join("\n") + "\n";
}
