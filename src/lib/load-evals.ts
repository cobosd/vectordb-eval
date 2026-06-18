import "server-only";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseEvalMarkdown, type EvalDoc } from "./eval-data";

/**
 * The eval markdown lives at the repo root (`evals/`, `NOTES.md`), one level up
 * from this Next app. Walk up from cwd to find it — works whether the build
 * runs from this app directory (Vercel root = src/dashboard) or the repo root.
 */
function findContentRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(path.join(dir, "evals")) &&
      existsSync(path.join(dir, "NOTES.md"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export async function loadEvalDocs(): Promise<EvalDoc[]> {
  const dir = path.join(findContentRoot(), "evals");
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
    return await readFile(path.join(findContentRoot(), "NOTES.md"), "utf8");
  } catch {
    return "# Notes\n\n`NOTES.md` was not found.";
  }
}
