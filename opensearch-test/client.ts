/**
 * OpenSearch client factory and health check. Lazily constructs a single client
 * from the OPENSEARCH_* env vars so importing this module doesn't require them.
 */

import { Client } from "@opensearch-project/opensearch";
import { OPENSEARCH_NODE, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD } from "../config";
import { createLogger } from "../logger";

const logger = createLogger("opensearch");

let opensearchClient: Client | null = null;
let healthCheckCompleted = false;

export function getOpenSearchClient(): Client {
  if (!opensearchClient) {
    if (!OPENSEARCH_NODE) {
      throw new Error(
        "OpenSearch configuration missing. Please set OPENSEARCH_NODE environment variable.",
      );
    }

    if (!OPENSEARCH_USERNAME || !OPENSEARCH_PASSWORD) {
      throw new Error(
        "OpenSearch authentication required. Please set OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD environment variables.",
      );
    }

    opensearchClient = new Client({
      node: OPENSEARCH_NODE,
      auth: {
        username: OPENSEARCH_USERNAME,
        password: OPENSEARCH_PASSWORD,
      },
      ssl: {
        rejectUnauthorized: true,
      },
    });

    logger.info("Client initialized", {
      node: OPENSEARCH_NODE,
      authMethod: "Basic Auth",
    });
  }
  return opensearchClient;
}

export async function healthCheckOpenSearch(): Promise<void> {
  if (healthCheckCompleted) {
    return;
  }

  try {
    const client = getOpenSearchClient();

    logger.info("Running health check...");

    const healthResponse = await client.cluster.health();

    logger.info("✅ Cluster health check successful", {
      clusterName: healthResponse.body.cluster_name,
      status: healthResponse.body.status,
      numberOfNodes: healthResponse.body.number_of_nodes,
      numberOfDataNodes: healthResponse.body.number_of_data_nodes,
    });

    healthCheckCompleted = true;
    logger.info("Health check completed successfully");
  } catch (error) {
    logger.error("❌ Health check failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    logger.warn(
      "Health check failed, but application will continue. Ensure IAM user has proper OpenSearch permissions.",
    );
  }
}
