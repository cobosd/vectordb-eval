import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The eval content (and the harness scripts) live at the repo root. The Next app
 * is at that same root now, but walk up from cwd just in case it's invoked from
 * a sub-directory, so file reads resolve consistently in dev, build, and Vercel.
 */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "evals")) && existsSync(path.join(dir, "NOTES.md"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
