import { runsEnabled } from "@/lib/perf/enabled";
import { listRuns, MAX_CONCURRENT, runningCount, startRun } from "@/lib/perf/registry";
import { normalizeRunConfig } from "@/lib/perf/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1"; // us-east-1

export async function GET() {
  return Response.json({ enabled: runsEnabled(), runs: listRuns() });
}

export async function POST(req: Request) {
  if (!runsEnabled()) {
    return Response.json(
      {
        error:
          "Perf runs are disabled in this environment. Run the dashboard on a host with vector-DB access (local or in-region EC2).",
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { config, error } = normalizeRunConfig(body);
  if (error || !config) {
    return Response.json({ error: error ?? "invalid run config" }, { status: 400 });
  }

  if (runningCount() >= MAX_CONCURRENT) {
    return Response.json(
      { error: `too many runs in progress (max ${MAX_CONCURRENT}); cancel one first` },
      { status: 409 }
    );
  }

  const summary = startRun(config);
  return Response.json(summary, { status: 201 });
}
