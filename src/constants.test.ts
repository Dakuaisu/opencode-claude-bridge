/**
 * Run with: npm test (builds then runs node --test).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { CLAUDE_POOL_SCRIPT, POOL_COMMAND_TEMPLATE } from "./constants.js";

describe("pool CLI script path", () => {
  it("resolves to an existing absolute path, not a $HOME-anchored guess", () => {
    assert.ok(isAbsolute(CLAUDE_POOL_SCRIPT), `${CLAUDE_POOL_SCRIPT} must be absolute`);
    assert.ok(existsSync(CLAUDE_POOL_SCRIPT), `${CLAUDE_POOL_SCRIPT} must exist on disk`);
    assert.ok(
      CLAUDE_POOL_SCRIPT.endsWith("/scripts/claude-pool.mjs"),
      `${CLAUDE_POOL_SCRIPT} must point at the package's claude-pool.mjs`,
    );
    assert.ok(!POOL_COMMAND_TEMPLATE.includes("$HOME"), "template must not hardcode $HOME");
  });

  it("embeds the resolved path shell-quoted in the command template", () => {
    const expected = "!`node '" + CLAUDE_POOL_SCRIPT + "' dashboard`";
    assert.equal(POOL_COMMAND_TEMPLATE.split("\n")[0], expected);
    assert.match(POOL_COMMAND_TEMPLATE, /Output the block above verbatim/);
  });
});
