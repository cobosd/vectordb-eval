import { unlink } from "node:fs/promises";
import path from "node:path";

import { runsEnabled } from "@/lib/perf/enabled";
import { repoRoot } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

const CSV_DIR = "evals/csv";
const SAFE_NAME = /^[A-Za-z0-9_.\-]+\.csv$/;

export async function DELETE(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  if (!runsEnabled()) {
    return Response.json(
      { error: "Deleting CSVs is disabled in this environment (read-only host)." },
      { status: 503 }
    );
  }

  const { file } = await ctx.params;
  const name = decodeURIComponent(file);
  if (!SAFE_NAME.test(name)) {
    return Response.json({ error: "invalid file name" }, { status: 400 });
  }

  const dir = path.join(repoRoot(), CSV_DIR);
  const target = path.join(dir, name);
  // defense in depth against path traversal
  const rel = path.relative(dir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  try {
    await unlink(target);
    return Response.json({ deleted: name });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 }
    );
  }
}
