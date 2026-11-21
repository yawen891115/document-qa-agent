/**
 * Builds the vector index from files on disk (default: data/samples).
 *
 *   npm run ingest                     # sample documents
 *   npm run ingest -- ~/docs/a.pdf ~/docs/reports/
 *
 * Run it while the API is stopped (the API loads the index at startup),
 * or use the "Load sample docs" button / POST /api/documents instead.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { DisabledWebSearch } from "../src/mcp/webSearchClient.js";
import { detectKind } from "../src/rag/loaders.js";
import { createServices } from "../src/services.js";

async function collectFiles(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return detectKind(target) ? [target] : [];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "README.md")
      .map((e) => collectFiles(join(target, e.name))),
  );
  return nested.flat().sort();
}

const config = loadConfig();
const services = await createServices(config, { web: new DisabledWebSearch() });
// npm runs workspace scripts from apps/server; resolve paths from where the user typed the command.
const baseDir = process.env.INIT_CWD ?? process.cwd();
const targets = process.argv.slice(2).map((p) => resolve(baseDir, p));
for (const target of targets) {
  await stat(target).catch(() => {
    console.error(`Not found: ${target}`);
    process.exit(1);
  });
}
const files = (await Promise.all((targets.length ? targets : [config.paths.samplesDir]).map(collectFiles))).flat();

if (files.length === 0) {
  console.error("No supported files found (.pdf .docx .md .mdx .rst .txt).");
  process.exit(1);
}

const started = performance.now();
const rows = [];
for (const file of files) {
  const { record, duplicate } = await services.kb.ingest(await readFile(file), basename(file));
  rows.push({ file: record.name, kind: record.kind, pages: record.pages ?? "", chunks: record.chunks, status: duplicate ? "already indexed" : "indexed" });
}
console.table(rows);
console.log(
  `${services.kb.list().length} documents, ${services.kb.chunkCount} chunks in ${config.paths.indexDir} ` +
    `(embeddings: ${services.models.embeddingModelName}, ${Math.round(performance.now() - started)} ms)`,
);
await services.close();
