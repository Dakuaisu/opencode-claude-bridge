# Chapter 11: Known Issues and Gotchas

## What this chapter covers

Writing chapters 01 to 10 meant reading every line of the repository. This chapter collects everything found along the way that looks wrong, risky, surprising, or out of date. Each item says where it is, why it matters, and a suggested fix. Items marked **verified** were re-checked directly against the code while compiling this list; the rest are careful readings of the code that have not been reproduced by running it.

Severity is a judgement call:
- **High**: can lose work, credentials or requests in realistic use.
- **Medium**: wrong behavior in an edge case, or a misleading signal.
- **Low**: cosmetic, documentation, or dead code.

---

## 1. Release and process

| # | Severity | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 1.1 | High | **CI never runs the tests.** The workflow runs `npm ci`, `typecheck` and `build` only. There are 303 tests (all passing on 2026-10-05), but a broken one won't block a merge. **Verified.** | `.github/workflows/ci.yml:17-19` | Add `- run: npm test` |
| 1.2 | High | **Publishing doesn't run tests or wait for CI.** Any push to `main` that changes `package.json` builds and publishes if the version differs from npm's. **Verified.** | `.github/workflows/publish.yml` | Add `npm test` before `npm publish`, or gate publish on CI with `workflow_run` |
| 1.3 | Medium | **The pool has never been versioned.** `package.json` has said `1.10.12` since 2026-07-02. All the pool work (2026-08-20 onward) came after that, so the publish workflow would skip it until the version is bumped. **Verified** from `git log`. | `package.json:3` | Bump the version (likely a minor bump, for example `1.11.0`) when releasing |
| 1.4 | Low | `.npmignore` has no effect, because `"files": ["dist"]` already decides what ships. The compiled `dist/**/*.test.js` files are inside `dist`, so they ship to npm. | `.npmignore`, `package.json:8-10` | Delete `.npmignore`, and exclude tests via `"files": ["dist", "!dist/**/*.test.*"]` or a separate tsconfig for the build |
| 1.5 | Low | No `engines` field, though the code relies on modern Node (CI uses Node 22). | `package.json` | Add `"engines": { "node": ">=18" }` or whatever is actually supported |
| 1.6 | Info | Uncommitted work exists: Sonnet 5.5 model entry and `normalizeThinkingForSonnet55` plus tests. The branch `feat/claude-5-models` also has a "support Claude Sonnet 5.5" commit. These may overlap. | `src/index.ts`, `src/index.test.ts` (working tree) | Decide which branch owns it before committing |

---

## 2. Request pipeline (`src/index.ts`)

| # | Severity | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 2.1 | Medium | **The "Claude API Key" login option can save the placeholder as your key.** In OAuth mode the loader sets `process.env.ANTHROPIC_API_KEY = "oauth-placeholder"`. The API-key method then reads `process.env.ANTHROPIC_API_KEY \|\| savedApiKey`, so if you switch from OAuth to API key in the same session it can store the literal `oauth-placeholder`. **Verified** by reading. | `src/index.ts:891`, `:1539` | Read `savedApiKey` first, or ignore the value `"oauth-placeholder"` |
| 2.2 | Low | A `Request` object's body would be dropped. The wrapper only reads `init?.body` and `init?.method`. If the SDK ever passed a `Request` with its own body and no `init`, the body would be lost and the method forced to POST. The SDK currently calls `fetch(url, init)`, so this is latent. | `src/index.ts:974`, `:1149-1154` | Fall back to `await input.text()` and `input.method` when `input instanceof Request` |
| 2.3 | Low | The billing-line check looks for a billing block *anywhere* in `system`, but then reads index 0 as "the" billing line. | `src/index.ts:1044-1058` | Find the billing block's actual index |
| 2.4 | Medium | **When a captured Claude Code system prompt exists, OpenCode's whole system prompt is thrown away**, including project instructions (`AGENTS.md`), environment info and plugin instructions. This is deliberate (to match Claude Code), but it's easy to miss. | `src/index.ts:1060-1069` | Document it prominently. Optionally append OpenCode's instructions after the captured prompt. |
| 2.5 | Low | The OAuth profile lookup (used for `metadata.user_id`) runs on the request path with no timeout. A hanging profile endpoint would stall the first request for each new access token. | `src/index.ts:695-721` | Add an `AbortSignal.timeout(...)` |
| 2.6 | Medium | **A stored API key gets replaced by OAuth.** The loader's auto-bootstrap runs whenever `auth.type !== "oauth"`, which includes `"apikey"`. If the pool is active, or the Claude CLI holds a valid login, it overwrites the stored API key with OAuth tokens before the API-key branch at `:878` is reached. **Verified** by reading. | `src/index.ts:862-875` | Only auto-bootstrap when no credential is stored (`auth.type` undefined) |
| 2.7 | Low | The cache path is built from `process.env.HOME \|\| ""`, so with `HOME` unset it becomes a relative path. | `src/index.ts:365-366` | Use `os.homedir()` |
| 2.8 | Low | The comment says "Save and clear ANTHROPIC_API_KEY", but init only saves it. The comment above the transform hook still describes registering `/claude-pool`, which was archived. | `src/index.ts:726`, `:824-828` | Fix the comments |
| 2.9 | Info | `tool_choice` is deleted from every request, with no comment explaining why. Forced tool use from OpenCode therefore never reaches the API. | `src/index.ts:1083` | Add a one-line reason, or forward it when it's valid |

