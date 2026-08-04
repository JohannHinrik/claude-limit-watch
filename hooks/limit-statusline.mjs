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

function fmt(win) {
  if (!win || typeof win.used_percentage !== 'number') return null;
  const r = toSec(win.resets_at);
  const pct = Math.round(win.used_percentage);
  if (r === null) return `${pct}%`;
  const d = new Date(r * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${pct}% (resets ${hh}:${mm})`;
}

const parts = [];
const model = input.model?.display_name || input.model?.id;
if (model) parts.push(model);
const dir = (input.workspace?.current_dir || input.cwd || '').split('/').filter(Boolean).pop();
if (dir) parts.push(dir);
const fh = fmt(rl?.five_hour);
if (fh) parts.push(`5h ${fh}`);
const sd = fmt(rl?.seven_day);
if (sd) parts.push(`7d ${sd}`);

// limit-watch publishes the account-wide tier it computed, stamped with its
// own expiry; surface the two levels that change behavior so the user can
// see why.
try {
  const tier = JSON.parse(readFileSync(join(claudeRoot, 'limit-watch-tier.json'), 'utf8'));
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
    parts.push('⏰ resume armed');
  }
} catch {}

process.stdout.write(parts.join(' · '));
