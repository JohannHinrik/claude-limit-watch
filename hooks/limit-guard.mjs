#!/usr/bin/env node
// PreToolUse gate, two levels deep:
//
//   imminent  deny NEW Agent/Task/Workflow launches, so the freeze does not
//             catch half a dozen subagents mid-task; running agents finish
//   brake     OPT-IN (LIMIT_WATCH_BRAKE=1): deny EVERY tool call except the
//             ones that arm the resume (Cron*) and write the handoff note, so
//             the session ends its turn and goes idle instead of freezing
//             mid-turn behind the limit modal — a blocked REPL is never idle,
//             and crons only fire when it is. Off by default because it halts
//             a session that still had a few percent of budget left.
//
// Both fail open: freshness is the writer's contract — if the published
// `expires` (write time + TIER_TTL_S, capped at the window reset) has passed,
// or the file is missing or unreadable, nothing is gated. Set
// LIMIT_WATCH_NO_GATE=1 to disable both.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Never braked: without these the brake would block the very CronCreate that
// arms the resume and the Write that saves the handoff note, defeating the
// system it protects. Reads are cheap and let the model orient before it
// stops; the marks-dir write is matched by path below.
const BRAKE_EXEMPT = /^(Cron(Create|List|Delete)|Read|TodoWrite|ExitPlanMode)$/;
const AGENT_TOOLS = /^(Agent|Task|Workflow)$/;

if (process.env.LIMIT_WATCH_NO_GATE) process.exit(0);

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
const tool = input.tool_name || '';

let tier = null;
try { tier = JSON.parse(readFileSync(join(homedir(), '.claude', 'limit-watch-tier.json'), 'utf8')); } catch {}
if (!tier || (tier.tier !== 'imminent' && tier.tier !== 'brake')) process.exit(0);
const now = Math.floor(Date.now() / 1000);
if (!Number.isFinite(tier.expires) || tier.expires <= now) process.exit(0);
if (!Number.isFinite(tier.resets)) process.exit(0);

// A write aimed at the marks dir is the handoff note; let it through.
const path = input.tool_input?.file_path || input.tool_input?.path || '';
const isHandoffWrite = typeof path === 'string' && path.includes('limit-watch-marks');

// Opt-in only. When the brake tier is published but not enabled, it still
// implies the imminent tier, so agent gating continues to apply.
const brakeOn = !!process.env.LIMIT_WATCH_BRAKE && tier.tier === 'brake';
const braking = brakeOn && !BRAKE_EXEMPT.test(tool) && !isHandoffWrite;
const gatingAgents = !braking && AGENT_TOOLS.test(tool);
if (!braking && !gatingAgents) process.exit(0);

const d = new Date(tier.resets * 1000);
const hh = String(d.getHours()).padStart(2, '0');
const mm = String(d.getMinutes()).padStart(2, '0');
const proj = Number.isFinite(tier.secs_to_100)
  ? `, projected to hit 100% in ~${Math.max(1, Math.round(tier.secs_to_100 / 60))} min`
  : '';
const pct = Math.round(tier.pct);

const reason = braking
  ? `[limit-watch] STOP: the 5-hour usage window is at ${pct}%${proj} and the limit is about to be reached. Tool calls are blocked so this session ends its turn while it still can — a session that hits the limit mid-turn freezes behind a blocking modal that no automatic resume can dismiss. Do NOT try another tool. Your resume for the reset at ${hh}:${mm} should already be scheduled (CronCreate is still permitted if it is not, as is writing the handoff note). Summarise where you got to in a short message and end your turn now. (The user can disable this with LIMIT_WATCH_NO_GATE=1.)`
  : `[limit-watch] The 5-hour usage window is at ${pct}%${proj}. New agent/workflow launches are paused so in-flight work can finish cleanly before the freeze. Do the work inline in this session, or wait for the reset at ${hh}:${mm}. (The user can disable this gate with LIMIT_WATCH_NO_GATE=1.)`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason
  }
}));
