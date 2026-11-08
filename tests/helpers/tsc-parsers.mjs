import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { fsCache: false });
export const policy = await jiti.import("../../extensions/swe-replay/normalization-policy.ts");
export const core = await jiti.import("../../extensions/swe-replay/tree-sitter-canonical.ts");
export const sourceCore = await jiti.import("../../extensions/swe-replay/tree-sitter-source.ts");

const packageDirectory = (name) => path.dirname(require.resolve(name === "web-tree-sitter" ? name : `${name}/package.json`));
const assetPath = (pin) => path.join(packageDirectory(pin.package), pin.asset);
function verifyAsset(pin) {
  const filename = assetPath(pin);
  const actual = createHash("sha256").update(readFileSync(filename)).digest("hex");
  assert.equal(actual, pin.sha256, `${pin.package} WASM hash`);
  const metadata = JSON.parse(readFileSync(path.join(packageDirectory(pin.package), "package.json"), "utf8"));
  assert.equal(metadata.version, pin.version, `${pin.package} version`);
  return filename;
}

/** Real pinned WASM, no native grammar binding or ignored research imports. */
export async function createTscParsers() {
  const runtime = verifyAsset(policy.TSC_RUNTIME_ASSET);
  await Parser.init({ locateFile: () => runtime });
  const parsers = new Map();
  try {
    for (const entry of policy.TSC_LANGUAGES) {
      const grammar = await Language.load(verifyAsset(entry));
      const parser = new Parser();
      try {
        parser.setLanguage(grammar);
      } catch (error) {
        parser.delete();
        throw error;
      }
      parsers.set(entry.language, parser);
    }
    return parsers;
  } catch (error) {
    for (const parser of parsers.values()) parser.delete();
    throw error;
  }
}

export function fixtureBytes(source) {
  return Buffer.from(source.content, source.encoding === "utf8" ? "utf8" : "base64");
}
