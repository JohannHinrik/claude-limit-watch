#!/usr/bin/env node
// Status line for Claude Code. Besides rendering the line, it caches the
// rate_limits block from stdin to ~/.claude/rate-limit-state.json and appends
// a usage sample to ~/.claude/limit-watch-history.json, so the limit-watch
// hook (which never receives rate limits itself) can read the current state
// and fit a burn rate over recent samples.
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// History retention: enough for the watch hook's 10-minute slope fit with
// generous margin, small enough that read-modify-write stays trivial.
const HIST_KEEP_S = 2700;
const HIST_MAX = 240;
const HIST_MIN_GAP_S = 15; // skip refresh bursts unless the percentage moved

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}

const claudeRoot = join(homedir(), '.claude');
const statePath = join(claudeRoot, 'rate-limit-state.json');
const rl = input.rate_limits;
if (rl && typeof rl === 'object') {
  try {
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updated_at: Math.floor(Date.now() / 1000), rate_limits: rl }));
    renameSync(tmp, statePath);
  } catch {}
}

// Burn-rate history for the 5-hour window: [t, pct] pairs, reset-window
// scoped (a new resets_at starts a fresh series). Concurrent interactive
// sessions race on the rewrite; losing a sample of account-global data to a
// last-writer-wins race is harmless.
try {
  const w5 = rl?.five_hour;
  let r5 = w5?.resets_at;
  if (typeof r5 === 'number' && r5 > 1e12) r5 = Math.floor(r5 / 1000);
  if (w5 && typeof w5.used_percentage === 'number' && typeof r5 === 'number') {
    const histPath = join(claudeRoot, 'limit-watch-history.json');
    const now = Math.floor(Date.now() / 1000);
    let hist = null;
    try { hist = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
    let samples = (hist && hist.resets === r5 && Array.isArray(hist.samples)) ? hist.samples : [];
    const last = samples[samples.length - 1];
    if (!last || now - last[0] >= HIST_MIN_GAP_S || last[1] !== w5.used_percentage) {
      samples = samples.filter(s => Array.isArray(s) && now - s[0] <= HIST_KEEP_S);
      samples.push([now, w5.used_percentage]);
      if (samples.length > HIST_MAX) samples = samples.slice(-HIST_MAX);
      const tmp = `${histPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ resets: r5, samples }));
      renameSync(tmp, histPath);
    }
  }
} catch {}

function fmt(win) {
  if (!win || typeof win.used_percentage !== 'number') return null;
  let r = win.resets_at;
  if (typeof r === 'number' && r > 1e12) r = Math.floor(r / 1000);
  const pct = Math.round(win.used_percentage);
  if (typeof r !== 'number') return `${pct}%`;
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

// limit-watch publishes the account-wide tier it computed; surface the two
// levels that change behavior so the user can see why.
try {
  const tier = JSON.parse(readFileSync(join(claudeRoot, 'limit-watch-tier.json'), 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (Number.isFinite(tier.t) && now - tier.t <= 600 && Number.isFinite(tier.resets) && tier.resets > now) {
    if (tier.tier === 'imminent') parts.push('⛔ agents gated');
    else if (tier.tier === 'winddown') parts.push('⏳ wind-down');
  }
} catch {}

// limit-watch drops a mark file per session+reset window when its nudge has
// fired; surface that as an "armed" flag so the trigger is visible here.
try {
  let r = rl?.five_hour?.resets_at;
  if (typeof r === 'number' && r > 1e12) r = Math.floor(r / 1000);
  if (input.session_id && typeof r === 'number') {
    statSync(join(claudeRoot, 'limit-watch-marks', `${input.session_id}-${r}`));
    parts.push('⏰ resume armed');
  }
} catch {}

process.stdout.write(parts.join(' · '));
