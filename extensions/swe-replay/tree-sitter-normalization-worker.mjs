// Explicit trusted-code loader; never inherit Pi loaders or import candidate paths.
import { parentPort } from "node:worker_threads";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

globalThis.fetch = () => { throw new Error("TSC workers must not access the network."); };
const jiti = createJiti(import.meta.url, { fsCache: false, tryNative: false });

parentPort.once("message", async (request) => {
  try {
    const { processTscWorkerRequest } = await jiti.import(fileURLToPath(new URL("./tree-sitter-worker-engine.ts", import.meta.url)));
    const encoded = await processTscWorkerRequest(request, (event) => parentPort.postMessage(event));
    parentPort.postMessage(encoded, [encoded.buffer]);
  } catch (error) {
    const { TscResourceError } = await jiti.import(fileURLToPath(new URL("./tree-sitter-limits.ts", import.meta.url)));
    const failure = error instanceof TscResourceError
      ? { type: "failure", code: "resource-limit", message: String(error).slice(0, 2048), limit: error.limit, actual: error.actual, maximum: error.maximum }
      : { type: "failure", code: "infrastructure", message: String(error).slice(0, 2048) };
    parentPort.postMessage(failure);
  } finally {
    parentPort.close();
  }
});
