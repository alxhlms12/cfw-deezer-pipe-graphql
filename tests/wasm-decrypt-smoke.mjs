import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWasmDecryptor } from "../src/wasm-decrypt.js";

// Stable single-stripe reference vectors generated from the prior JavaScript implementation.
const vectors = [
  { key: "3334396b6668246362287b6530616665", sha256: "df70359269522499e9c9fb19c0428a509e912926de91c5d0e0bf8e01c418f3cc" },
  { key: "623d356a673e2468652827373b653230", sha256: "01591a41f5b9fed93da08a02c47609c0291e311182b841d644d22e32bfc0941f" },
  { key: "3b6e376b623172616075773a696c6a31", sha256: "d992cdad3c1ddd14529e324ea6edc81fd5a372614dc3e0c2680f4fa2da5ba585" },
];
for (const vector of vectors) {
  const data = Uint8Array.from({ length: 2048 }, (_, i) => (i * 37 + 11) % 256);
  const decryptor = await createWasmDecryptor(Uint8Array.from(Buffer.from(vector.key, "hex")));
  decryptor.decryptStripe(data);
  const digest = createHash("sha256").update(data).digest("hex");
  assert.equal(digest, vector.sha256, "WASM output must match the legacy JS reference vector");
}

// Mixed absolute block offsets and multiple batches catch skipped/reordered stripes.
const batchVectors = [
  { blocks: 9, startBlock: 5, sha256: "506f43b36e99e22a224857dbf4cf45abd08467ccb4c48916381e7f6f1c692976" },
  { blocks: 96, startBlock: 5, sha256: "89cb0e59aeeab5510d000ff2e392d5ca009c464cfba424a52b57b10fe96df0f1" },
];
for (const vector of batchVectors) {
  const data = Uint8Array.from({ length: vector.blocks * 2048 }, (_, i) => (i * 17 + 9) % 256);
  const decryptor = await createWasmDecryptor(Uint8Array.from(Buffer.from("3334396b6668246362287b6530616665", "hex")));
  decryptor.decryptAligned(data, vector.startBlock);
  const digest = createHash("sha256").update(data).digest("hex");
  assert.equal(digest, vector.sha256, "Batched WASM output must match the legacy JS aligned-decryption reference");
}
console.log("WASM decryption smoke test passed (three stripe vectors and two aligned batch vectors).");
