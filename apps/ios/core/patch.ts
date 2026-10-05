// Unified diff parsing and permission-request formatting, shared by the
// session render model and the Diff and approval screens.
export interface DiffLine {
  type: "add" | "del" | "ctx" | "hunk";
  oldNo?: number;
  newNo?: number;
  text: string;
}
export interface PatchFile {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      file = { path: match?.[1] ?? line.slice(11), additions: 0, deletions: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!file) {
        file = { path: "", additions: 0, deletions: 0, lines: [] };
        files.push(file);
      }
      const target = line.slice(4).replace(/^b\//, "");
      if (target !== "/dev/null") file.path = target;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (file && !file.path) file.path = line.slice(4).replace(/^a\//, "");
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      file.additions++;
      file.lines.push({ type: "add", newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      file.deletions++;
      file.lines.push({ type: "del", oldNo: oldNo++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      file.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
  }
  return files.filter((f) => f.path);
}

// ---------- permission requests ----------

function parseDetail(detail: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(detail);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One readable line for a request: the command, path or first meaningful line. */
export function requestSummary(detail: string) {
  const input = parseDetail(detail);
  for (const key of ["command", "file_path", "path", "url", "query", "pattern"])
    if (typeof input?.[key] === "string") return (input[key] as string).split("\n")[0];
  return detail.split("\n").find((l) => l.trim() && !/^[{}[\]]$/.test(l.trim()))?.trim() ?? "";
}

/** Splits a request into its main body (command/path) and small key/value facts. */
export function describeRequest(detail: string) {
  const input = parseDetail(detail);
  const str = (k: string) => (typeof input?.[k] === "string" ? (input[k] as string) : undefined);
  const fields: [string, string][] = [];
  const cwd = str("cwd") ?? str("workdir");
  if (cwd) fields.push(["Directory", cwd.split("/").filter(Boolean).pop() + "/"]);
  if (str("command")) return { label: "Command", body: str("command")!, fields };
  const file = str("file_path") ?? str("path");
  if (file) {
    const rest = { ...input };
    delete rest.file_path;
    delete rest.path;
    const extra = Object.keys(rest).length ? "\n\n" + JSON.stringify(rest, null, 2) : "";
    return { label: "File", body: file + extra, fields };
  }
  return { label: "Request", body: detail, fields };
}
