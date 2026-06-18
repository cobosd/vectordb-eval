import { RunClient } from "@/components/RunClient";
import { runsEnabled } from "@/lib/perf/enabled";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "vectordb-eval · new run",
};

export default function RunPage() {
  return <RunClient enabled={runsEnabled()} />;
}
