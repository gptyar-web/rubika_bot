import { mkdir, cp, rm, writeFile } from "node:fs/promises";
// Deploy an explicit allowlist. Never publish legacy session files, databases, source backups or tests.
const out = "dist";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const path of [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  "assets",
  "js",
])
  await cp(path, out + "/" + path, { recursive: true });
await mkdir(out + "/docs", { recursive: true });
await cp("docs/features.json", out + "/docs/features.json");
await writeFile(out + "/.nojekyll", "");
console.log("Static GitHub Pages bundle created in dist/.");
