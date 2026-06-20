import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Raised so the CSV importer can stream multi-GB uploads to
    // /api/db/import/run. The route consumes the body as a stream (never
    // buffering it), so a high cap doesn't risk memory.
    proxyClientMaxBodySize: "8gb",
  },
  // ssh2 (DB tunneling) dynamically loads a native crypto binding; keep it (and
  // its optional cpu-features dep) external so it's a runtime Node require, not bundled.
  serverExternalPackages: ["pg", "pg-native", "ssh2", "cpu-features"],
}

export default nextConfig