---

## 3. Tools and streaming

| # | Severity | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 3.1 | Low | **The README overstates the tool list.** It says all 16 Claude-only stub tools are added and all 26 tools are sent. Since commit `8256d63`, only tools OpenCode actually enabled are sent. The 13 unmapped stubs are never sent. **Verified.** | `README.md:69-79` vs `src/index.ts:327-362` | Update the README |
| 3.2 | Low | The README says MCP tools are "prefixed with `mcp_`". Nothing adds a prefix (`TOOL_PREFIX` is unused); the code only recognizes `mcp_`-prefixed names. The README also lists an `x-claude-code-version` header that the code never sets. | `README.md:64-67`, `src/constants.ts:138` | Update the README |
| 3.3 | Info | Several Claude-only arguments are silently dropped inbound, for example Grep `-i`, `-n`, context lines and `output_mode`; Bash `run_in_background`; Read `pages`. The model may think it asked for case-insensitive search and not get it. | `src/claude-tools.ts:173-180` | Map the ones OpenCode can honor, or document the loss |
| 3.4 | Info | Tool-call arguments are no longer streamed incrementally. They arrive in one piece when each block closes. That's intentional, for correct translation. | `src/stream.ts:153-167` | None needed; just be aware of it |

---

## 4. Account pool

| # | Severity | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 4.1 | Medium | **`retry-after` beats the binding usage window.** When a 429 says the account's usage window is rejected *and* carries a short `retry-after`, the cooldown uses `retry-after`, because it is first in the fallback order. The account may come back early, fail again and bounce. **Verified.** | `src/pool/classifier.ts:349-371` | When `unifiedStatusRejects`, prefer the reset of the window named by `representative-claim` |
| 4.2 | Medium | **An unreadable lock file can block for up to 3 minutes.** If the lock file exists but can't be parsed (a torn write), the waiter sleeps until it's older than `staleLockMs` (180 s) and skips the 10 s deadline check, which comes later in the loop. **Verified.** | `src/pool/rotation-state.ts:270-287` | Check the deadline in that branch too |
| 4.3 | Low | A dead lock holder whose process id has been reused by another process looks alive, so its lock is never reclaimed until someone deletes it. | `src/pool/rotation-state.ts` (`holderIsGone`) | Also record process start time, or cap how long a lock is honored |
| 4.4 | Low | Every request does disk and keychain work. `acquire()` mirrors into OpenCode's `auth.json` on every call, and `markSuccess` rewrites and fsyncs `rotation-state.json` after every success. **Verified** (mirror). | `src/pool/manager.ts:399` | Skip the mirror and the write when nothing changed |
| 4.5 | Low | A corrupt `rotation-state.json` silently resets every cooldown and disabled flag, which re-enables accounts that were disabled for good reason. | `src/pool/rotation-state.ts` (load) | Log loudly and keep a backup copy |
| 4.6 | Low | 403 "suspension" detection is a plain substring match on the body (`suspended`, `disabled`, `banned`, `deactivated`, `revoked`). An unrelated 403 message containing one of those words could permanently disable an account. That only happens once another account succeeds, which softens it. | `src/pool/classifier.ts:30-36`, `:330-339` | Match on the error `type`/`message` fields only |
| 4.7 | Low | The README's rotation table says a 401 disables the account. The disable is actually deferred until another account succeeds with the same request. The table also omits the 1-hour cooldown for an ordinary 403 and the 5xx retry ladder. | `README.md:210-218` vs `src/index.ts:1244-1249` | Update the table (chapter 06 has the full one) |
| 4.8 | Info | In single-account mode a 429 triggers a token refresh, on the assumption that limits are per access token. Subscription limits are per account, so the refresh mostly just spends a refresh token. A refresh failure there is reported to OpenCode as a 401. | `src/index.ts:1333-1357` | Consider retrying with backoff without refreshing |

