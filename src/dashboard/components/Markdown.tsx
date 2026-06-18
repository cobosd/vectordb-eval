import { marked } from "marked";

import { cn } from "@/lib/utils";

marked.setOptions({ gfm: true, breaks: false });

/**
 * Renders trusted, repo-authored markdown. Hook-free so it works in both
 * Server and Client Components (the notes page renders it fully server-side).
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const raw = marked.parse(children, { async: false }) as string;
  // Point any link to NOTES.md (e.g. the eval disclaimer's ../NOTES.md) at the
  // in-app notes route.
  const html = raw.replace(/href="[^"]*NOTES\.md"/g, 'href="/notes"');
  return (
    <div
      className={cn("md text-sm leading-relaxed", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
