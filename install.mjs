#!/usr/bin/env node
// Interactive installer, rtk-style: run by the user in their own shell, so it
// can do the two things a Claude Code plugin cannot — set the status line and
// grant the CronCreate permission — plus register the plugin itself.
//
//   node install.mjs          # interactive, asks before each change
//   node install.mjs --yes    # accept all defaults
import { readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
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
const isWired = (hooks, ev, name) =>
  (hooks?.[ev] || []).some(m => (m.hooks || []).some(h => runsInstalledCopy(h.command, name)));

// The bundled plugin manifest is the single source of truth for which events,
// matchers and timeouts each hook script wants; manual wiring derives its
// entries from it (swapping only the command path) so the two install modes
// cannot drift when a matcher or event changes.
const manifest = JSON.parse(readFileSync(join(here, 'hooks', 'hooks.json'), 'utf8')).hooks;
const manifestEntries = (name) => Object.entries(manifest).flatMap(([event, ms]) =>
  ms.filter(m => (m.hooks || []).some(h => h.command.includes(name)))
    .map(m => ({ event, matcher: m.matcher || '', timeout: m.hooks[0].timeout ?? 10 })));

console.log('claude-limit-watch installer\n');

// Refuse to touch a settings file we cannot parse — rebuilding from {} would
// wipe every setting the user has. A top-level null/array/string is just as
// unusable as a syntax error: assigning keys onto it crashes or gets silently
// dropped by JSON.stringify.
const isSettingsObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
let settings = {};
if (existsSync(settingsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!isSettingsObject(parsed)) throw new Error('top-level value is not an object');
    settings = parsed;
  } catch (e) {
    console.error(`Cannot parse ${settingsPath}: ${e.message}`);
    console.error('Fix the JSON (or move the file aside) and re-run.');
    process.exit(1);
  }
}

