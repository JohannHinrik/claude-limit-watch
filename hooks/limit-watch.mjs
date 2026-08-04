#!/usr/bin/env node
// PostToolUse + Stop hook. Reads the rate-limit cache and burn-rate history
// written by limit-statusline.mjs, computes a tier for the 5-hour window and
// publishes it to ~/.claude/limit-watch-tier.json (read by limit-guard.mjs
// and the status line):
//
//   winddown  finish in-flight work, avoid new fan-outs, start a handoff note
//   arm       schedule the auto-resume cron via CronCreate; the cron prompt
//             points back at the handoff note so the resume lands with intent
//   imminent  limit-guard.mjs pauses new agent launches
//
// Each tier trips on a static percentage OR on a burn-rate projection: when
// the recent slope says the window hits 100% before it resets and within the
// tier's lead time, the tier fires early — a huge fan-out burning 5%/min gets
// armed at 60% instead of being caught mid-freeze at 85%. On Stop, if the
// session armed earlier in this window but the burn has since flattened below
// the arm tier, the model is asked once to CronDelete the now-unneeded resume.
// Nags at most once per RENOTIFY_S per session per reset window.
import { readFileSync, writeFileSync, renameSync, statSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Static fallbacks (percent of the 5-hour window) — always apply, even when
// too few samples exist to fit a slope.
const WINDDOWN_PCT = 70;
const THRESHOLD = 85;     // arm tier (name kept from earlier versions)
const GATE_PCT = 93;
// Predictive leads: tier fires when the projected time to 100% drops below
// this many seconds (and 100% lands before the reset).
const WINDDOWN_LEAD_S = 2400;
const ARM_LEAD_S = 1200;
const GATE_LEAD_S = 600;
// Slope fit: samples from the last LOOKBACK_S (keep below the status line's
// HIST_KEEP_S, which bounds how much history survives); trusted only with at
// least MIN_SAMPLES points spanning MIN_SPAN_S seconds and MIN_RISE_PCT
// percent (used_percentage may be integer-granular, so tiny rises are noise).
const LOOKBACK_S = 600;
const MIN_SAMPLES = 4;
const MIN_SPAN_S = 120;
const MIN_RISE_PCT = 2;
// The published tier carries expires = min(now + TIER_TTL_S, resets);
// consumers only compare against it, so freshness is defined here alone.
// While the cached inputs are unchanged and the publication is younger than
// REUSE_S, it is reused instead of refitting and rewriting per tool call.
const TIER_TTL_S = 600;
const REUSE_S = 15;
const FIRE_AFTER_S = 120; // cron fires this long after the reset
const RENOTIFY_S = 300;   // repeat the arm nudge if a turn ignored it

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
const event = input.hook_event_name === 'Stop' ? 'Stop' : 'PostToolUse';

const claudeDir = join(homedir(), '.claude');
let state = null;
try { state = JSON.parse(readFileSync(join(claudeDir, 'rate-limit-state.json'), 'utf8')); } catch {}
const win = state?.rate_limits?.five_hour;
if (!win || !Number.isFinite(win.used_percentage)) process.exit(0);
const pct = win.used_percentage;

let resets = win.resets_at;
if (Number.isFinite(resets) && resets > 1e12) resets = Math.floor(resets / 1000);
if (!Number.isFinite(resets)) process.exit(0);
const now = Math.floor(Date.now() / 1000);
if (resets + FIRE_AFTER_S <= now) process.exit(0); // stale cache from an old window

const tierPath = join(claudeDir, 'limit-watch-tier.json');
let tier = 'none', slope = null, secsTo100 = null, reused = false;
try {
  const prev = JSON.parse(readFileSync(tierPath, 'utf8'));
  // The inputs only move when the status line rewrites the cache; while they
  // haven't, the published tier is still current — skip the refit and rewrite.
  if (prev.resets === resets && prev.pct === pct
      && Number.isFinite(prev.t) && now - prev.t < REUSE_S && typeof prev.tier === 'string') {
    tier = prev.tier;
    slope = Number.isFinite(prev.slope) ? prev.slope : null;
    secsTo100 = Number.isFinite(prev.secs_to_100) ? prev.secs_to_100 : null;
    reused = true;
  }
} catch {}

if (!reused) {
  // Burn rate: least-squares slope (percent/second) over recent samples.
  try {
    const hist = JSON.parse(readFileSync(join(claudeDir, 'limit-watch-history.json'), 'utf8'));
    if (hist.resets === resets && Array.isArray(hist.samples)) {
      const s = hist.samples.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && now - p[0] <= LOOKBACK_S);
      if (s.length >= MIN_SAMPLES
          && s[s.length - 1][0] - s[0][0] >= MIN_SPAN_S
          && s[s.length - 1][1] - s[0][1] >= MIN_RISE_PCT) {
        const n = s.length;
        const mt = s.reduce((a, p) => a + p[0], 0) / n;
        const mp = s.reduce((a, p) => a + p[1], 0) / n;
        let num = 0, den = 0;
        for (const [t, p] of s) { num += (t - mt) * (p - mp); den += (t - mt) * (t - mt); }
        if (den > 0 && num > 0) slope = num / den;
      }
    }
  } catch {}
  secsTo100 = slope ? Math.max(0, (100 - pct) / slope) : null;
  const projBefore = secsTo100 !== null && now + secsTo100 < resets;

  if (pct >= WINDDOWN_PCT || (projBefore && secsTo100 < WINDDOWN_LEAD_S)) tier = 'winddown';
  if (pct >= THRESHOLD || (projBefore && secsTo100 < ARM_LEAD_S)) tier = 'arm';
  if (pct >= GATE_PCT || (projBefore && secsTo100 < GATE_LEAD_S)) tier = 'imminent';

  // Publish before the subagent check: subagent tool calls also fire
  // PostToolUse, so the tier file stays fresh even during a long fan-out turn
  // where the main loop makes no tool calls of its own. slope/secs_to_100 are
  // read back on the reuse path above (and slope feeds the nudge wording).
  try {
    const tmp = `${tierPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      t: now, expires: Math.min(now + TIER_TTL_S, resets), tier, pct, resets, slope, secs_to_100: secsTo100
    }));
    renameSync(tmp, tierPath);
  } catch {}
}

// Subagents carry agent_id/agent_type in hook input; the main loop carries
// neither. Only the main loop can call CronCreate, so stay silent in
// subagents: the injection would read as a prompt-injection attempt there,
// and acting on the marker would starve the main loop of its nudge.
if (input.agent_id || input.agent_type) process.exit(0);

// One mark file per session and reset window (plus .winddown/.cancel
// variants). First-notify creation is atomic (wx), so hooks racing on
// parallel tool calls cannot both inject; the renotify rewrite is not
// atomic, which at worst repeats a nudge. The status line reads the bare
// arm mark by this exact name to show its "resume armed" flag.
const markDir = join(claudeDir, 'limit-watch-marks');
const armMark = join(markDir, `${input.session_id || 'unknown'}-${resets}`);
// Handoff note the model is asked to write; the resume cron's prompt points
// back at it. The .md suffix still matches pruneOldMarks' window regex.
const handoff = `${armMark}.md`;
const pruneOldMarks = () => {
  try {
    for (const f of readdirSync(markDir)) {
      const m = f.match(/-(\d+)(?:\.\w+)?$/);
      const r = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(r) || r + 86400 < now) rmSync(join(markDir, f), { force: true });
    }
  } catch {}
};

const pctR = Math.round(pct);
const mins = secsTo100 !== null ? Math.max(1, Math.round(secsTo100 / 60)) : null;
const projNote = mins !== null ? `, burning ~${(slope * 60).toFixed(1)}%/min (projected to hit 100% in ~${mins} min)` : '';

// Cancel path: this session armed a resume cron earlier in the window, the
// burn has since flattened below the arm tier (only possible for a
// projection-based arm — the percentage itself never falls mid-window), and
// the turn is ending. Block the stop once per window so the model can
// CronDelete the cron if the task is actually done; budget is plentiful
// here, so the extra turn is cheap. Any failure (not armed, already asked)
// just falls through.
if (event === 'Stop' && !input.stop_hook_active && (tier === 'none' || tier === 'winddown')) {
  try {
    statSync(armMark);
    writeFileSync(`${armMark}.cancel`, '', { flag: 'wx' });
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `[limit-watch] The burn rate flattened: the 5-hour window is at ${pctR}% and no longer projected to hit 100% before it resets. If the task you scheduled the limit-watch resume cron for is fully complete, cancel that cron now with CronDelete (its job id is in your earlier CronCreate result; use CronList if you no longer have it), then stop. If work remains, or the cron is already gone, or Cron tools are unavailable, just stop.`
    }));
    process.exit(0);
  } catch {}
}

if (tier === 'none') process.exit(0);
try { mkdirSync(markDir, { recursive: true }); } catch {}

// Wind-down advisory: once per session per window, PostToolUse only (Stop
// context injection is unreliable, and PostToolUse fires constantly anyway).
if (tier === 'winddown') {
  if (event !== 'PostToolUse') process.exit(0);
  try { writeFileSync(`${armMark}.winddown`, '', { flag: 'wx' }); } catch { process.exit(0); }
  pruneOldMarks();
  const msg = `[limit-watch] Heads-up: the 5-hour usage window is at ${pctR}%${projNote}. Wind down gracefully: finish in-flight units before starting new ones, avoid launching new large subagent fan-outs, and checkpoint progress into a handoff note at \`${handoff}\` — the task in progress, what is done, the exact next step — so an interruption at 100% can resume cleanly. Advisory only — a resume nudge follows automatically if usage keeps climbing.`;
  process.stdout.write(JSON.stringify({
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: event, additionalContext: msg }
  }));
  process.exit(0);
}

