# claude-limit-watch

Auto-resume for Claude Code sessions that hit the 5-hour usage limit.

When a session crosses 85% of the 5-hour window, a hook tells the model to
schedule a one-shot in-session cron (via the CronCreate tool) that fires
`continue` two minutes after the window resets. A session that later freezes
at 100% mid-task wakes up on its own and finishes the work.

## How it works

Claude Code never passes rate-limit data to hooks. Only the status line
receives it. So the setup is two small Node scripts:

- `hooks/limit-statusline.mjs` renders a status line (model, directory,
  5-hour and 7-day usage with reset times) and, on every refresh, caches the
  `rate_limits` block from stdin to `~/.claude/rate-limit-state.json`.
- `hooks/limit-watch.mjs` runs on `PostToolUse` (every tool call, empty
  matcher) and on `Stop`. It reads the cache; at or above the threshold it
  injects `additionalContext` instructing the model to call CronCreate with a
  schedule computed as reset time plus two minutes and the prompt `continue`,
  as its next tool call. It nags at most once per cooldown per session per
  reset window, and re-arms automatically each new window.

No LLM is involved in the hook itself. It is a plain Node process, silent and
free on every event below the threshold. The only token cost is the injected
instruction (about 120 tokens) plus one CronCreate call when it trips.

## Install (one command)

```sh
npx github:JohannHinrik/claude-limit-watch
```

(or `git clone` this repo and run `node install.mjs`; add `--yes` to accept
all defaults non-interactively)

The installer runs in your shell, outside Claude Code's permission system, so
it can do everything in one guided pass: register the plugin via the `claude`
CLI (or fall back to wiring the hooks into settings directly if the CLI is
missing), install the status line — asking before touching an existing custom
one or an edited script — and add `CronCreate` to your permission allowlist.
Your previous settings are backed up to `~/.claude/settings.json.bak`, and
re-running is a no-op.

## Install (plugin, from inside Claude Code)

```
/plugin marketplace add JohannHinrik/claude-limit-watch
/plugin install limit-watch@limit-watch
/limit-watch:setup
```

Installing the plugin registers the PostToolUse/Stop watchdog hooks
automatically. Plugins cannot set a status line or grant permissions, so the
`/limit-watch:setup` command finishes those two pieces — it installs the
status line script (merging with any custom status line you already have) and
adds `CronCreate` to your permission allowlist, asking for your approval where
the permission system requires it.

Requires node >= 18 on PATH and a claude.ai subscription (rate limits only
appear in the status line for Pro/Max accounts).

## Manual install (alternative)

1. Copy `hooks/` into `~/.claude/hooks/`.
2. Merge `settings.example.json` into `~/.claude/settings.json` (user level,
   applies to every project). Keep your existing keys.
3. Already-running sessions hot-reload the change; if one does not, open
   `/hooks` in it once, or restart it.

### Required permission: CronCreate

The nudge only works if the model is actually allowed to call `CronCreate`.
Hooks themselves run outside the permission system and are never blocked,
but the CronCreate tool call they request is subject to your permission
mode. In modes that never prompt (auto / dontAsk), a non-allowlisted
CronCreate is silently denied and the resume cron is never created — the
injected message tells the model to ignore the nudge if the tool is
unavailable, so there is no visible error.

`settings.example.json` therefore ships with:

```json
"permissions": { "allow": ["CronCreate"] }
```

Keep that block when merging, or add `CronCreate` to your existing allow
list.

### Verifying it works

- `~/.claude/rate-limit-state.json` should appear (and refresh) while an
  interactive session with the status line is open.
- Once a session crosses the threshold, a mark file appears in
  `~/.claude/limit-watch-marks/` named `<session-id>-<reset-epoch>`. A mark
  with no scheduled cron means the CronCreate call was denied — check the
  allowlist above.

## Tuning

Constants at the top of `hooks/limit-watch.mjs`:

| Constant | Default | Meaning |
|---|---|---|
| `THRESHOLD` | 85 | percent of the 5-hour window that triggers the nudge |
| `FIRE_AFTER_S` | 120 | how long after the reset the cron fires |
| `RENOTIFY_S` | 300 | repeat the nudge if a turn ignored it |

The scripts are re-executed on every event, so edits apply to all sessions
immediately, no reload needed.

## Caveats

- The cache is written only by interactive sessions (headless and background
  agents run no status line). Keep one interactive session open and the
  account-wide cache stays fresh for every agent on the machine.
- CronCreate jobs live in the session's memory. The session process must stay
  alive (terminal, tmux pane or background job still open) until the cron
  fires, and its permission mode must allow CronCreate.
- Each session past the threshold schedules its own resume. A session that
  finishes before freezing still gets a stray `continue` after the reset,
  which is harmless.
- If a single huge turn blows from below the threshold straight through 100%,
  the cron may never get created. Lower `THRESHOLD` for more headroom.

Tested on Claude Code 2.1.220.
