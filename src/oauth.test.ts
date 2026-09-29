import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TOKEN_URL is read at import time; point it at a port that refuses connections.
process.env.ANTHROPIC_TOKEN_URL = "http://127.0.0.1:1/v1/oauth/token";
const { buildTokenCurlArgs, refreshTokens } = await import("./oauth.js");
const { isCredentialRejected } = await import("./pool/manager.js");

describe("token endpoint secret handling", () => {
  it("never places the request payload in curl's argv", () => {
    const args = buildTokenCurlArgs();
    assert.deepEqual(args.slice(-2), ["--data-binary", "@-"]);
    assert.ok(!args.some((arg) => arg.includes("refresh_token")));
  });

  it("does not leak the refresh token when the endpoint is unreachable", async () => {
    const secret = "sk-ant-ort01-TEST-SECRET-VALUE";
    let caught: unknown;
    try {
      await refreshTokens(secret);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "expected refreshTokens to throw");
    assert.ok(!caught.message.includes(secret), caught.message);
    assert.match(caught.message, /^Token endpoint unreachable: /);
    // A network failure must cool the account, never permanently disable it.
    assert.equal(isCredentialRejected(caught.message), false);
  });
});
