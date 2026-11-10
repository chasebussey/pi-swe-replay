import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { TSC_LANGUAGES, TSC_RUNTIME_ASSET, type TscLanguage } from "./normalization-policy";
import type { TscAssetLocation } from "./tree-sitter-protocol";

/** Bounded reads also cover corrupt installed metadata, not just source inputs. */
async function boundedFile(filename: string, maximum: number, expectedBytes?: number): Promise<Uint8Array> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum || expectedBytes !== undefined && stat.size !== expectedBytes) {
      throw new Error("TSC asset size/kind mismatch.");
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, null);
      if (!bytesRead) throw new Error("TSC asset was truncated while reading.");
      offset += bytesRead;
    }
    const tail = new Uint8Array(1);
    if ((await file.read(tail, 0, 1, null)).bytesRead) throw new Error("TSC asset grew while reading.");
    return bytes;
  } finally {
    await file.close();
  }
}

/** Hash the actual bounded bytes passed to WASM, not merely a previously verified path. */
async function verifiedBytes(filename: string, pin: { bytes: number; sha256: string }): Promise<Uint8Array> {
  const bytes = await boundedFile(filename, pin.bytes, pin.bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error("TSC asset SHA-256 mismatch.");
  return bytes;
}

/** Worker-only runtime setup. No source path is ever imported or executed. */
export async function createOfflineTscParsers(assets: readonly TscAssetLocation[]): Promise<Map<TscLanguage, Parser>> {
  const parsers = new Map<TscLanguage, Parser>();
  const require = createRequire(__filename);
  const directory = dirname(require.resolve("web-tree-sitter"));
  const metadata = await boundedFile(join(directory, "package.json"), 64 * 1024);
  const packageInfo = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(metadata));
  if (packageInfo.version !== TSC_RUNTIME_ASSET.version) throw new Error("Unsupported Tree-sitter runtime version.");
  const runtimeFile = join(directory, TSC_RUNTIME_ASSET.asset);
  const runtimeBytes = await verifiedBytes(runtimeFile, TSC_RUNTIME_ASSET);
  if (!assets.length) return parsers;
  const init = { locateFile: () => runtimeFile, wasmBinary: runtimeBytes };
  await Parser.init(init);

  try {
    for (const asset of assets) {
      const pin = TSC_LANGUAGES.find((entry) => entry.language === asset.language);
      if (!pin) throw new Error("Unsupported grammar language.");
      const bytes = await verifiedBytes(asset.path, pin);
      const language = await Language.load(bytes);
      const parser = new Parser();
      try { parser.setLanguage(language); } catch (error) { parser.delete(); throw error; }
      parsers.set(asset.language, parser);
    }
    return parsers;
  } catch (error) {
    for (const parser of parsers.values()) parser.delete();
    throw error;
  }
}
