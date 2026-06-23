import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // / reads evals/csv/*.csv at request time (force-dynamic). Bundle those
  // files into the function so committed runs are readable on Vercel too.
  outputFileTracingIncludes: {
    "/": ["./evals/csv/**/*"],
  },
};

export default nextConfig;
