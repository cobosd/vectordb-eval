import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  fmtMs,
  SERVICE_COLOR,
  SERVICE_LABEL,
  SERVICES,
  type EvalRow,
} from "@/lib/eval-helpers";

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

/**
 * Per-service headline: mean p50 / p95 across the *eventual* view
 * (Turbopuffer eventual rows + the eventual-only services). Fastest p50 wins.
 */
export function StatCards({ rows }: { rows: EvalRow[] }) {
  const stats = SERVICES.map((service) => {
    const view = rows.filter(
      (r) => r.service === service && r.consistency !== "strong"
    );
    return {
      service,
      p50: mean(view.map((r) => r.p50)),
      p95: mean(view.map((r) => r.p95)),
      n: view.length,
    };
  }).filter((s) => s.n > 0);

  const fastest = stats.reduce(
    (best, s) => (s.p50 < best.p50 ? s : best),
    stats[0]!
  );

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => {
        const isBest = s.service === fastest.service;
        return (
          <Card
            key={s.service}
            className={cn(
              "relative overflow-hidden",
              isBest && "ring-1 ring-chart-2/60"
            )}
          >
            <span
              className="absolute inset-y-0 left-0 w-1"
              style={{ backgroundColor: SERVICE_COLOR[s.service] }}
            />
            <CardContent className="p-4 pl-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  {SERVICE_LABEL[s.service]}
                </span>
                {isBest && (
                  <span className="rounded bg-chart-2/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-chart-2">
                    fastest
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-2xl font-semibold tabular-nums">
                  {fmtMs(s.p50)}
                </span>
                <span className="text-xs text-muted-foreground">ms p50</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                p95 {fmtMs(s.p95)} ms · avg over {s.n} configs
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
