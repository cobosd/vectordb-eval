import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // This app is a sub-directory of a larger repo (the eval harness lives at the
  // root). Pin the tracing root to this app so Next doesn't try to infer a
  // workspace root from the parent lockfile.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
