#!/usr/bin/env node
// PreToolUse gate on Agent/Task/Workflow. When limit-watch.mjs has published
// the 'imminent' tier (usage projected to hit 100% within GATE_LEAD_S, or at
// GATE_PCT already), deny NEW agent/workflow launches so the freeze does not
// catch half a dozen subagents mid-task; agents already running finish
// normally. The denial reason tells the model to work inline or wait for the
// reset. Fails open: a missing, stale, or already-reset tier file gates
// nothing. Set LIMIT_WATCH_NO_GATE=1 in the environment to disable.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIER_TTL_S = 600; // ignore a tier computed longer ago than this

if (process.env.LIMIT_WATCH_NO_GATE) process.exit(0);

let tier = null;
try { tier = JSON.parse(readFileSync(join(homedir(), '.claude', 'limit-watch-tier.json'), 'utf8')); } catch {}
if (!tier || tier.tier !== 'imminent') process.exit(0);
const now = Math.floor(Date.now() / 1000);
if (!Number.isFinite(tier.t) || now - tier.t > TIER_TTL_S) process.exit(0);
if (!Number.isFinite(tier.resets) || tier.resets <= now) process.exit(0);

const d = new Date(tier.resets * 1000);
const hh = String(d.getHours()).padStart(2, '0');
const mm = String(d.getMinutes()).padStart(2, '0');
const proj = Number.isFinite(tier.secs_to_100)
  ? `, projected to hit 100% in ~${Math.max(1, Math.round(tier.secs_to_100 / 60))} min`
  : '';
const reason = `[limit-watch] The 5-hour usage window is at ${Math.round(tier.pct)}%${proj}. New agent/workflow launches are paused so in-flight work can finish cleanly before the freeze. Do the work inline in this session, or wait for the reset at ${hh}:${mm}. (The user can disable this gate with LIMIT_WATCH_NO_GATE=1.)`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason
  }
}));
