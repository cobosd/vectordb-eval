import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "vectordb-eval · latency dashboard",
  description:
    "Latency benchmark results for Turbopuffer, Pinecone, Qdrant, and OpenSearch.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
