import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LabelConflictError } from "./enroll.js";
import { createPoolTui } from "./tui.js";
import type { TuiDeps } from "./tui.js";
import type { PoolSnapshot, PoolSnapshotRow } from "./manager.js";

function row(label: string, status: PoolSnapshotRow["status"]): PoolSnapshotRow {
  return {
    label,
    email: null,
    tier: null,
    status,
    cooldownUntil: null,
    reason: null,
    failureCount: 0,
    tokenExpires: 0,
    active: false,
    fiveHourReset: null,
    sevenDayReset: null,
    bindingWindow: null,
    scopes: null,
    rateLimitTier: null,
    enrolledAt: 0,
    updatedAt: null,
  };
}

describe("pool TUI selection", () => {
  it("keeps the selection on the same account when a reload re-sorts the rows", async () => {
    const snapshots: PoolSnapshot[] = [
      { activeLabel: null, now: 0, accounts: [row("b", "ready"), row("c", "ready"), row("a", "cooling")] },
      // "a" finished cooling, so it now sorts first and shifts every row down.
      { activeLabel: null, now: 0, accounts: [row("a", "ready"), row("b", "ready"), row("c", "ready")] },
    ];
    let reloads = 0;
    const activated: string[] = [];

    const tui = createPoolTui({
      pool: {
        snapshot: async () => snapshots[Math.min(reloads++, snapshots.length - 1)]!,
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {
        setActive: async (label: string | null) => {
          if (label) activated.push(label);
        },
      } as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });

    await tui.reload();
    await tui.onKey("j");
    await tui.reload();
    await tui.onKey("a");

    assert.deepEqual(activated, ["c"]);
  });

  it("removing an account also drops its rotation state", async () => {
    const calls: string[] = [];
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("a", "disabled")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {
        removeAccount: async (label: string) => {
          calls.push(`keychain:${label}`);
        },
      } as unknown as TuiDeps["accounts"],
      state: {
        forget: async (label: string) => {
          calls.push(`state:${label}`);
        },
      } as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });

    await tui.reload();
    await tui.onKey("x");
    await tui.onKey("y");

    assert.deepEqual(calls, ["keychain:a", "state:a"]);
  });
});

describe("pool TUI enroll", () => {
  function tuiWithEnroll(enroll: TuiDeps["enroll"]) {
    return createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {} as TuiDeps["state"],
      enroll,
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });
  }

  it("offers to replace a label held by an account with no known email", async () => {
    const calls: Array<{ label?: string; replace?: boolean }> = [];
    const tui = tuiWithEnroll(async (label, options) => {
      calls.push({ label, replace: options?.replace });
      if (!options?.replace) throw new LabelConflictError("alice", null);
      return "alice";
    });

    await tui.onKey("e");
    await tui.onKey("y");

    assert.deepEqual(calls, [
      { label: undefined, replace: undefined },
      { label: "alice", replace: true },
    ]);
  });

  it("does not replace anything when the prompt is declined", async () => {
    const calls: Array<boolean | undefined> = [];
    const tui = tuiWithEnroll(async (_label, options) => {
      calls.push(options?.replace);
      throw new LabelConflictError("alice", null);
    });

    await tui.onKey("e");
    await tui.onKey("n");

    assert.deepEqual(calls, [undefined]);
  });

  it("ignores action keys while an enroll is in flight, so no prompt is queued behind it", async () => {
    const removed: string[] = [];
    let finishEnroll!: (label: string) => void;
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("bob", "ready")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {
        removeAccount: async (label: string) => {
          removed.push(label);
        },
      } as unknown as TuiDeps["accounts"],
      state: { forget: async () => {} } as unknown as TuiDeps["state"],
      enroll: () =>
        new Promise((resolve) => {
          finishEnroll = resolve;
        }),
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });
    await tui.reload();

    const enrolling = tui.onKey("e");
    await tui.onKey("x");
    finishEnroll("alice");
    await enrolling;
    await tui.onKey("y");

    assert.deepEqual(removed, []);
  });

  it("never offers to replace an account that belongs to a known other email", async () => {
    const calls: Array<boolean | undefined> = [];
    const tui = tuiWithEnroll(async (_label, options) => {
      calls.push(options?.replace);
      throw new LabelConflictError("alice", "alice@work.io");
    });

    await tui.onKey("e");
    await tui.onKey("y");

    assert.deepEqual(calls, [undefined]);
  });

  it("quitting while an action is in flight does not redraw over the restored shell", async () => {
    const { EventEmitter } = await import("node:events");
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, setEncoding: () => undefined,
    });
    let restored = false;
    const afterRestore: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 100, rows: 30,
      write(chunk: string) {
        if (restored) afterRestore.push(chunk);
        if (chunk.includes("\u001b[?1049l")) restored = true;
        return true;
      },
    });
    let finishUsage: () => void = () => undefined;
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: "a", now: 0, accounts: [row("a", "ready")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {} as TuiDeps["state"],
      enroll: async () => "",
      fetchUsage: () =>
        new Promise((resolve) => {
          finishUsage = () => resolve({ fiveHour: null, sevenDay: null, extra: null } as never);
        }),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    const started = tui.start();
    await tick();
    stdin.emit("data", "s");
    await tick();
    stdin.emit("data", "q");
    await started;
    finishUsage();
    await tick();

    assert.equal(afterRestore.length, 1);
    assert.match(afterRestore[0]!, /finishing the current action/);
  });
});
