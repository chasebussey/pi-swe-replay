// Trusted fault fixture. Never imports or executes candidate source.
import { parentPort, workerData } from "node:worker_threads";

parentPort.once("message", (request) => {
  if (workerData.mode === "exit") process.exit(0);
  if (workerData.mode === "throw") throw new Error("fixture worker crash");
  if (workerData.mode === "hang") { setInterval(() => {}, 1000); return; }
  if (workerData.mode === "oom") {
    const items = [];
    for (let index = 0; index < 1000; index++) items.push(new Array(10000).fill(123));
    throw new Error("Fixture heap guard was not applied before the bounded allocation ceiling.");
  }
  if (workerData.mode === "bad-progress") {
    parentPort.postMessage({ type: "progress", phase: "canonicalizing", id: "wrong" });
    return;
  }
  parentPort.postMessage({ type: "progress", phase: "starting" });
  parentPort.postMessage({ type: "progress", phase: "assets-verified" });
  parentPort.postMessage({ type: "progress", phase: "canonicalizing", id: request.sources[0].id });
  if (workerData.mode === "raw-object") parentPort.postMessage({ type: "success" });
  else if (workerData.mode === "bad-json") parentPort.postMessage(new TextEncoder().encode("not json"));
  else if (workerData.mode === "oversize") parentPort.postMessage(new Uint8Array(request.limits.maxResponseBytes + 1));
  else parentPort.postMessage(new TextEncoder().encode(JSON.stringify(workerData.payload)));
});
