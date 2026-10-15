import decryptModule from "../wasm/decrypt.wasm";

const STRIPE_SIZE = 2048;
const MAX_BATCH_STRIPES = 24;
const MAX_CACHED_CIPHERS = 64;
let modulePromise;
const cipherCache = new Map();

async function getModule() {
  if (!modulePromise) {
    modulePromise = Promise.resolve().then(async () => {
      // Wrangler's CompiledWasm binding is already a WebAssembly.Module.
      if (decryptModule instanceof WebAssembly.Module) return decryptModule;
      const result = await WebAssembly.instantiate(decryptModule, {});
      return result.module;
    }).catch(error => {
      modulePromise = undefined;
      throw error;
    });
  }
  return modulePromise;
}

export async function createWasmDecryptor(keyBytes) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length < 1 || keyBytes.length > 56) {
    throw new TypeError("WASM decryptor requires a Blowfish key of 1–56 bytes.");
  }
  const cacheKey = Array.from(keyBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const cached = cipherCache.get(cacheKey);
  if (cached) {
    // Reusing an instance avoids repeating the Blowfish key schedule. Decryption
    // itself is synchronous, so one Worker isolate cannot interleave its scratch
    // memory operations between two calls.
    cipherCache.delete(cacheKey);
    cipherCache.set(cacheKey, cached);
    return cached;
  }
  const creation = createDecryptorInstance(keyBytes);
  cipherCache.set(cacheKey, creation);
  while (cipherCache.size > MAX_CACHED_CIPHERS) cipherCache.delete(cipherCache.keys().next().value);
  try {
    return await creation;
  } catch (error) {
    if (cipherCache.get(cacheKey) === creation) cipherCache.delete(cacheKey);
    throw error;
  }
}

async function createDecryptorInstance(keyBytes) {
  const mod = await getModule();
  const instance = new WebAssembly.Instance(mod, {});
  const {
    memory,
    input_offset: inputOffsetFn,
    init_key: initKey,
    decrypt_stripe: decryptStripeFn,
    decrypt_stripes: decryptStripesFn,
  } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof initKey !== "function" ||
      typeof decryptStripeFn !== "function" || typeof decryptStripesFn !== "function") {
    throw new Error("The compiled WASM decryptor exports are incomplete.");
  }
  const inputOffset = inputOffsetFn();
  const keyOffset = inputOffset + STRIPE_SIZE;
  let heap = new Uint8Array(memory.buffer);
  heap.set(keyBytes, keyOffset);
  if (initKey(keyOffset, keyBytes.length) !== 0) throw new Error("The WASM decryptor rejected its key.");

  function decryptStripe(buffer, offset = 0) {
    if (!(buffer instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0 || offset + STRIPE_SIZE > buffer.byteLength) {
      throw new RangeError("A complete 2048-byte stripe is required.");
    }
    heap = new Uint8Array(memory.buffer);
    heap.set(buffer.subarray(offset, offset + STRIPE_SIZE), inputOffset);
    if (decryptStripeFn(inputOffset) !== 0) throw new Error("WASM stripe decryption failed.");
    buffer.set(heap.subarray(inputOffset, inputOffset + STRIPE_SIZE), offset);
  }

  // Deezer only encrypts each third 2048-byte block. Gather those blocks into
  // contiguous WASM memory and decrypt them in one call per batch, minimizing
  // JS/WASM boundary crossings while preserving the original block alignment.
  function decryptAligned(buffer, startBlock = 0, abortSignal = null) {
    if (!(buffer instanceof Uint8Array) || buffer.byteLength % STRIPE_SIZE !== 0 ||
        !Number.isSafeInteger(startBlock) || startBlock < 0) {
      throw new RangeError("Aligned decryption requires whole 2048-byte blocks and a non-negative block index.");
    }
    const offsets = [];
    for (let offset = 0, block = 0; offset < buffer.byteLength; offset += STRIPE_SIZE, block++) {
      if (abortSignal?.aborted) throw new DOMException("Client aborted the stream request", "AbortError");
      if ((startBlock + block) % 3 !== 0) continue;
      offsets.push(offset);
      if (offsets.length === MAX_BATCH_STRIPES) {
        decryptBatch(buffer, offsets);
        offsets.length = 0;
      }
    }
    if (offsets.length) decryptBatch(buffer, offsets);
  }

  function decryptBatch(buffer, offsets) {
    heap = new Uint8Array(memory.buffer);
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i];
      heap.set(buffer.subarray(offset, offset + STRIPE_SIZE), inputOffset + i * STRIPE_SIZE);
    }
    if (decryptStripesFn(inputOffset, offsets.length) !== offsets.length) {
      throw new Error("WASM batch stripe decryption failed.");
    }
    // Refresh the view after the call in case the module memory was grown.
    heap = new Uint8Array(memory.buffer);
    for (let i = 0; i < offsets.length; i++) {
      const wasmOffset = inputOffset + i * STRIPE_SIZE;
      buffer.set(heap.subarray(wasmOffset, wasmOffset + STRIPE_SIZE), offsets[i]);
    }
  }

  return { decryptStripe, decryptAligned };
}
