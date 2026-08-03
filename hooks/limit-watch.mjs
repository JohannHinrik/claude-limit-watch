#!/usr/bin/env node
// PostToolUse + Stop hook. Reads the rate-limit cache written by
// limit-statusline.mjs; when the 5-hour window is >= THRESHOLD percent used,
// injects context telling Claude to schedule a one-shot CronCreate that fires
// FIRE_AFTER_S seconds after the window resets with the prompt "continue".
// Nags at most once per RENOTIFY_S per session per reset window.
import { readFileSync, writeFileSync, statSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const THRESHOLD = 85;     // percent of the 5-hour window
const FIRE_AFTER_S = 120; // cron fires this long after the reset
const RENOTIFY_S = 300;   // repeat the nudge if a turn ignored it

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
const event = input.hook_event_name === 'Stop' ? 'Stop' : 'PostToolUse';

// Subagents carry agent_id/agent_type in hook input; the main loop carries
// neither. Only the main loop can call CronCreate, so stay silent in
// subagents: the injection would read as a prompt-injection attempt there,
// and acting on the marker would starve the main loop of its nudge.
if (input.agent_id || input.agent_type) process.exit(0);

const claudeDir = join(homedir(), '.claude');
let state = null;
try { state = JSON.parse(readFileSync(join(claudeDir, 'rate-limit-state.json'), 'utf8')); } catch {}
const win = state?.rate_limits?.five_hour;
if (!win || !Number.isFinite(win.used_percentage)) process.exit(0);
if (win.used_percentage < THRESHOLD) process.exit(0);

let resets = win.resets_at;
if (Number.isFinite(resets) && resets > 1e12) resets = Math.floor(resets / 1000);
if (!Number.isFinite(resets)) process.exit(0);
const now = Math.floor(Date.now() / 1000);
if (resets + FIRE_AFTER_S <= now) process.exit(0); // stale cache from an old window

// One mark file per session and reset window. First-notify creation is
// atomic (wx), so hooks racing on parallel tool calls cannot both inject;
// the renotify rewrite is not atomic, which at worst repeats a nudge.
const markDir = join(claudeDir, 'limit-watch-marks');
try { mkdirSync(markDir, { recursive: true }); } catch {}
const mark = join(markDir, `${input.session_id || 'unknown'}-${resets}`);
try {
  const st = statSync(mark);
  if (now - Math.floor(st.mtimeMs / 1000) < RENOTIFY_S) process.exit(0);
  writeFileSync(mark, '');
} catch {
  try { writeFileSync(mark, '', { flag: 'wx' }); } catch { process.exit(0); }
}
try {
  for (const f of readdirSync(markDir)) {
    const r = Number(f.split('-').pop());
    if (!Number.isFinite(r) || r + 86400 < now) rmSync(join(markDir, f), { force: true });
  }
} catch {}

const fire = new Date((resets + FIRE_AFTER_S) * 1000);
const cron = `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} ${fire.getMonth() + 1} *`;
const hh = String(fire.getHours()).padStart(2, '0');
const mm = String(fire.getMinutes()).padStart(2, '0');
const pct = Math.round(win.used_percentage);

const msg = `[limit-watch] The 5-hour usage window is at ${pct}% used and this session may freeze at 100% before finishing. As your VERY NEXT tool call, before anything else, call CronCreate with schedule \`${cron}\`, prompt \`continue\`, recurring false. That fires at ${hh}:${mm}, 2 minutes after the window resets, and resumes this session. If you already created this exact cron for this reset window, do not create a duplicate; if CronCreate is not in your toolset, ignore this message. Then keep working on the current task while budget remains.`;

process.stdout.write(JSON.stringify({
  suppressOutput: true,
  hookSpecificOutput: { hookEventName: event, additionalContext: msg }
}));