// Arm tier (also covers imminent): nudge the model to schedule the resume.
try {
  const st = statSync(armMark);
  if (now - Math.floor(st.mtimeMs / 1000) < RENOTIFY_S) process.exit(0);
  writeFileSync(armMark, '');
} catch {
  try { writeFileSync(armMark, '', { flag: 'wx' }); } catch { process.exit(0); }
}
pruneOldMarks();

const fire = new Date((resets + FIRE_AFTER_S) * 1000);
const cron = `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} ${fire.getMonth() + 1} *`;
const hh = String(fire.getHours()).padStart(2, '0');
const mm = String(fire.getMinutes()).padStart(2, '0');

const msg = `[limit-watch] The 5-hour usage window is at ${pctR}% used${projNote} and this session may freeze at 100% before finishing. As your VERY NEXT tool call, before anything else, call CronCreate with schedule \`${cron}\`, recurring false, and prompt \`Resumed by limit-watch: the usage window has reset. Read the handoff note at ${handoff} if it exists and resume from its next step; otherwise continue the interrupted task if any work remains. If everything was already complete, reply briefly and stop.\` That fires at ${hh}:${mm}, 2 minutes after the window resets, and resumes this session. If you already created this exact cron for this reset window, do not create a duplicate; if CronCreate is not in your toolset, ignore this message. Right after the CronCreate, write (or refresh) the handoff note at \`${handoff}\`: the task in progress, what is already done, and the exact next step — and keep it current as work advances. Then keep working while budget remains, preferring to finish in-flight work over starting new subagent fan-outs.`;

process.stdout.write(JSON.stringify({
  suppressOutput: true,
  hookSpecificOutput: { hookEventName: event, additionalContext: msg }
}));
