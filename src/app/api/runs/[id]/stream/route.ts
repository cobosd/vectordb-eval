import {
  bufferedEvents,
  getSummary,
  isRunning,
  subscribe,
} from "@/lib/perf/registry";
import type { RunEvent } from "@/lib/perf/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getSummary(id)) return new Response("not found", { status: 404 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      const send = (ev: RunEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {}
      };

      // Replay everything buffered so far, then stream live.
      for (const ev of bufferedEvents(id)) send(ev);
      if (!isRunning(id)) {
        close();
        return;
      }

      const unsub = subscribe(id, (ev) => {
        send(ev);
        if (ev.type === "run-done" || ev.type === "run-error") {
          unsub();
          close();
        }
      });
      req.signal.addEventListener("abort", () => {
        unsub();
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
