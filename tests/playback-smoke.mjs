import assert from "node:assert/strict";
import { createPlaybackToken, validatePlaybackToken, reportListen } from "../src/playback.js";

const env = { API_KEY: "test-only-long-random-key" };
const signed = await createPlaybackToken("3135556", "FLAC", env);
const valid = await validatePlaybackToken(signed.token, env, "3135556");
assert.equal(valid.id, "3135556");
assert.equal(valid.format, "FLAC");
assert.equal(await validatePlaybackToken(signed.token, env, "42"), null);
assert.equal(await validatePlaybackToken(`${signed.token}x`, env, "3135556"), null);

await assert.rejects(
  reportListen({ trackId: "3135556", playToken: signed.token, event: "30" }, env),
  error => error?.code === "LISTEN_START_REQUIRED",
);
console.log("Playback smoke test passed (signed URLs, track binding, tamper rejection, and start-before-30s guard). ");