---

## 5. Enrollment, CLI and terminal UI

| # | Severity | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 5.1 | Medium | **A bare Esc wedges the interactive manager.** `decodeKeys` holds a lone `ESC` in `pendingEscape` and prepends it to the next chunk. `ESC` followed by `q` is not a valid escape sequence, so it is held again, and every later keypress, including `q`, is swallowed. **Verified** by reading; not reproduced live. | `src/pool/tui.ts:478-491`, `:703-704` | Treat a held ESC as a bare Esc key if the next chunk doesn't continue a sequence, or after a short timeout |
| 5.2 | Low | The empty-pool guard for auto-enrollment lives only in the plugin. `autoEnrollIfNew` itself doesn't check, so `claude-pool auto` and the shell hook enroll even into an empty pool. The README implies auto-enrollment requires one account already enrolled. **Verified.** | `src/pool/enroll.ts:326-360`, `scripts/claude-pool.mjs:153`, `src/index.ts:748` | Move the guard into `autoEnrollIfNew`, or document the CLI behavior |
| 5.3 | Low | `claude-pool remove` with no label prints a stack trace. `whoami` compares emails case-sensitively. `clear-cooldowns` keeps `lastReason`. | `scripts/claude-pool.mjs` (around `:218`, `:245`) | Small CLI polish |
| 5.4 | Low | Comments say the usage-refresh key is `U`; the code uses `s`. `dashboard()`'s doc comment predates the TUI. The TUI has some dead helpers (`line()`, `lastFrameLines`). | `src/pool/tui.ts:437`, `scripts/claude-pool.mjs:283`, `:325` | Fix the comments and delete the dead code |
| 5.5 | Low | The TUI's signal handlers force an exit even in the middle of a token refresh. The journal makes this recoverable, but it is the exact window the journal exists for. | `src/pool/tui.ts` | Wait for any in-flight refresh before exiting |
| 5.6 | Low | `install-hook` puts a percent-encoded, unquoted path into the shell snippet. A home directory with spaces or special characters would break it. | `scripts/claude-pool.mjs` (`installHook`) | Quote the path |

---

## 6. Scripts

| # | Severity | Issue | Where | Suggested fix |
|---|---|---|---|---|
| 6.1 | Medium | **Unredacted bearer tokens are written to `/tmp`.** `intercept-claude.sh` saves the full request headers, including `authorization`, to `/tmp/claude-intercept-*-headers.json`, which other local users may be able to read depending on your umask. The validator also saves full request and response bodies under `tmp/validate-*`. | `scripts/intercept-claude.sh:25-31`, `scripts/validate-opencode-oauth.js` | Redact `authorization`, write with mode `0600`, and delete after use |
| 6.2 | Low | `SETUP.md` says the QA harness should report "6/6 scenarios passed", but `qa-rotation.mjs` defines 10 scenarios (`s1` to `s10`). **Verified.** | `SETUP.md:216`, `scripts/qa-rotation.mjs:391` | Update to 10/10 |
| 6.3 | Low | The validator ignores `CLAUDE_CONFIG_DIR` and hard-codes the user agent `claude-cli/2.1.98`. Its "Missing built plugin" message can't be reached, and its "first message" capture actually returns the last request. | `scripts/validate-opencode-oauth.js:68`, `:90-96`, `:478` | Reuse the plugin's helpers from `dist/` |

