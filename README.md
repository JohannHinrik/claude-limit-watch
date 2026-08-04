# claude-limit-watch

Auto-resume for Claude Code sessions that hit the 5-hour usage limit —
now with burn-rate prediction, graceful wind-down, and an agent gate.

The watchdog tracks how fast the 5-hour window is being consumed, not just
where it stands. A huge task burning 5%/min gets its auto-resume armed at 60%
instead of being caught mid-freeze; a slow chat session at 88% with a flat
burn is left alone until the static threshold. If a burst armed the resume
early and then the task finished below the limit, the session is asked to
cancel the now-unneeded cron. When 100% is genuinely imminent, new subagent
launches are paused so the freeze does not orphan a fan-out of half-done
agents.

## How it works

Claude Code never passes rate-limit data to hooks. Only the status line
receives it. So the setup is three small Node scripts:

- `hooks/limit-statusline.mjs` renders a status line (model, directory,
  5-hour and 7-day usage with reset times, plus wind-down/gate flags) and, on
  every refresh, caches the `rate_limits` block to
  `~/.claude/rate-limit-state.json` and appends a usage sample to
  `~/.claude/limit-watch-history.json`.
- `hooks/limit-watch.mjs` runs on `PostToolUse` (every tool call, empty
  matcher) and on `Stop`. It fits a burn rate (least-squares slope over the
  last 10 minutes of samples), projects when the window hits 100%, and
  computes a tier, published to `~/.claude/limit-watch-tier.json`:

  | Tier | Trigger (whichever comes first) | Action |
  |---|---|---|
  | `winddown` | projected 100% in < 40 min (before the reset), or ≥ 70% used | one advisory: finish in-flight units, avoid new fan-outs, start a handoff note |
  | `arm` | projected 100% in < 20 min, or ≥ 85% used | inject the resume nudge: call CronCreate (schedule = reset + 2 min), then write/refresh the handoff note; a Stop at this tier is blocked once per window until the cron exists |
  | `imminent` | projected 100% in < 10 min, or ≥ 93% used | `limit-guard.mjs` pauses new agent launches |

  On `Stop`, if this session armed a resume earlier in the window but the
  burn has since flattened below the arm tier (a projection-based arm whose
  burst ended), it asks the model — once per window — to `CronDelete` the
  cron if the task is actually complete. Arming eagerly and cancelling on a
  clean finish is deliberate: a stray cron costs one tool call, a missed one
  costs a frozen, orphaned session. As extra insurance, the cron's prompt
  itself says "if the task was already complete, reply briefly and stop", so
  any stray that slips through costs one sentence in the fresh window.

  The PostToolUse nudge is advisory; the guarantee is on `Stop`: a session
  trying to go idle at the arm tier gets its stop **blocked** (once per
  window, `stop_hook_active`-guarded against loops), forcing one turn whose
  only job is to make sure the resume cron exists. Ignored mid-flight nudges
  can no longer leave an idle session frozen without a resume.

  The resume is not a bare `continue`: both nudges ask the model to keep a
  **handoff note** (`~/.claude/limit-watch-marks/<session-id>-<reset>.md` —
  task in progress, what is done, the exact next step), and the cron's prompt
  points back at it. A session that froze mid-task and was compacted
  overnight resumes with intent instead of re-deriving where it was.
- `hooks/limit-guard.mjs` runs on `PreToolUse` for `Agent`/`Task`/`Workflow`.
  At the `imminent` tier it denies **new** agent and workflow launches with a
  reason telling the model to work inline or wait for the reset; agents
  already running finish normally. It fails open (missing/stale tier file
  gates nothing) and can be disabled with `LIMIT_WATCH_NO_GATE=1`.

Everything is account-global by construction: the cache, history, and tier
files live in `~/.claude/`, so every session on the machine — including
background jobs, which run hooks but no status line — sees the same tier at
the same moment. The tier file is refreshed on subagent tool calls too, so it
stays current even during long fan-out turns. Each session still schedules
its own resume cron (crons live in session memory; that is a platform
constraint).

No LLM is involved in the hooks themselves. They are plain Node processes,
silent and free on every event below the wind-down tier. The token cost is
one advisory (~90 tokens) plus the resume nudge (~150 tokens) and one
CronCreate call when they trip.

## Install (one command)

```sh
npx github:JohannHinrik/claude-limit-watch
```

(or `git clone` this repo and run `node install.mjs`; add `--yes` to accept
all defaults non-interactively)

The installer runs in your shell, outside Claude Code's permission system, so
it can do everything in one guided pass: register the plugin via the `claude`
CLI (or fall back to wiring the hooks into settings directly if the CLI is
missing), install the status line and add the Cron tools to your permission
allowlist. An existing custom status line is kept unless you opt in; an
edited or outdated hook script is updated with the old copy saved next to it
as `<name>.bak`, so upgrades work non-interactively without losing your
tuning. Your previous settings are backed up to `~/.claude/settings.json.bak`,
and re-running is a no-op. Re-running on an existing install also offers the
pieces added since (the agent gate, the extra Cron permissions).

