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

## Install

1. Copy `hooks/` into `~/.claude/hooks/`.
2. Merge `settings.example.json` into `~/.claude/settings.json` (user level,
   applies to every project). Keep your existing keys.
3. Already-running sessions hot-reload the change; if one does not, open
   `/hooks` in it once, or restart it.

Requires node on PATH and a claude.ai subscription (rate limits only appear
in the status line for Pro/Max accounts).

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
