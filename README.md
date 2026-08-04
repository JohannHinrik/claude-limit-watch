# claude-limit-watch

Auto-resume for Claude Code sessions that hit the 5-hour usage limit —
with burn-rate prediction, graceful wind-down with handoff notes, a
stop-blocking guarantee, an agent gate, and an external tmux fallback for
sessions that freeze before they could arm.

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
receives it. So the setup is four small Node scripts:

- `hooks/limit-statusline.mjs` renders a status line (model, directory,
  5-hour and 7-day usage with reset countdowns, a pace arrow — `⇡8%` when
  usage is running ahead of the window's elapsed time, `⇣` for headroom —
  plus wind-down/gate flags and a "resume in Xm" countdown once armed) and,
  on every refresh, caches the `rate_limits` block to
  `~/.claude/rate-limit-state.json` and appends a usage sample to
  `~/.claude/limit-watch-history.json`.
- `hooks/limit-watch.mjs` runs on `PostToolUse` (every tool call, empty
  matcher) and on `Stop`. It fits a burn rate (least-squares slope over the
  last 10 minutes of samples; when too few samples exist, it falls back to
  the window-average pace — usage over time elapsed — which needs only the
  current snapshot and deliberately understates a fresh burst), projects
  when the window hits 100%, and computes a tier, published to
  `~/.claude/limit-watch-tier.json`. Nudges driven by a cache more than 10
  minutes old say so, so stale data diagnoses itself:

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
- `hooks/limit-resume.mjs` is the **external tmux fallback** — the only piece
  that runs *outside* Claude Code (launchd on macOS, once a minute; cron it
  yourself elsewhere). It covers what no in-session mechanism can: a monster
  turn that blows straight through 100% before CronCreate ever happened, or a
  session whose in-memory cron died with the process. When a tmux-hosted
  session arms, the watchdog drops a `.tmux` sidecar recording the hosting
  pane (hooks inherit `$TMUX`/`$TMUX_PANE`); five minutes after the reset —
  strictly later than the cron's two, so it stays the fallback — the resumer
  checks that the pane still runs a Claude process **and that the limit
  freeze is visibly on screen** (`capture-pane` against a message pattern),
  then types the resume prompt, once per window (`.resumed` sidecar). No
  limit message means the session finished, already resumed, or was replaced
  by a fresh Claude — all left alone; the check fails toward skipping. If both paths fire, the duplicate costs one
  short reply. When the burn flattens and the cron gets cancelled, the
  sidecar is deleted too — deterministically, since unlike the cron it needs
  no model cooperation. Installed by `install.mjs` (launchd agent
  `com.limit-watch.tmux-resumer`); it cannot ship in the plugin.

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
missing), update an already-installed plugin to the bundled version, install
the status line, add the Cron tools to your permission allowlist, and — on
macOS with tmux present — register the tmux fallback resumer's launchd
agent. An existing custom status line is kept unless you opt in; an
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
  `.cancel` variants for the other one-shot nudges, `.md` for the handoff
  note, and `.tmux` / `.resumed` for the fallback resumer's pane record and
  once-guard), and the status line shows `⏰ resume armed`. A mark with no
  scheduled cron means the CronCreate call was denied — check the allowlist
  above.

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
| `PACE_MIN_ELAPSED_S` | 600 | window-average pace fallback needs at least this much of the window elapsed |
| `STALE_WARN_S` | 600 | nudges note the cache age when it exceeds this |
| `FIRE_AFTER_S` | 120 | how long after the reset the cron fires |
| `RENOTIFY_S` | 300 | repeat the arm nudge if a turn ignored it |

And in `hooks/limit-resume.mjs`:

| Constant | Default | Meaning |
|---|---|---|
| `RESUME_AFTER_S` | 300 | how long after the reset the tmux fallback types the resume (keep above `FIRE_AFTER_S` so the in-session cron goes first) |
| `LIMIT_RE` | (pattern) | the on-screen limit message that must be visible before the resume is typed; update here if Claude Code's wording changes |
| `CAPTURE_LINES` | 2000 | scrollback depth searched for that message |

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
  machine. Tiers still fire off an old cache (usage only rises within a
  window, so stale data understates), and any nudge built on data more than
  10 minutes old says so in the message.
- `used_percentage` may be integer-granular; the slope fit refuses to
  extrapolate from less than a 2% rise, so very short bursts fall back to
  the window-average pace, and below `PACE_MIN_ELAPSED_S` of elapsed window,
  to the static thresholds.
- CronCreate jobs live in the session's memory. The session process must stay
  alive (terminal, tmux pane or background job still open) until the cron
  fires, and its permission mode must allow the Cron tools. The tmux fallback
  resumer is the safety net for both constraints — but only for sessions
  running inside tmux on a machine with the launchd agent installed.
- Each session past the arm tier schedules its own resume. A session that
  finishes early is asked to cancel its cron only when the burn rate visibly
  flattened; one that finishes while still above the arm threshold keeps its
  cron, and the resume prompt makes that stray cost a one-sentence turn.
- The agent gate blocks new `Agent`/`Task`/`Workflow` tool calls only. Agents
  already in flight, and agents spawned internally by an already-running
  workflow, are not interrupted.
- Everything keys off the **5-hour** window. The 7-day cap is shown in the
  status line but has no auto-resume: its reset is typically days away —
  longer than a session process (or an awake laptop) reliably survives — and
  a resume scheduled for the 5-hour reset would just hit the weekly wall
  again.

Tested on Claude Code 2.1.220.
