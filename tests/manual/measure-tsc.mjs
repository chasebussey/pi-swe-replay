// Explicit developer probe; no network, source execution, or generated Git artifacts.
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { normalizeTscSources } = await jiti.import("../../extensions/swe-replay/tree-sitter-normalization.ts");
const { TSC_LANGUAGES } = await jiti.import("../../extensions/swe-replay/normalization-policy.ts");
const { TSC_NORMALIZATION_LIMITS } = await jiti.import("../../extensions/swe-replay/tree-sitter-limits.ts");
const cacheDir = await mkdtemp(path.join(tmpdir(), "tsc-measure-"));
const input = (id, language, source) => ({ id, path: Buffer.from(`input.${language === "python" ? "py" : "ts"}`), content: Buffer.from(source) });
const flat = (language, count) => Array.from({ length: count }, (_, index) => language === "python"
  ? `value_${index} = ${index}\n` : `const value_${index} = ${index};\n`).join("");
const workloads = [
  ["python-1000", [input("p", "python", flat("python", 1000))]],
  ["typescript-1000", [input("t", "typescript", flat("typescript", 1000))]],
  ["python-10000", [input("p", "python", flat("python", 10000))]],
  ["typescript-10000", [input("t", "typescript", flat("typescript", 10000))]],
  ["python-19999-near-node-cap", [input("p", "python", flat("python", 19999))]],
  ["python-20000-over-node-cap", [input("p", "python", flat("python", 20000))]],
  ["literal-at-source-byte-cap", [input("p", "python", `x="${"a".repeat(TSC_NORMALIZATION_LIMITS.maxSourceBytes - 5)}"\n`)]],
  ["literal-over-source-byte-cap", [input("p", "python", `x="${"a".repeat(TSC_NORMALIZATION_LIMITS.maxSourceBytes - 4)}"\n`)]],
  ["unicode-literal-256KiB", [input("p", "python", `x="${"😀".repeat(65536)}"\n`)]],
  ["depth-at-256", [input("p", "python", `x=${"(".repeat(252)}1${")".repeat(252)}\n`)]],
  ["depth-over-256", [input("p", "python", `x=${"(".repeat(253)}1${")".repeat(253)}\n`)]],
  ["512-duplicate-sources", Array.from({ length: 512 }, (_, index) => input(`p${index}`, "python", flat("python", 100)))],
  ["257-unique-sources", Array.from({ length: 257 }, (_, index) => input(`p${index}`, "python", `x=${index}\n`))],
  ["invalid-sources-over-batch-nodes", Array.from({ length: 12 }, (_, index) => input(`p${index}`, "python", `def broken_${index}(:\n pass\n${flat("python", 10000)}`))],
];

try {
  for (const pin of TSC_LANGUAGES) {
    await copyFile(path.join(path.dirname(require.resolve(`${pin.package}/package.json`)), pin.asset), path.join(cacheDir, `${pin.sha256}.wasm`));
  }
  const measurements = [];
  for (const [name, sources] of workloads) {
    const started = performance.now();
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    let canonicalizations = 0;
    const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    try {
      const result = await normalizeTscSources(sources, { grammar: { cacheDir, offline: true }, onProgress(event) {
        if (event.phase === "canonicalizing") canonicalizations++;
      } });
      measurements.push({ name, outcome: "success", sourceCount: sources.length,
        inputBytes: sources.reduce((sum, source) => sum + source.content.byteLength, 0),
        metrics: result.results[0]?.metrics, canonicalizations,
        elapsedMs: performance.now() - started, baselineRss, peakProcessRss: peakRss });
    } catch (error) {
      measurements.push({ name, outcome: "failure", code: error.code, limit: error.limit,
        actual: error.actual, maximum: error.maximum, canonicalizations,
        elapsedMs: performance.now() - started, baselineRss, peakProcessRss: peakRss });
    } finally {
      clearInterval(timer);
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch,
    limits: TSC_NORMALIZATION_LIMITS, memoryCaveat: "RSS is whole-process sampled data, not isolated worker peak or a hard memory bound.", measurements }, null, 2));
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
