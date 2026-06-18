import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { EvalDoc } from "./eval-data";
import { repoRoot } from "./paths";
import { parseCsv, toEvalRow } from "./perf/csv";

export const CSV_DIR = "evals/csv";

/** Read every evals/csv/*.csv into the dashboard's EvalDoc shape (newest first). */
export async function loadCsvDocs(): Promise<EvalDoc[]> {
  const dir = path.join(repoRoot(), CSV_DIR);
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".csv"))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const docs = await Promise.all(
    files.map(async (f): Promise<EvalDoc> => {
      const rows = parseCsv(await readFile(path.join(dir, f), "utf8")).map(toEvalRow);
      const stamp = f.replace(/\.csv$/, "");
      return {
        file: f,
        title: `Run ${stamp}`,
        intro: "",
        notes: "",
        rows,
      };
    })
  );
  return docs.filter((d) => d.rows.length > 0);
}
