import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
