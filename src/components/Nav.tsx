import Link from "next/link";
import { Database, PlayCircle } from "lucide-react";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/csv", label: "CSV runs", key: "csv", Icon: Database },
  { href: "/run", label: "New run", key: "run", Icon: PlayCircle },
] as const;

// CSV analysis is read-only (just reads evals/csv/*.csv) so it's always shown.
// Only the New-run tab needs a host that can execute the runner (vector-DB access +
// writable FS), so it's hidden on read-only deploys where `runsEnabled()` is false.
const RUN_KEYS = new Set(["run"]);

export function Nav({ active, showRuns = true }: { active?: string; showRuns?: boolean }) {
  const links = showRuns ? LINKS : LINKS.filter((l) => !RUN_KEYS.has(l.key));
  return (
    <nav className="flex flex-wrap items-center gap-1">
      {links.map(({ href, label, key, Icon }) => (
        <Link
          key={key}
          href={href}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
            key === active
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
