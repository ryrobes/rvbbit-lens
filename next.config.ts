import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Raised so the CSV importer can stream multi-GB uploads to
    // /api/db/import/run. The route consumes the body as a stream (never
    // buffering it), so a high cap doesn't risk memory.
    proxyClientMaxBodySize: "8gb",
  },
  serverExternalPackages: ["pg", "pg-native"],
}

export default nextConfig
