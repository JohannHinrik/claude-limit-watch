#!/usr/bin/env node
// Interactive installer, rtk-style: run by the user in their own shell, so it
// can do the two things a Claude Code plugin cannot — set the status line and
// grant the CronCreate permission — plus register the plugin itself.
//
//   node install.mjs          # interactive, asks before each change
//   node install.mjs --yes    # accept all defaults
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const claudeDir = join(homedir(), '.claude');
const hooksDir = join(claudeDir, 'hooks');
const settingsPath = join(claudeDir, 'settings.json');
const yes = process.argv.includes('--yes') || process.argv.includes('-y');
const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });

async function confirm(q, def = true) {
  if (yes) return def;
  const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return a === '' ? def : a.startsWith('y');
}
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

console.log('claude-limit-watch installer\n');

// --- 1. Watchdog hooks: plugin if the claude CLI is available, else manual ---
let pluginMode = false;
if (has('claude')) {
  if (await confirm('Install the watchdog as a Claude Code plugin (recommended)?')) {
    pluginMode = true;
    console.log('\nRegistering marketplace (already-added is fine):');
    run('claude', ['plugin', 'marketplace', 'add', 'JohannHinrik/claude-limit-watch']);
    console.log('\nInstalling plugin:');
    run('claude', ['plugin', 'install', 'limit-watch@limit-watch']);
  }
} else {
  console.log('claude CLI not found on PATH; falling back to manual hook install.');
}

// --- 2. Load settings ---
let settings = {};
try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
const backup = `${settingsPath}.bak`;
const hadSettings = existsSync(settingsPath);
if (hadSettings) copyFileSync(settingsPath, backup);
let changed = false;

if (!pluginMode && await confirm('Wire the watchdog hooks directly into ~/.claude/settings.json?')) {
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(join(here, 'hooks', 'limit-watch.mjs'), join(hooksDir, 'limit-watch.mjs'));
  const entry = [{ matcher: '', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/limit-watch.mjs', timeout: 10 }] }];
  settings.hooks = settings.hooks || {};
  for (const ev of ['PostToolUse', 'Stop']) {
    const existing = JSON.stringify(settings.hooks[ev] || []);
    if (!existing.includes('limit-watch.mjs')) {
      settings.hooks[ev] = [...(settings.hooks[ev] || []), ...entry];
      changed = true;
    }
  }
}

// --- 3. Status line (writes the rate-limit cache the watchdog depends on) ---
const slCmd = 'node ~/.claude/hooks/limit-statusline.mjs';
const current = settings.statusLine?.command || '';
if (current.includes('limit-statusline.mjs')) {
  const dest = join(hooksDir, 'limit-statusline.mjs');
  const src = readFileSync(join(here, 'hooks', 'limit-statusline.mjs'), 'utf8');
  let existing = null;
  try { existing = readFileSync(dest, 'utf8'); } catch {}
  if (existing === null) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(dest, src);
    console.log('\nStatus line already configured; installed the missing script copy.');
  } else if (existing === src) {
    console.log('\nStatus line already installed and up to date.');
  } else if (await confirm('\nExisting ~/.claude/hooks/limit-statusline.mjs differs from this version (it may be customized). Overwrite it?', false)) {
    writeFileSync(dest, src);
    console.log('Overwrote with the bundled version.');
  } else {
    console.log('Kept your existing script.');
  }
} else {
  if (current) {
    console.log('\nYou already have a custom status line:');
    console.log(`  ${current.slice(0, 120)}${current.length > 120 ? '…' : ''}`);
    console.log('limit-watch needs its status line installed — it is what caches the');
    console.log('rate_limits data the watchdog reads. Your current one will be backed');
    console.log(`up in ${backup}; you can merge its display into the script afterwards.`);
  }
  if (await confirm('Install the limit-watch status line?')) {
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(join(here, 'hooks', 'limit-statusline.mjs'), join(hooksDir, 'limit-statusline.mjs'));
    settings.statusLine = { type: 'command', command: slCmd, refreshInterval: 60 };
    changed = true;
  } else {
    console.log('Skipped. The watchdog stays dormant until a status line writes');
    console.log('~/.claude/rate-limit-state.json — see README for the merge recipe.');
  }
}

// --- 4. CronCreate permission ---
const allow = settings.permissions?.allow || [];
if (!allow.includes('CronCreate')) {
  console.log('\nThe model must be allowed to call CronCreate, otherwise non-prompting');
  console.log('permission modes silently deny the auto-resume cron.');
  if (await confirm('Add CronCreate to permissions.allow?')) {
    settings.permissions = { ...(settings.permissions || {}), allow: [...allow, 'CronCreate'] };
    changed = true;
  }
}

// --- 5. Write & report ---
if (changed) {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`\nUpdated ${settingsPath}${hadSettings ? ` (backup: ${backup})` : ''}`);
} else {
  console.log('\nNo settings changes were needed.');
}
console.log('Done. Restart running Claude Code sessions (or open /hooks once) to');
console.log('activate. The 5h/7d segments appearing in the status line confirm the');
console.log('rate-limit cache is live (Pro/Max accounts only).');
rl?.close();
