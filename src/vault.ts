/**
 * Obsidian vault helpers for the vault_* tools. The vault is a Drive folder
 * (VAULT_FOLDER_ID) mirrored to a desktop by Drive for desktop; notes are
 * plain `.md` files. Paths are vault-relative, e.g. `01_Projects/Hermes/Plan.md`.
 *
 * Name matching is case-insensitive because the desktop copy lives on a
 * case-insensitive filesystem (NTFS): `plan.md` and `Plan.md` are the same note there.
 */
import type { DriveFile, GoogleClient } from "./google/client";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface VaultPath {
  folders: string[];
  fileName: string;
}

/** Split and validate a vault-relative note path. Throws with a readable message. */
export function parseVaultPath(raw: string): VaultPath {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) throw new Error("Path is empty.");
  if (path.length > 1000) throw new Error("Path is too long.");
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
