import Link from "next/link";
import { BarChart3, Database, FileText, PlayCircle } from "lucide-react";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Dashboard", key: "dashboard", Icon: BarChart3 },
  { href: "/csv", label: "CSV runs", key: "csv", Icon: Database },
  { href: "/run", label: "New run", key: "run", Icon: PlayCircle },
  { href: "/notes", label: "Notes", key: "notes", Icon: FileText },
] as const;

export function Nav({ active }: { active?: string }) {
  return (
    <nav className="flex flex-wrap items-center gap-1">
      {LINKS.map(({ href, label, key, Icon }) => (
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
