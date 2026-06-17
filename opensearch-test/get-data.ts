import { mkdir } from "node:fs/promises";
import { getOpenSearchClient, healthCheckOpenSearch } from "./client";
import { createLogger } from "../logger";

const logger = createLogger("get-data");

const INDEX = "bill";
const DATA_DIR = new URL("../data/", import.meta.url);

const MAX_RESULT_WINDOW = 10000;
const PAGE_SIZE = 100;
const MAX_FROM = MAX_RESULT_WINDOW - PAGE_SIZE; // last page start; from + size must stay within max_result_window (10000)

// GET bill/_search
const QUERY = {
  query: {
    bool: {
      filter: [
        { range: { notification_action_time: { gt: "2026-01-01T00:00:00.000000" } } },
      ],
    },
  },
  sort: [{ notification_action_time: { order: "desc" as const } }],
};

/** Bill-level fields copied onto every extracted text/amendment item. */
type BillContext = {
  bill_uuid: string;
  bill_number_normalized: string;
  notification_action_time: string;
  session_id: number;
  has_dead_progress_status: boolean;
  is_active: boolean;
};

function billContext(source: Record<string, any>): BillContext {
  return {
    bill_uuid: source.bill_uuid,
    bill_number_normalized: source.bill_number_normalized,
    notification_action_time: source.notification_action_time,
    session_id: source.session_id,
    has_dead_progress_status: source.has_dead_progress_status,
    is_active: source.is_active,
  };
}

async function main() {
  await healthCheckOpenSearch();

  const client = getOpenSearchClient();

  await mkdir(DATA_DIR, { recursive: true });

  const textPath = new URL("bill-text.jsonl", DATA_DIR);
  const amendmentPath = new URL("bill-amendment.jsonl", DATA_DIR);

  // Truncate any previous run, then append page-by-page as we fetch.
  const textWriter = Bun.file(textPath).writer();
  const amendmentWriter = Bun.file(amendmentPath).writer();

  let totalHits = 0;
  let textCount = 0;
  let amendmentCount = 0;

  try {
    for (let from = 0; from <= MAX_FROM; from += PAGE_SIZE) {
      logger.info("Running search", { index: INDEX, size: PAGE_SIZE, from });

      const response = await client.search({
        index: INDEX,
        body: { ...QUERY, size: PAGE_SIZE, from },
      });

      const hits = response.body.hits.hits;
      totalHits += hits.length;

      for (const hit of hits) {
        const source = hit._source as Record<string, any>;
        const context = billContext(source);

        for (const text of source.texts ?? []) {
          textWriter.write(JSON.stringify({ ...text, ...context }) + "\n");
          textCount++;
        }
        for (const amendment of source.amendments ?? []) {
          amendmentWriter.write(JSON.stringify({ ...amendment, ...context }) + "\n");
          amendmentCount++;
        }
      }

      // Flush this page to disk before fetching the next one.
      await textWriter.flush();
      await amendmentWriter.flush();

      logger.info("Page appended", {
        from,
        returned: hits.length,
        tookMs: response.body.took,
        textCount,
        amendmentCount,
      });

      // Last page reached before the window — stop early.
      if (hits.length < PAGE_SIZE) break;
    }
  } finally {
    await textWriter.end();
    await amendmentWriter.end();
  }

  logger.info("Done", {
    totalHits,
    billText: textCount,
    billTextPath: textPath.pathname,
    billAmendment: amendmentCount,
    billAmendmentPath: amendmentPath.pathname,
  });
}

main().catch((error) => {
  logger.error("Search failed", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
