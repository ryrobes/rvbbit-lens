import type { NextConfig } from "next"
import path from "path"
import { fileURLToPath } from "url"

const appRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: appRoot,
  outputFileTracingExcludes: {
    "/api/rvbbit/capabilities/scaffold": [
      "src/**/*",
      "docs/**/*",
      "public/**/*",
      "*.jpeg",
      "*.jpg",
      "*.png",
      "*.mjs",
      "Dockerfile",
      "README.md",
      "docker-entrypoint.sh",
      "eslint.config.mjs",
      "next.config.ts",
      "package-lock.json",
      "package.json",
      "postcss.config.mjs",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
    ],
  },
  turbopack: {
    root: appRoot,
  },
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