// Copy a bundled script into ~/.claude/hooks. An existing copy that differs
// may be customized/tuned OR simply outdated, so updating must stay possible
// under --yes (otherwise upgrades silently no-op forever): default yes, but
// always preserve the old copy next to it and say so.
async function installScript(name) {
  const dest = join(hooksDir, name);
  const src = readFileSync(join(here, 'hooks', name), 'utf8');
  let existing = null;
  try { existing = readFileSync(dest, 'utf8'); } catch {}
  if (existing === src) return;
  if (existing !== null) {
    console.log(`\n${dest} differs from the bundled version (customized, tuned, or outdated).`);
    if (!await confirm(`Update it? (the old copy is kept at ${name}.bak — re-apply any tuning after)`)) {
      console.log('Kept your existing script.');
      return;
    }
    writeFileSync(`${dest}.bak`, existing);
    console.log(`Old copy saved to ${dest}.bak`);
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(dest, src);
}

// Decisions are recorded here and applied to a fresh read of settings.json at
// the very end, so a long prompt pause can't clobber concurrent changes.
let wireManual = false;
let wireGuard = false;
let setStatusLine = false;
let addPerms = [];
let watchdogActive = false;
let pluginFresh = false; // plugin installed by THIS run, so already current

const WATCHDOG_EVENTS = manifestEntries('limit-watch.mjs').map(e => e.event);
const wiredEvents = (hooks, name) => WATCHDOG_EVENTS.filter(ev => isWired(hooks, ev, name));

// --- 1. Watchdog: plugin (recommended) or manual hook wiring ---
const pluginEnabled = settings.enabledPlugins?.['limit-watch@limit-watch'] === true;
const wired = wiredEvents(settings.hooks, 'limit-watch.mjs');
if (pluginEnabled) {
  console.log('Watchdog plugin already installed and enabled.');
  watchdogActive = true;
  if (wired.length > 0) {
    console.log(`Note: the watchdog is ALSO wired manually in settings.json (${wired.join(', ')}) —`);
    console.log('remove the manual entries so it does not run twice per event.');
  }
} else if (wired.length === WATCHDOG_EVENTS.length) {
  console.log('Watchdog hooks already wired in settings.json.');
  await installScript('limit-watch.mjs');
  watchdogActive = true;
} else if (wired.length > 0) {
  // Half-wired manual install (e.g. a partial settings merge): completing it
  // beats recommending the plugin, which would run the watchdog twice.
  console.log(`Watchdog hooks are only partially wired (missing ${WATCHDOG_EVENTS.filter(ev => !wired.includes(ev)).join(', ')}).`);
  if (await confirm('Complete the manual wiring in ~/.claude/settings.json?')) {
    await installScript('limit-watch.mjs');
    if (existsSync(join(hooksDir, 'limit-watch.mjs'))) {
      wireManual = true;
      watchdogActive = true;
    }
  }
} else if (has('claude')) {
  if (await confirm('Install the watchdog as a Claude Code plugin (recommended)?')) {
    console.log('\nRegistering marketplace (already-added is fine):');
    run('claude', ['plugin', 'marketplace', 'add', 'JohannHinrik/claude-limit-watch']);
    console.log('\nInstalling plugin:');
    if (run('claude', ['plugin', 'install', 'limit-watch@limit-watch'])) {
      watchdogActive = true;
      pluginFresh = true;
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

// Best-effort version of the already-installed plugin, so re-runs stay a
// no-op when it is current. Only plugins/cache counts: sessions execute from
// the versioned cache, and the marketplace clone under plugins/marketplaces
// updates ahead of it — scanning that would report an update as already
// installed while every session still runs the old cached version. The dir
// layout is not a stable contract, hence the bounded scan; not finding it
// just means offering the update.
const verGte = (a, b) => {
  const [x, y] = [String(a).split('.'), String(b).split('.')];
  for (let i = 0; i < 3; i++) {
    const [xi, yi] = [parseInt(x[i], 10) || 0, parseInt(y[i], 10) || 0];
    if (xi !== yi) return xi > yi;
  }
  return true;
};
function installedPluginVersion() {
  let best = null;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
      if (e.name === '.claude-plugin') {
        try {
          const p = JSON.parse(readFileSync(join(dir, e.name, 'plugin.json'), 'utf8'));
          if (p.name === 'limit-watch' && typeof p.version === 'string' && (!best || verGte(p.version, best))) best = p.version;
        } catch {}
      } else if (depth < 5) {
        walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(join(claudeDir, 'plugins', 'cache'), 0);
  return best;
}

// --- 1b. Agent gate (limit-guard.mjs on PreToolUse) ---
// Pauses new Agent/Task/Workflow launches when a freeze is imminent, so the
// limit does not catch a fan-out of subagents mid-task. Ships in the plugin's
// hooks.json (nothing to wire); manual installs need an explicit entry.
if (pluginEnabled) {
  const bundled = JSON.parse(readFileSync(join(here, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const installed = installedPluginVersion();
  if (installed && verGte(installed, bundled)) {
    console.log(`Plugin already at version ${installed}; nothing to update.`);
  } else if (await confirm(`Update the plugin to the bundled version (${bundled})?`)) {
    run('claude', ['plugin', 'install', 'limit-watch@limit-watch']);
  }
} else if (watchdogActive && !pluginFresh) {
  const guardWired = manifestEntries('limit-guard.mjs').every(e => isWired(settings.hooks, e.event, 'limit-guard.mjs'));
  if (guardWired) {
    console.log('Agent gate hook already wired; checking the installed script.');
    await installScript('limit-guard.mjs');
  } else if (await confirm('Wire the agent gate hook (pauses new subagent launches when a freeze is imminent)?')) {
    await installScript('limit-guard.mjs');
    if (existsSync(join(hooksDir, 'limit-guard.mjs'))) wireGuard = true;
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

// --- 3. Cron tool permissions ---
const CRON_PERMS = ['CronCreate', 'CronList', 'CronDelete'];
const missingPerms = CRON_PERMS.filter(p => !(settings.permissions?.allow || []).includes(p));
if (missingPerms.length) {
  console.log('\nThe model must be allowed to call the Cron tools: CronCreate schedules');
  console.log('the auto-resume, and CronDelete (with CronList to find the job) cancels');
  console.log('it when a task finishes before the limit. Non-prompting permission modes');
  console.log('silently deny non-allowlisted tools.');
  if (await confirm(`Add ${missingPerms.join(', ')} to permissions.allow?`)) addPerms = missingPerms;
}

// --- 4. Apply decisions to a fresh read of settings.json ---
if (wireManual || wireGuard || setStatusLine || addPerms.length) {
  let fresh = settings;
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (isSettingsObject(parsed)) fresh = parsed;
    } catch {}
  }
  const appendHooks = (name) => {
    fresh.hooks = fresh.hooks || {};
    for (const { event, matcher, timeout } of manifestEntries(name)) {
      if (!isWired(fresh.hooks, event, name)) {
        fresh.hooks[event] = [...(fresh.hooks[event] || []), { matcher, hooks: [{ type: 'command', command: scriptCmd(name), timeout }] }];
      }
    }
  };
  if (wireManual) appendHooks('limit-watch.mjs');
  if (wireGuard) appendHooks('limit-guard.mjs');
  if (setStatusLine) {
    fresh.statusLine = { type: 'command', command: scriptCmd('limit-statusline.mjs'), refreshInterval: 60 };
  }
  if (addPerms.length) {
    const allow = fresh.permissions?.allow || [];
    const toAdd = addPerms.filter(p => !allow.includes(p));
    if (toAdd.length) {
      fresh.permissions = { ...(fresh.permissions || {}), allow: [...allow, ...toAdd] };
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
