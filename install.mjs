#!/usr/bin/env node
// Interactive installer, rtk-style: run by the user in their own shell, so it
// can do the two things a Claude Code plugin cannot — set the status line and
// grant the CronCreate permission — plus register the plugin itself.
//
//   node install.mjs          # interactive, asks before each change
//   node install.mjs --yes    # accept all defaults
import { readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
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

if (!yes && !process.stdin.isTTY) {
  console.error('No interactive terminal on stdin. Re-run with --yes to accept defaults.');
  process.exit(1);
}
const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });

async function confirm(q, def = true) {
  if (yes) return def;
  const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return a === '' ? def : a.startsWith('y');
}

// shell:true on Windows so npm's claude.cmd shim resolves.
const win = process.platform === 'win32';
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: win }).status === 0;
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: win }).status === 0;

// Command written into settings: tilde form on POSIX (matches the docs and
// pre-existing installs), absolute quoted path on Windows where the shell
// never expands ~.
const scriptCmd = (name) => win ? `node "${join(hooksDir, name)}"` : `node ~/.claude/hooks/${name}`;
// True only when a configured command executes OUR installed copy — a hook
// wired against some other checkout must not count as installed.
const runsInstalledCopy = (cmd, name) =>
  typeof cmd === 'string' && (cmd.includes(`~/.claude/hooks/${name}`) || cmd.includes(join(hooksDir, name)));

console.log('claude-limit-watch installer\n');

// Refuse to touch a settings file we cannot parse — rebuilding from {} would
// wipe every setting the user has.
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`Cannot parse ${settingsPath}: ${e.message}`);
    console.error('Fix the JSON (or move the file aside) and re-run.');
    process.exit(1);
  }
}

