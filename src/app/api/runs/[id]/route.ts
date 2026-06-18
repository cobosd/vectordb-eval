import { cancel, getSummary } from "@/lib/perf/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const summary = getSummary(id);
  if (!summary) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(summary);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cancelled = cancel(id);
  return Response.json({ cancelled }, { status: cancelled ? 200 : 404 });
}
