import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    proxyClientMaxBodySize: "500mb",
  },
  serverExternalPackages: ["pg", "pg-native"],
}

export default nextConfig
