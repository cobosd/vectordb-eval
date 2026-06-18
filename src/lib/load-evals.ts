import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseEvalMarkdown, type EvalDoc } from "./eval-data";
import { repoRoot } from "./paths";

export async function loadEvalDocs(): Promise<EvalDoc[]> {
  const dir = path.join(repoRoot(), "evals");
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (f) =>
      parseEvalMarkdown(await readFile(path.join(dir, f), "utf8"), f)
    )
  );
}

export async function loadNotes(): Promise<string> {
  try {
    return await readFile(path.join(repoRoot(), "NOTES.md"), "utf8");
  } catch {
    return "# Notes\n\n`NOTES.md` was not found.";
  }
}
