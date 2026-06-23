import { Database, PlayCircle } from "lucide-react";
import Link from "next/link";

import { DashboardClient } from "@/components/DashboardClient";
import { Nav } from "@/components/Nav";
import { loadCsvDocs } from "@/lib/csv-docs";
import { runsEnabled } from "@/lib/perf/enabled";

// Read evals/csv/*.csv at request time so freshly-written runs show up without a rebuild.
export const dynamic = "force-dynamic";

export default async function Page() {
  const docs = await loadCsvDocs();
  const enabled = runsEnabled();

  if (docs.length === 0) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Database className="h-4 w-4" />
          vectordb-eval
        </div>
        <div className="mb-8">
          <Nav active="csv" showRuns={enabled} />
        </div>
        <div className="rounded-xl border bg-card p-12 text-center">
          <h1 className="text-lg font-semibold">No CSV runs yet</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Trigger a benchmark from the run page. Results are written to{" "}
            <code className="rounded bg-muted px-1 py-0.5">evals/csv/</code> and
            will appear here.
          </p>
          <Link
            href="/run"
            className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <PlayCircle className="h-4 w-4" />
            Start a run
          </Link>
        </div>
      </div>
    );
  }

  return (
    <DashboardClient
      docs={docs}
      active="csv"
      pickerLabel="CSV run"
      deletable={enabled}
      showRuns={enabled}
    />
  );
}
