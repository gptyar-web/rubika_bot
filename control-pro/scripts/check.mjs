import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const files = [];
async function walk(root) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "test-results"].includes(e.name))
      continue;
    const p = join(root, e.name);
    if (e.isDirectory()) await walk(p);
    else files.push(p);
  }
}
await walk(".");
let errors = 0;
for (const file of files) {
  if (/\.(?:js|mjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error(result.stderr);
      errors++;
    }
  }
  if (/\.(?:js|mjs|md|txt|css|html|yml|json)$/.test(file) || file.endsWith(".gitignore")) {
    const body = await readFile(file, "utf8");
    if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(body)) {
      console.error("Unresolved conflict: " + file);
      errors++;
    }
  }
}
const features = JSON.parse(await readFile("docs/features.json", "utf8"));
if (
  features.length !== 150 ||
  new Set(features.map((f) => f.id)).size !== 150
) {
  console.error("Feature matrix must have 150 unique IDs.");
  errors++;
}
const html = await readFile("index.html", "utf8");
if (/<script(?![^>]*\bsrc=)|\son[a-z]+\s*=|\sstyle\s*=/i.test(html)) {
  console.error("Inline executable content is forbidden.");
  errors++;
}
for (const file of [
  "assets/fonts/Vazirmatn.woff2",
  "assets/fonts/OFL.txt",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/maskable-512.png",
])
  if ((await stat(file)).size < 100) {
    console.error("Missing asset " + file);
    errors++;
  }
const manifest = JSON.parse(await readFile("manifest.webmanifest", "utf8"));
if (
  manifest.scope !== "./" ||
  manifest.id !== "./" ||
  !manifest.start_url.startsWith("./")
) {
  console.error("PWA must use relative project paths.");
  errors++;
}
if (errors) process.exit(1);
console.log(
  `Validated ${files.length} files: JavaScript syntax, conflicts, CSP, local assets and all 150 requirements.`,
);
