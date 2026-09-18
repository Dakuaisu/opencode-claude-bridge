/**
 * Regression tests for issues found in the credential-pool security audit.
 * Each case pins a failure mode that is silent and expensive if it returns.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { classify, MAX_TRANSIENT_ATTEMPTS } from "./classifier.js";
import { isCredentialRejected } from "./manager.js";
import { clipFrame } from "./tui.js";
import { createRotationStateStore } from "./rotation-state.js";

const NOW = 1_000_000;

function tempPath(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-sec-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "rotation-state.json");
}

describe("audit M1: bounded short-reset retries", () => {
  it("retries the same account while under the attempt cap", () => {
    const decision = classify({
      status: 429,
      headers: { "retry-after": "30" },
      now: NOW,
      attempt: 0,
    });
    assert.equal(decision.action, "RETRY_SAME");
  });

  it("escalates to rotation once short-reset retries are exhausted", () => {
    const decision = classify({
      status: 429,
      headers: { "retry-after": "30" },
      now: NOW,
      attempt: MAX_TRANSIENT_ATTEMPTS,
    });

    // Without the cap this returns RETRY_SAME forever and the request hangs.
    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 30_000);
  });
});

describe("audit H2: refresh failure classification", () => {
  it("treats a rejected credential as permanent", () => {
    assert.equal(isCredentialRejected("Token refresh failed (400): invalid_grant"), true);
    assert.equal(isCredentialRejected("Token refresh failed (401): unauthorized_client"), true);
    assert.equal(isCredentialRejected("invalid_client"), true);
  });

  it("treats an unreachable or failing endpoint as transient", () => {
    assert.equal(isCredentialRejected("Token refresh failed (500): server error"), false);
    assert.equal(isCredentialRejected("Token refresh failed (429): Rate limited"), false);
    assert.equal(isCredentialRejected("connect ETIMEDOUT 1.2.3.4:443"), false);
    assert.equal(isCredentialRejected("spawn curl ENOENT"), false);
  });
});

describe("re-enrollment restores a disabled account", () => {
  it("clears disabled, cooldown and failure count when fresh credentials arrive", async (t) => {
    const store = createRotationStateStore({ path: tempPath(t), clock: () => NOW });
    await store.markDisabled("alice", "refresh rejected: invalid_grant");
    await store.markCooldown("alice", NOW + 3_600_000, "exhausted");

    await store.resetHealth("alice");

    const account = store.load().accounts.alice;
    // Enrolling new credentials that leave the account disabled would make
    // rotation skip it forever while the CLI reports enrollment succeeded.
    assert.equal(account?.disabled, false);
    assert.equal(account?.cooldownUntil, null);
    assert.equal(account?.failureCount, 0);
  });

  it("creates a healthy account when one does not exist yet", async (t) => {
    const store = createRotationStateStore({ path: tempPath(t), clock: () => NOW });

    await store.resetHealth("bob");

    assert.equal(store.load().accounts.bob?.disabled, false);
  });
});

describe("audit H1: stale lock reclaim requires a dead holder", () => {
  it("does not reclaim an aged lock whose holder is still alive", async (t) => {
    const statePath = tempPath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    // Our own pid: unambiguously alive. Aged far past the stale threshold, as
    // a slow-but-healthy token refresh legitimately would be.
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: 0,
        nonce: "live-holder",
      }),
      { mode: 0o600 },
    );

    // Clock must advance or the acquire loop can never reach its deadline.
    let now = 10_000_000;
    const store = createRotationStateStore({
      path: statePath,
      clock: () => (now += 5),
      staleLockMs: 1_000,
      lockPollMs: 1,
      lockTimeoutMs: 40,
    });

    // Reclaiming here would let a second process refresh the same account
    // concurrently, rotating its refresh token twice and bricking it.
    await assert.rejects(store.withLock(() => undefined), /timed out/);

    const held = JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8"));
    assert.equal(held.nonce, "live-holder");
  });

  it("still reclaims an aged lock from a process that is gone", async (t) => {
    const statePath = tempPath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({
        pid: 2, // pid 2 is not a live node process we can signal
        hostname: "some-other-host",
        acquiredAt: 1_000,
        nonce: "dead-holder",
      }),
      { mode: 0o600 },
    );

    const store = createRotationStateStore({
      path: statePath,
      clock: () => 10_000_000,
      staleLockMs: 1_000,
      lockPollMs: 1,
    });

    let entered = false;
    await store.withLock(() => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  });
});

describe("pool bug sweep regressions (2026-09)", () => {
  it("does not treat a status outside our own prefix as a credential rejection", () => {
    // A gateway body or a network error can contain "(403)"/"(401)". Treating
    // those as rejections permanently disabled healthy accounts, and undoing a
    // disable needs manual operator action.
    assert.equal(
      isCredentialRejected("Token refresh failed (502): <html>Error (403) Forbidden</html>"),
      false,
    );
    assert.equal(
      isCredentialRejected("Token refresh failed: ETIMEDOUT after (401) retries logged"),
      false,
    );
    assert.equal(isCredentialRejected("Token refresh failed (503): upstream busy"), false);
  });

  it("still catches genuine credential rejections", () => {
    assert.equal(isCredentialRejected("Token refresh failed (400): invalid_grant"), true);
    assert.equal(isCredentialRejected("Token refresh failed (401): token revoked"), true);
    assert.equal(isCredentialRejected("provider said invalid_grant"), true);
  });
});

describe("TUI frame clipping", () => {
  it("never emits a line that reaches the terminal width", () => {
    // A line of exactly `columns` characters wraps, so the frame drifts and the
    // previous frame bleeds through — it rendered as duplicated footers and
    // merged text. Enforced at the write point so no caller can reintroduce it.
    const visible = (line: string): number =>
      line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").length;
    const frame = [`${"a".repeat(200)}`, `short`, `${"b".repeat(80)}`].join("\n");
    for (const line of clipFrame(frame, 61).split("\n")) {
      assert.ok(visible(line) <= 61, `line too wide: ${visible(line)}`);
    }
  });

  it("emits exactly one line per terminal row so a shorter frame leaves no tail", () => {
    // Frames change height (expanding a detail pane, a message appearing).
    // Relying on erase-to-end-of-screen left the tail of a taller previous
    // frame on screen, which read as a duplicated footer and stale text merged
    // into the detail pane.
    const tall = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const short = "only one line";
    for (const frame of [tall, short]) {
      const outLines = clipFrame(frame, 40, 8).replace(/\n$/, "").split("\n");
      assert.equal(outLines.length, 8, "frame height must be constant");
    }
    // Padding rows must carry the erase code, not just be blank.
    assert.ok(clipFrame(short, 40, 4).includes("\u001b[K"));
  });

  it("appends the erase code to every line regardless of call site", () => {
    // Requiring each out.push to append EOL was fragile: two detail-pane
    // templates contained nested backticks, a bulk edit silently skipped them,
    // and those lines then displayed fragments of the longer content they
    // overwrote. Centralising it makes the omission impossible.
    const frame = ["\u001b[2m  5h —  7d —\u001b[0m", "plain", "already\u001b[K"].join("\n");
    const lines = clipFrame(frame, 80, 5).replace(/\n$/, "").split("\n");
    assert.ok(
      lines.every((line) => line.endsWith("\u001b[K")),
      "every line must erase its own tail",
    );
    assert.ok(
      !lines.some((line) => line.endsWith("\u001b[K\u001b[K")),
      "must not double up an existing erase code",
    );
  });

  it("preserves escape sequences when clipping", () => {
    const line = `\u001b[2m${"x".repeat(100)}\u001b[0m\u001b[K`;
    const out = clipFrame(line, 10);
    assert.ok(out.includes("\u001b[2m"), "leading style dropped");
    assert.ok(out.includes("\u001b[K"), "erase-to-EOL dropped");
    assert.equal(out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").length, 10);
  });
});
