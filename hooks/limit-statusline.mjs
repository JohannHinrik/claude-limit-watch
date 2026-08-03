#!/usr/bin/env node
// Status line for Claude Code. Besides rendering the line, it caches the
// rate_limits block from stdin to ~/.claude/rate-limit-state.json so the
// limit-watch hook (which never receives rate limits itself) can read it.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}

const statePath = join(homedir(), '.claude', 'rate-limit-state.json');
const rl = input.rate_limits;
if (rl && typeof rl === 'object') {
  try {
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updated_at: Math.floor(Date.now() / 1000), rate_limits: rl }));
    renameSync(tmp, statePath);
  } catch {}
}

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
process.stdout.write(parts.join(' · '));
