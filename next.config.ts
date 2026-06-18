import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /csv reads evals/csv/*.csv at request time (force-dynamic). Bundle those
  // files into the function so committed runs are readable on Vercel too.
  outputFileTracingIncludes: {
    "/csv": ["./evals/csv/**/*"],
  },
};

export default nextConfig;
