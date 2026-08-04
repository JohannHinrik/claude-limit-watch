#!/usr/bin/env node
// Status line for Claude Code. Besides rendering the line, it caches the
// rate_limits block from stdin to ~/.claude/rate-limit-state.json and appends
// a usage sample to ~/.claude/limit-watch-history.json, so the limit-watch
// hook (which never receives rate limits itself) can read the current state
// and fit a burn rate over recent samples.
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// History retention: an independent upper bound on the watcher's slope-fit
// lookback (limit-watch.mjs LOOKBACK_S must stay below it), kept generous so
// it is never the binding constraint while read-modify-write stays trivial.
const HIST_KEEP_S = 2700;
const HIST_MAX = 240;
const HIST_MIN_GAP_S = 15; // skip refresh bursts unless the percentage moved

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}

const claudeRoot = join(homedir(), '.claude');
const now = Math.floor(Date.now() / 1000);
// resets_at has arrived as both epoch ms and epoch s; normalize to seconds.
const toSec = (r) => typeof r === 'number' ? (r > 1e12 ? Math.floor(r / 1000) : r) : null;
const atomicWrite = (path, obj) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
};

const rl = input.rate_limits;
if (rl && typeof rl === 'object') {
  try { atomicWrite(join(claudeRoot, 'rate-limit-state.json'), { updated_at: now, rate_limits: rl }); } catch {}
}

// Burn-rate history for the 5-hour window: [t, pct] pairs, reset-window
// scoped (a new resets_at starts a fresh series). Concurrent interactive
// sessions race on the rewrite; losing a sample of account-global data to a
// last-writer-wins race is harmless.
try {
  const w5 = rl?.five_hour;
  const r5 = toSec(w5?.resets_at);
  if (w5 && typeof w5.used_percentage === 'number' && r5 !== null) {
    const histPath = join(claudeRoot, 'limit-watch-history.json');
    let hist = null;
    try { hist = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
    let samples = (hist && hist.resets === r5 && Array.isArray(hist.samples)) ? hist.samples : [];
    const last = samples[samples.length - 1];
    if (!last || now - last[0] >= HIST_MIN_GAP_S || last[1] !== w5.used_percentage) {
      samples = samples.filter(s => Array.isArray(s) && now - s[0] <= HIST_KEEP_S);
      samples.push([now, w5.used_percentage]);
      if (samples.length > HIST_MAX) samples = samples.slice(-HIST_MAX);
      atomicWrite(histPath, { resets: r5, samples });
    }
  }
} catch {}

// Window lengths behind the pace arrow. WINDOW_S mirrors the same constant in
// limit-watch.mjs (the hooks install as standalone files, so there is no
// shared module to import); keep the two in step if it ever changes.
const WINDOW_S = 18000;
const WEEK_S = 604800;
const FIRE_AFTER_FALLBACK_S = 120;

// Relative time reads faster under pressure than an absolute clock time.
// Every branch truncates the same way (floor plus a remainder), so a
// countdown never overstates what is left; the caller handles <= 0.
const rel = (secs) => {
  const m = Math.max(0, Math.floor(secs / 60));
  if (m >= 1440) {
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return h ? `${d}d${h}h` : `${d}d`;
  }
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${m}m`;
};

// windowS: full window length, for the pace arrow (claude-pace's idea) —
// usage % vs. elapsed % of the window. ⇡ = burning faster than the window
// is passing, ⇣ = headroom; small deltas are noise and stay hidden.
function fmt(win, windowS) {
  if (!win || typeof win.used_percentage !== 'number') return null;
  const r = toSec(win.resets_at);
  const pct = Math.round(win.used_percentage);
  if (r === null) return `${pct}%`;
  let s = `${pct}%`;
  const elapsed = windowS - (r - now);
  if (elapsed > 0 && elapsed <= windowS) {
    const delta = Math.round(win.used_percentage - (elapsed / windowS) * 100);
    if (delta >= 5) s += ` ⇡${delta}%`;
    else if (delta <= -5) s += ` ⇣${-delta}%`;
  }
  return `${s} (resets in ${rel(r - now)})`;
}

const parts = [];
const model = input.model?.display_name || input.model?.id;
if (model) parts.push(model);
const dir = (input.workspace?.current_dir || input.cwd || '').split('/').filter(Boolean).pop();
if (dir) parts.push(dir);
const fh = fmt(rl?.five_hour, WINDOW_S);
if (fh) parts.push(`5h ${fh}`);
const sd = fmt(rl?.seven_day, WEEK_S);
if (sd) parts.push(`7d ${sd}`);

// limit-watch publishes the account-wide tier it computed, stamped with its
// own expiry; surface the two levels that change behavior so the user can
// see why.
let tier = null;
try {
  tier = JSON.parse(readFileSync(join(claudeRoot, 'limit-watch-tier.json'), 'utf8'));
  if (Number.isFinite(tier.expires) && tier.expires > now) {
    if (tier.tier === 'imminent') parts.push('⛔ agents gated');
    else if (tier.tier === 'winddown') parts.push('⏳ wind-down');
  }
} catch {}

// limit-watch drops a mark file per session+reset window when its nudge has
// fired; surface that as an "armed" flag so the trigger is visible here.
try {
  const r = toSec(rl?.five_hour?.resets_at);
  if (input.session_id && r !== null) {
    statSync(join(claudeRoot, 'limit-watch-marks', `${input.session_id}-${r}`));
    // The cron's delay past the reset comes from the tier file limit-watch
    // publishes, so retuning FIRE_AFTER_S cannot make this countdown lie.
    const fireAfter = Number.isFinite(tier?.fire_after) ? tier.fire_after : FIRE_AFTER_FALLBACK_S;
    const left = r + fireAfter - now;
    // Past the fire time the countdown would sit at "0m" forever (a stale
    // cached resets_at keeps the branch alive), which reads as an imminent
    // resume that already happened; say it is due instead.
    parts.push(left > 0 ? `⏰ resume in ${rel(left)}` : '⏰ resume due');
  }
} catch {}

process.stdout.write(parts.join(' · '));
