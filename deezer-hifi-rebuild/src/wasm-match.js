import matchModule from "../wasm/match.wasm";

let instancePromise;

export async function getMatcher() {
  if (!instancePromise) {
    instancePromise = Promise.resolve().then(async () => {
      // Wrangler's CompiledWasm import is already a WebAssembly.Module.
      if (matchModule instanceof WebAssembly.Module) {
        return new WebAssembly.Instance(matchModule, {});
      }
      const result = await WebAssembly.instantiate(matchModule, {});
      return result instanceof WebAssembly.Instance ? result : result.instance;
    }).catch(error => {
      instancePromise = undefined;
      throw error;
    });
  }
  return instancePromise;
}

export async function distance(a, b) {
  try {
    const instance = await getMatcher();
    const { memory, input_offset: inputOffset, edit_distance: editDistance } = instance.exports;
    const encoder = new TextEncoder();
    const aBytes = encoder.encode(String(a).slice(0, 512));
    const bBytes = encoder.encode(String(b).slice(0, 512));
    const ptr = inputOffset();
    const bPtr = ptr + 1024;
    const heap = new Uint8Array(memory.buffer);
    heap.set(aBytes, ptr);
    heap.set(bBytes, bPtr);
    const result = editDistance(ptr, aBytes.length, bPtr, bBytes.length);
    if (result >= 0) return result;
  } catch (_) {
    // Keep the API usable if the optional WASM module cannot be instantiated.
  }
  return jsDistance(String(a).slice(0, 256), String(b).slice(0, 256));
}

function jsDistance(a, b) {
  const prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let diagonal = prev[0];
    prev[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const old = prev[i];
      prev[i] = Math.min(prev[i] + 1, prev[i - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return prev[a.length];
}