// Copy a bundled script into ~/.claude/hooks, asking before replacing an
// existing copy that differs (it may be customized or tuned).
async function installScript(name) {
  const dest = join(hooksDir, name);
  const src = readFileSync(join(here, 'hooks', name), 'utf8');
  let existing = null;
  try { existing = readFileSync(dest, 'utf8'); } catch {}
  if (existing === src) return;
  if (existing !== null) {
    if (!await confirm(`Existing ${dest} differs from the bundled version (it may be customized or tuned). Overwrite it?`, false)) {
      console.log('Kept your existing script.');
      return;
    }
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(dest, src);
}

// Decisions are recorded here and applied to a fresh read of settings.json at
// the very end, so a long prompt pause can't clobber concurrent changes.
let wireManual = false;
let setStatusLine = false;
let addCron = false;
let watchdogActive = false;

const manualEntryFor = (hooks, name) =>
  ['PostToolUse', 'Stop'].every(ev =>
    (hooks?.[ev] || []).some(m => (m.hooks || []).some(h => runsInstalledCopy(h.command, name))));

// --- 1. Watchdog: plugin (recommended) or manual hook wiring ---
const pluginEnabled = settings.enabledPlugins?.['limit-watch@limit-watch'] === true;
const manualWired = manualEntryFor(settings.hooks, 'limit-watch.mjs');
if (pluginEnabled) {
  console.log('Watchdog plugin already installed and enabled.');
  watchdogActive = true;
  if (manualWired) {
    console.log('Note: the watchdog is ALSO wired manually in settings.json — remove the');
    console.log('manual PostToolUse/Stop entries so it does not run twice per event.');
  }
} else if (manualWired) {
  console.log('Watchdog hooks already wired in settings.json.');
  watchdogActive = true;
} else if (has('claude')) {
  if (await confirm('Install the watchdog as a Claude Code plugin (recommended)?')) {
    console.log('\nRegistering marketplace (already-added is fine):');
    run('claude', ['plugin', 'marketplace', 'add', 'JohannHinrik/claude-limit-watch']);
    console.log('\nInstalling plugin:');
    if (run('claude', ['plugin', 'install', 'limit-watch@limit-watch'])) {
      watchdogActive = true;
    } else {
      console.log('\nPlugin install failed; you can wire the hooks directly instead.');
    }
  }
} else {
  console.log('claude CLI not found on PATH; the hooks can be wired directly instead.');
}
if (!watchdogActive && await confirm('Wire the watchdog hooks directly into ~/.claude/settings.json?')) {
  await installScript('limit-watch.mjs');
  if (existsSync(join(hooksDir, 'limit-watch.mjs'))) {
    wireManual = true;
    watchdogActive = true;
  }
}

// --- 2. Status line (writes the rate-limit cache the watchdog depends on) ---
const current = settings.statusLine?.command || '';
if (runsInstalledCopy(current, 'limit-statusline.mjs')) {
  console.log('\nStatus line already configured; checking the installed script.');
  await installScript('limit-statusline.mjs');
} else {
  if (current) {
    console.log('\nYou already have a custom status line:');
    console.log(`  ${current.slice(0, 120)}${current.length > 120 ? '…' : ''}`);
    console.log('limit-watch needs its status line installed — it is what caches the');
    console.log('rate_limits data the watchdog reads. If you replace yours, the old');
    console.log('command stays recoverable in ~/.claude/settings.json.bak, and its');
    console.log('display is easy to merge into the new script afterwards.');
  }
  // Default NO when a custom status line exists, so --yes never clobbers it.
  if (await confirm('Install the limit-watch status line?', !current)) {
    await installScript('limit-statusline.mjs');
    if (existsSync(join(hooksDir, 'limit-statusline.mjs'))) setStatusLine = true;
  } else {
    console.log('Skipped. The watchdog stays dormant until a status line writes');
    console.log('~/.claude/rate-limit-state.json — see README for the merge recipe.');
  }
}

// --- 3. CronCreate permission ---
if (!(settings.permissions?.allow || []).includes('CronCreate')) {
  console.log('\nThe model must be allowed to call CronCreate, otherwise non-prompting');
  console.log('permission modes silently deny the auto-resume cron.');
  if (await confirm('Add CronCreate to permissions.allow?')) addCron = true;
}

// --- 4. Apply decisions to a fresh read of settings.json ---
if (wireManual || setStatusLine || addCron) {
  let fresh = settings;
  if (existsSync(settingsPath)) {
    try { fresh = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
  }
  if (wireManual && !manualEntryFor(fresh.hooks, 'limit-watch.mjs')) {
    const entry = { matcher: '', hooks: [{ type: 'command', command: scriptCmd('limit-watch.mjs'), timeout: 10 }] };
    fresh.hooks = fresh.hooks || {};
    for (const ev of ['PostToolUse', 'Stop']) {
      const arr = fresh.hooks[ev] || [];
      if (!arr.some(m => (m.hooks || []).some(h => runsInstalledCopy(h.command, 'limit-watch.mjs')))) {
        fresh.hooks[ev] = [...arr, entry];
      }
    }
  }
  if (setStatusLine) {
    fresh.statusLine = { type: 'command', command: scriptCmd('limit-statusline.mjs'), refreshInterval: 60 };
  }
  if (addCron) {
    const allow = fresh.permissions?.allow || [];
    if (!allow.includes('CronCreate')) {
      fresh.permissions = { ...(fresh.permissions || {}), allow: [...allow, 'CronCreate'] };
    }
  }
  mkdirSync(claudeDir, { recursive: true });
  // Back up only when actually changing the file, so a no-op re-run never
  // destroys the pre-install backup; write via tmp+rename so a concurrent
  // reader never sees a torn file.
  const backup = `${settingsPath}.bak`;
  const hadSettings = existsSync(settingsPath);
  if (hadSettings) copyFileSync(settingsPath, backup);
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(fresh, null, 2)}\n`);
  renameSync(tmp, settingsPath);
  console.log(`\nUpdated ${settingsPath}${hadSettings ? ` (backup: ${backup})` : ''}`);
} else {
  console.log('\nNo settings changes were needed.');
}

// --- 5. Honest exit report ---
if (watchdogActive) {
  console.log('Done. Restart running Claude Code sessions (or open /hooks once) to');
  console.log('activate. The 5h/7d segments appearing in the status line confirm the');
  console.log('rate-limit cache is live (Pro/Max accounts only).');
} else {
  console.log('\nWARNING: the watchdog itself was NOT installed (plugin install failed or');
  console.log('was declined, and manual wiring was declined). Sessions will not');
  console.log('auto-resume; re-run this installer to finish setup.');
}
rl?.close();
