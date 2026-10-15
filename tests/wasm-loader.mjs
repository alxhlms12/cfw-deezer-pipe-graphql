import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".wasm")) {
    const bytes = await readFile(fileURLToPath(url));
    return {
      format: "module",
      shortCircuit: true,
      source: `export default new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...bytes])}));`,
    };
  }
  return nextLoad(url, context);
}
