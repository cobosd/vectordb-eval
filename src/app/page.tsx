import { DashboardClient } from "@/components/DashboardClient";
import { loadEvalDocs } from "@/lib/load-evals";

// Read + parse the eval markdown at build time and bake it in (no runtime FS).
export const dynamic = "force-static";

export default async function Page() {
  const docs = await loadEvalDocs();
  return <DashboardClient docs={docs} />;
}
