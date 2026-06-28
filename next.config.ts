import type { NextConfig } from "next"
import path from "path"
import { fileURLToPath } from "url"

const appRoot = path.dirname(fileURLToPath(import.meta.url))

// The scaffold route intentionally reads/writes capability bundles from runtime
// paths. Keep Turbopack's NFT trace focused on runtime dependencies, not local
// repo files that happen to exist during a developer build.
const capabilityScaffoldTraceExcludes = [
  "src/**/*",
  "docs/**/*",
  "public/**/*",
  "scratch/**/*",
  "capabilities/**/*",
  "coverage/**/*",
  "test-results/**/*",
  "*.jpeg",
  "*.jpg",
  "*.png",
  "*.mjs",
  "*.config.*",
  "Dockerfile",
  "README*",
  "docker-entrypoint.sh",
  "eslint.config.mjs",
  "next-env.d.ts",
  "next.config.*",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "tsconfig*.json",
  "tsconfig.tsbuildinfo",
]

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: appRoot,
  outputFileTracingExcludes: {
    "/api/rvbbit/capabilities/scaffold": capabilityScaffoldTraceExcludes,
  },
  turbopack: {
    root: appRoot,
    ignoreIssue: [
      {
        path: /next\.config\.ts$/,
        title: "Encountered unexpected file in NFT list",
      },
    ],
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
