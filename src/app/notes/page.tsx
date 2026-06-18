import { Database } from "lucide-react";

import { Markdown } from "@/components/Markdown";
import { Nav } from "@/components/Nav";
import { loadNotes } from "@/lib/load-evals";

export const dynamic = "force-static";

export const metadata = {
  title: "vectordb-eval · service notes",
};

export default async function NotesPage() {
  const md = await loadNotes();
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Database className="h-4 w-4" />
        vectordb-eval
      </div>
      <header className="mb-6 border-b pb-4">
        <Nav active="notes" />
      </header>

      <Markdown className="text-[0.95rem]">{md}</Markdown>
    </div>
  );
}
