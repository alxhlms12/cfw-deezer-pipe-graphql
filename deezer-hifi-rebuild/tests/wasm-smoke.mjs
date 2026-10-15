import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bytes = await readFile(new URL("../wasm/match.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});
const { memory, input_offset: inputOffset, edit_distance: editDistance } = instance.exports;
const ptr = inputOffset();
const a = new TextEncoder().encode("radiohead");
const b = new TextEncoder().encode("radiohed");
const heap = new Uint8Array(memory.buffer);
heap.set(a, ptr);
heap.set(b, ptr + 1024);
assert.equal(editDistance(ptr, a.length, ptr + 1024, b.length), 1);
console.log(`WASM smoke test passed (${bytes.byteLength} bytes).`);
