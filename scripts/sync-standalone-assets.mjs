import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = path.join(root, ".next", "standalone");

if (!existsSync(standaloneRoot)) {
  process.exit(0);
}

const copies = [
  {
    label: "static assets",
    source: path.join(root, ".next", "static"),
    target: path.join(standaloneRoot, ".next", "static"),
  },
  {
    label: "public assets",
    source: path.join(root, "public"),
    target: path.join(standaloneRoot, "public"),
  },
];

for (const copy of copies) {
  if (!existsSync(copy.source)) continue;
  mkdirSync(path.dirname(copy.target), { recursive: true });
  rmSync(copy.target, { recursive: true, force: true });
  cpSync(copy.source, copy.target, { recursive: true });
  console.log(`synced standalone ${copy.label}`);
}