---

## 7. Dead code and configuration drift

| # | Item | Where |
|---|---|---|
| 7.1 | `TOOL_PREFIX` is never used | `src/constants.ts:138` |
| 7.2 | `POOL_COMMAND_NAME`, `POOL_COMMAND_TEMPLATE` (which hard-codes `$HOME/src/opencode-claude-bridge`), and `POOL_COMMAND_MODEL` are leftovers from the archived slash command | `src/constants.ts:150-171`, `docs/archived/slash-command.md` |
| 7.3 | `POOL_DASHBOARD_TOAST_DURATION_MS` is imported but never used | `src/index.ts:28` |
| 7.4 | 13 of the 16 `STUB_TOOLS` definitions can never be sent; `STUB_TOOL_NAMES`/`SHARED_TOOL_NAMES` are only used by tests | `src/claude-tools.ts:676-944`, `:979-982` |
| 7.5 | The README's environment table omits about 10 variables the code reads, for example `ANTHROPIC_USAGE_URL`, `ANTHROPIC_PROFILE_URL`, `ANTHROPIC_USER_AGENT`, `CLAUDE_POOL_*` and `CLAUDE_CONFIG_DIR`. The full list is in chapter 10. | `README.md:264-283` |
| 7.6 | `CLAUDE_CONFIG_DIR` is honored by `keychain.ts` and enrollment but not by version detection or the validator | `src/constants.ts:30`, `scripts/validate-opencode-oauth.js:68` |
| 7.7 | The README's Architecture section omits `src/pool/` and `src/stream.ts` and has stale line counts | `README.md:329-344` |
| 7.8 | A doc comment in `bridge.ts` sits above the wrong function | `src/pool/bridge.ts:43-50` |

---

## 8. Gotchas for users (working as designed)

These aren't bugs, but they surprise people:

- **After the pool refreshes an account, the Claude CLI's own copy of that login stops working.** Refresh tokens are single-use. Use `claude-pool list` rather than trusting the CLI. If the pool and the CLI share a login, the plugin warns at startup.
- **`claude login` replaces the CLI's single stored login.** Enroll each account right after logging in to it.
- **macOS may ask for your login password on keychain access** until you set the pooled items to "Always Allow" (see `SETUP.md`).
- **Rotation can't happen mid-stream.** If a limit is hit after the reply has started streaming, the error passes through.
- **The captured system prompt is per machine.** Without running the validator once (chapter 08), the bridge falls back to OpenCode's prompt with "OpenCode" replaced by "Claude Code".
- **The CLI version matters.** If `claude` isn't installed, the bridge advertises version `2.1.98`, which newer models reject. Set `ANTHROPIC_CLI_VERSION` in that case.
- **Policy risk.** As the README itself says, Anthropic asks third-party tools to use API keys.

---

## Key takeaways

- The biggest process gaps: CI and publishing never run the 303 passing tests, and the pool work is unreleased because the version hasn't been bumped.
- The most user-visible bugs: the Esc key wedging the TUI, `retry-after` shortening a usage-window cooldown, and the API-key login possibly saving `oauth-placeholder`.
- The repository README has drifted from the code in several places (tool list, `mcp_` prefix, rotation table, environment variables, architecture). These chapters follow the code.

## Related chapters

[03](03-request-pipeline.md) request pipeline, [04](04-tools-and-translation.md) tools, [05](05-account-pool-overview.md) pool, [06](06-rotation-and-failure-handling.md) rotation, [07](07-enrollment-and-claude-pool-cli.md) CLI and TUI, [08](08-scripts-validation-and-qa.md) scripts, [09](09-build-test-ci-release.md) CI, [10](10-configuration-and-files-reference.md) configuration.
