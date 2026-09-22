import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TOKEN_URL is read at import time; point it at a port that refuses connections.
process.env.ANTHROPIC_TOKEN_URL = "http://127.0.0.1:1/v1/oauth/token";
const { buildTokenCurlArgs, refreshTokens, parsePastedState, startOAuthCallbackServer } = await import("./oauth.js");
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

describe("OAuth state verification", () => {
  it("reads the state from each pasted form", () => {
    assert.equal(parsePastedState("abc123#st4te"), "st4te");
    assert.equal(parsePastedState("https://x/callback?code=abc&state=st%3Dte"), "st=te");
    assert.equal(parsePastedState("  abc123  "), null);
  });

  it("ignores a forged callback and still accepts the real one", async () => {
    const server = await startOAuthCallbackServer();
    try {
      const base = `http://localhost:${server.port}/callback`;
      const forged = await fetch(`${base}?code=attacker&state=wrong`);
      assert.equal(forged.status, 400);
      const noState = await fetch(`${base}?error=access_denied`);
      assert.equal(noState.status, 400);

      const real = await fetch(`${base}?code=genuine&state=${encodeURIComponent(server.state)}`);
      assert.equal(real.status, 200);
      assert.equal(await server.waitForCode(), "genuine");
    } finally {
      server.close();
    }
  });
});
