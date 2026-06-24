// Parallel orchestrator for the predev/prebuild data pipeline (cross-platform).
//
// Dependency order (verified):
//   build-index            -> reports-index.json            (foundational; all others read it)
//   build-wikilink-hub     -> wikilink-hub-top500.json      (needs index)
//   build-wikilink-stubs   -> wikilink-stubs.json           (needs index + wikilink-hub output)
//   build-themes-index     -> themes-index.json             (needs index)
//   build-sector-stats     -> sector-stats.json             (needs index + financials_store)
//
// Strategy: index first; then hub/themes/sector concurrently; stubs after hub.
// Replaces the old 5-step serial `&&` chain (~40-60% faster cold).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(scriptsDir, "..");

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script)], {
      stdio: "inherit",
      cwd,
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)),
    );
    child.on("error", reject);
  });
}

const t0 = Date.now();
await run("build-index.mjs");
// hub/themes/sector only depend on reports-index.json -> run concurrently
const hub = run("build-wikilink-hub.mjs");
const themes = run("build-themes-index.mjs");
const sector = run("build-sector-stats.mjs");
await hub; // stubs reads wikilink-hub output, so wait for hub specifically
await Promise.all([run("build-wikilink-stubs.mjs"), themes, sector]);
console.error(`[build-data] all indexes built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
