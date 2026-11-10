// Explicit manual check: npm installation and approved upstream downloads may use
// the network. Never run as part of node --test tests/*.test.mjs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(path.join(tmpdir(), "tsc-installed-"));
const evidence = { node: process.version, platform: process.platform, architecture: process.arch, commands: [] };
function run(command, args, cwd) {
  evidence.commands.push([command, ...args]);
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", directory], repo));
  assert.ok(packed[0].files.every((file) => !file.path.endsWith(".wasm")), "grammar/runtime dependency binaries must not be vendored in the package");
  const tarball = path.join(directory, packed[0].filename);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "tsc-installed-smoke", private: true, type: "module" }));
  // No ignore-scripts flag: production dependencies must install normally. Pi is
  // a host peer, not needed to exercise this standalone source-normalization API.
  evidence.installOutput = run("npm", ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", tarball], directory);
  const sourceInputs = [
    ["python", "x.py", "x = f'{value + 1}'\n"],
    ["typescript", "x.ts", "const x = `a ${value + 1}`;\n"],
  ];
  writeFileSync(path.join(directory, "smoke.mjs"), `
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { existsSync } from 'node:fs';
import path from 'node:path';
const jiti = createJiti(import.meta.url, { fsCache: false });
const { normalizeTscSources } = await jiti.import('pi-swe-replay/extensions/swe-replay/tree-sitter-normalization.ts');
assert.equal(existsSync('node_modules/tree-sitter-python'), false);
assert.equal(existsSync('node_modules/tree-sitter-typescript'), false);
assert.equal(existsSync('node_modules/pi-swe-replay/node_modules/tree-sitter-python'), false);
assert.equal(existsSync('node_modules/pi-swe-replay/node_modules/tree-sitter-typescript'), false);
assert.equal(existsSync('node_modules/pi-swe-replay/licenses/jiti-MIT.txt'), true);
const cacheDir = path.resolve('cache');
const inputs = ${JSON.stringify(sourceInputs)}.map(([id, name, source]) => ({
 id, path: Buffer.from(name), content: Buffer.from(source),
}));
const live = await normalizeTscSources(inputs, { grammar: { cacheDir } });
assert.ok(live.results.every(value => value.kind === 'canonical'));
globalThis.fetch = () => { throw Error('Host network forbidden after provisioning'); };
process.env.PATH = '';
process.chdir('node_modules');
const offline = await normalizeTscSources(inputs, { grammar: { cacheDir, offline: true } });
assert.deepEqual(offline.results, live.results);
console.log(JSON.stringify({ installedNoGrammarPackages: true, canonicalSources: offline.results.length,
 offlineWorkerAfterCwdChange: true, provenance: offline.provenance, resourceProfile: offline.resourceProfile,
 metrics: offline.results.map(value => ({ id:value.id, ...value.metrics })) }));
`);
  evidence.smoke = JSON.parse(run(process.execPath, [path.join(directory, "smoke.mjs")], directory));
  const lock = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8"));
  evidence.installedPackages = Object.keys(lock.packages).filter((name) => name && !lock.packages[name].peer);
  evidence.packageFiles = packed[0].files.map((file) => file.path).filter((name) => /tree-sitter|jiti-MIT/.test(name));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = String(error);
  evidence.stdout = error.stdout;
  evidence.stderr = error.stderr;
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
