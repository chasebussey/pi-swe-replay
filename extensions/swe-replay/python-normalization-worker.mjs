// Plain ESM deliberately: Node workers cannot rely on Pi's TypeScript loader.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

try {
  // All interpreter assets must come from the installed dependency, never a CDN.
  globalThis.fetch = () => { throw new Error("Normalization must not access the network."); };
  const entry = import.meta.resolve("pyodide");
  const packageInfo = JSON.parse(await readFile(new URL("package.json", entry), "utf8"));
  if (packageInfo.version !== workerData.pyodideVersion) {
    throw new Error(`Unsupported Pyodide version: ${packageInfo.version}`);
  }

  const { loadPyodide } = await import("pyodide");
  const runtime = await loadPyodide({ indexURL: fileURLToPath(new URL(".", entry)) });
  const pythonVersion = runtime.runPython("import platform; platform.python_version()");
  if (pythonVersion !== workerData.pythonVersion) {
    throw new Error(`Unsupported bundled Python version: ${pythonVersion}`);
  }

  const source = await readFile(new URL("./agentless-normalization.py", import.meta.url), "utf8");
  runtime.runPython(source);
  runtime.globals.set("requests_json", JSON.stringify(workerData.patches));
  const result = JSON.parse(runtime.runPython("prepare_patches(requests_json)"));
  parentPort.postMessage(result);
} catch (error) {
  parentPort.postMessage({ error: { message: String(error).slice(0, 4000) } });
}