## Install (plugin, from inside Claude Code)

```
/plugin marketplace add JohannHinrik/claude-limit-watch
/plugin install limit-watch@limit-watch
/limit-watch:setup
```

Installing the plugin registers the PreToolUse/PostToolUse/Stop hooks
automatically. Plugins cannot set a status line or grant permissions, so the
`/limit-watch:setup` command finishes those two pieces — it installs the
status line script (merging with any custom status line you already have) and
adds the Cron tools to your permission allowlist, asking for your approval
where the permission system requires it.

Requires node >= 18 on PATH and a claude.ai subscription (rate limits only
appear in the status line for Pro/Max accounts).

## Manual install (alternative)

1. Copy `hooks/` into `~/.claude/hooks/`.
2. Merge `settings.example.json` into `~/.claude/settings.json` (user level,
   applies to every project). Keep your existing keys.
3. Already-running sessions hot-reload the change; if one does not, open
   `/hooks` in it once, or restart it.

### Required permissions: CronCreate, CronList, CronDelete

The nudges only work if the model is actually allowed to call the Cron
tools. Hooks themselves run outside the permission system and are never
blocked, but the tool calls they request are subject to your permission
mode. In modes that never prompt (auto / dontAsk), a non-allowlisted
CronCreate is silently denied and the resume cron is never created — the
injected message tells the model to ignore the nudge if the tool is
unavailable, so there is no visible error. CronDelete and CronList are what
let a session cancel a resume cron that turned out not to be needed.

`settings.example.json` therefore ships with:

```json
"permissions": { "allow": ["CronCreate", "CronList", "CronDelete"] }
```

Keep that block when merging, or add the entries to your existing allow list.

### Verifying it works

- `~/.claude/rate-limit-state.json` and `~/.claude/limit-watch-history.json`
  should appear (and refresh) while an interactive session with the status
  line is open.
- `~/.claude/limit-watch-tier.json` appears once any session makes a tool
  call; it records the current tier, percentage, slope and projection.
- Once a session arms, a mark file appears in `~/.claude/limit-watch-marks/`
  named `<session-id>-<reset-epoch>` (with `.winddown` / `.stopblock` /
  `.cancel` variants for the other one-shot nudges, and `.md` for the
  handoff note), and the
  status line shows `⏰ resume armed`. A mark with no scheduled cron means
  the CronCreate call was denied — check the allowlist above.

## Tuning

Constants at the top of `hooks/limit-watch.mjs`:

| Constant | Default | Meaning |
|---|---|---|
| `WINDDOWN_PCT` | 70 | percent that triggers the wind-down advisory |
| `THRESHOLD` | 85 | percent that arms the resume cron |
| `GATE_PCT` | 93 | percent at which new agent launches are paused |
| `WINDDOWN_LEAD_S` | 2400 | wind down when 100% is projected within 40 min |
| `ARM_LEAD_S` | 1200 | arm when 100% is projected within 20 min |
| `GATE_LEAD_S` | 600 | gate when 100% is projected within 10 min |
| `LOOKBACK_S` | 600 | slope is fitted over this many seconds of samples (keep below the status line's `HIST_KEEP_S`, 2700, or older samples won't exist) |
| `TIER_TTL_S` | 600 | published tier expires this long after it was computed |
| `MIN_RISE_PCT` | 2 | minimum rise across the lookback before the slope is trusted |
| `FIRE_AFTER_S` | 120 | how long after the reset the cron fires |
| `RENOTIFY_S` | 300 | repeat the arm nudge if a turn ignored it |

Predictive triggers only fire when the projection also lands *before* the
window reset — a burst that would coast past the reset boundary is left
alone. Freshness is the writer's contract: the tier file carries an
`expires` stamp (computed from `TIER_TTL_S`, capped at the window reset)
that the gate and the status line simply compare against, so retuning it is
a one-place change. `LIMIT_WATCH_NO_GATE=1` in the environment disables the
gate entirely.

The scripts are re-executed on every event, so edits apply to all sessions
immediately, no reload needed.

## Caveats

- The cache and history are written only by interactive sessions (headless
  and background agents run no status line). Keep one interactive session
  open and the account-wide state stays fresh for every agent on the
  machine — prediction is blind exactly when the cache is stale.
- `used_percentage` may be integer-granular; the slope fit refuses to
  extrapolate from less than a 2% rise, so very short bursts fall back to the
  static thresholds.
- CronCreate jobs live in the session's memory. The session process must stay
  alive (terminal, tmux pane or background job still open) until the cron
  fires, and its permission mode must allow the Cron tools.
- Each session past the arm tier schedules its own resume. A session that
  finishes early is asked to cancel its cron only when the burn rate visibly
  flattened; one that finishes while still above the arm threshold keeps its
  cron, and the resume prompt makes that stray cost a one-sentence turn.
- The agent gate blocks new `Agent`/`Task`/`Workflow` tool calls only. Agents
  already in flight, and agents spawned internally by an already-running
  workflow, are not interrupted.

Tested on Claude Code 2.1.220.
