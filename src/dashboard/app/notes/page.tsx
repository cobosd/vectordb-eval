import Link from "next/link";
import { ArrowLeft, Database } from "lucide-react";

import { Markdown } from "@/components/Markdown";
import { loadNotes } from "@/lib/load-evals";

export const dynamic = "force-static";

export const metadata = {
  title: "vectordb-eval · service notes",
};

export default async function NotesPage() {
  const md = await loadNotes();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between gap-4 border-b pb-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Database className="h-4 w-4" />
          vectordb-eval
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
      </header>

      <Markdown className="text-[0.95rem]">{md}</Markdown>
    </div>
  );
}
