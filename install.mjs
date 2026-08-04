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
const PLUGIN_ID = 'limit-watch@limit-watch';
const MARKETPLACE = 'limit-watch';
const MARKETPLACE_REPO = 'JohannHinrik/claude-limit-watch';
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
const runQuiet = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', shell: win }).status === 0;
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
let rewireGuard = false; // drop stale limit-guard entries, then wire fresh
let setStatusLine = false;
let addPerms = [];
let watchdogActive = false;
let pluginFresh = false; // plugin installed by THIS run, so already current

const WATCHDOG_EVENTS = manifestEntries('limit-watch.mjs').map(e => e.event);
const wiredEvents = (hooks, name) => WATCHDOG_EVENTS.filter(ev => isWired(hooks, ev, name));

// --- 1. Watchdog: plugin (recommended) or manual hook wiring ---
const pluginEnabled = settings.enabledPlugins?.[PLUGIN_ID] === true;
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
    run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
    console.log('\nInstalling plugin:');
    if (run('claude', ['plugin', 'install', PLUGIN_ID])) {
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
// no-op when it is current. installed_plugins.json is the registry sessions
// actually load from, and it is the only source consulted: a version counts
// only when a user-scope entry (the scope `plugin update` acts on) carries a
// numeric version AND its installPath still exists on disk. A registry
// pointer to deleted code, the sentinel version "unknown", another scope's
// install, or a materialized-but-unregistered cache dir all count as "not
// installed" — offering a redundant (re)install is cheap, wrongly printing
// "nothing to update" strands the user. Not a stable contract, hence
// best-effort; not finding a version just means offering the update.
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
  try {
    const reg = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = reg.plugins?.[PLUGIN_ID];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e?.scope !== 'user') continue;
      if (typeof e?.version !== 'string' || !/^\d/.test(e.version)) continue;
      if (typeof e?.installPath !== 'string' || !existsSync(e.installPath)) continue;
      if (!best || verGte(e.version, best)) best = e.version;
    }
  } catch {}
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
  } else if (!has('claude')) {
    console.log(`The plugin needs an update to ${bundled}, but the claude CLI is not on`);
    console.log('PATH in this shell — run the update from inside Claude Code with /plugin.');
  } else if (installed) {
    if (await confirm(`Update the plugin to the bundled version (${bundled})?`)) {
      // `plugin install` on an already-installed plugin never moves the
      // version pointer in installed_plugins.json; only `plugin update` does,
      // and it updates from the local marketplace clone — which must be
      // refreshed first or the "update" reinstalls the stale version.
      if (!run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE])) {
        console.log('Marketplace refresh failed (offline?); skipped the plugin update — re-run later.');
      } else if (run('claude', ['plugin', 'update', PLUGIN_ID])) {
        console.log('Updated. Restart running sessions to load the new version.');
      } else {
        console.log('Plugin update failed; see the output above.');
      }
    }
  } else if (await confirm(`The plugin is enabled in settings but no working installed copy was found. (Re)install version ${bundled}?`)) {
    // Enabled-but-missing (synced settings, cleared cache, broken registry
    // entry): `plugin update` would error out here, so go through install.
    run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
    if (run('claude', ['plugin', 'install', PLUGIN_ID])) {
      console.log('Installed. Restart running sessions to load it.');
    } else {
      console.log('Plugin install failed; see the output above.');
    }
  }
} else if (watchdogActive && !pluginFresh) {
  const guardWired = manifestEntries('limit-guard.mjs').every(e => isWired(settings.hooks, e.event, 'limit-guard.mjs'));
  // isWired ignores the matcher, so a guard wired by an older version keeps
  // its narrower matcher forever — and the hard brake, which must see every
  // tool, would silently never fire. Detect the drift and offer to rewire.
  const staleMatcher = guardWired && manifestEntries('limit-guard.mjs').some(({ event, matcher }) =>
    !(settings.hooks?.[event] || []).some(m =>
      (m.matcher || '') === matcher && (m.hooks || []).some(h => runsInstalledCopy(h.command, 'limit-guard.mjs'))));
  if (guardWired && staleMatcher) {
    console.log('\nThe agent gate is wired with an out-of-date matcher, so newer tiers');
    console.log('(the opt-in hard brake, which must see every tool call) cannot fire.');
    await installScript('limit-guard.mjs');
    if (await confirm('Rewire it to the current matcher?')) rewireGuard = true;
  } else if (guardWired) {
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

// --- 3b. External tmux fallback resumer (macOS launchd) ---
// Covers what no in-session mechanism can: a monster turn that blows through
// 100% before CronCreate ever happened, or a session whose cron died with the
// process. The watchdog records the hosting tmux pane when it arms;
// limit-resume.mjs, run by launchd once a minute, types the resume prompt
// into panes whose window has reset. Only offered where it can work: the
// watchdog is installed, the platform has launchd, and tmux is present.
const LAUNCHD_LABEL = 'com.limit-watch.tmux-resumer';
if (watchdogActive && process.platform === 'darwin') {
  if (!has('tmux')) {
    console.log('\n(tmux not found — skipping the tmux fallback resumer. It resumes');
    console.log('sessions that froze before their cron was created; install tmux and');
    console.log('re-run this installer to add it.)');
  } else {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const q = existsSync(plistPath)
      ? '\nRefresh the tmux fallback resumer (launchd agent)?'
      : '\nInstall the tmux fallback resumer? (launchd agent, checks once a minute, types the resume prompt into tmux panes whose session froze at 100% without its cron)';
    if (await confirm(q)) {
      await installScript('limit-resume.mjs');
      if (existsSync(join(hooksDir, 'limit-resume.mjs'))) {
        const tmuxPath = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout?.trim();
        const pathEnv = `${tmuxPath ? dirname(tmuxPath) + ':' : ''}/usr/bin:/bin`;
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${join(hooksDir, 'limit-resume.mjs')}</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${pathEnv}</string></dict>
</dict></plist>
`;
        mkdirSync(dirname(plistPath), { recursive: true });
        writeFileSync(plistPath, plist);
        const domain = `gui/${process.getuid()}`;
        runQuiet('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]); // stale agent from a previous run; absent is fine
        if (runQuiet('launchctl', ['bootstrap', domain, plistPath])) {
          console.log(`Resumer installed. Remove with: launchctl bootout ${domain}/${LAUNCHD_LABEL} && rm '${plistPath}'`);
        } else {
          console.log(`Wrote ${plistPath}, but 'launchctl bootstrap' failed;`);
          console.log(`load it manually with: launchctl bootstrap ${domain} '${plistPath}'`);
        }
      }
    }
  }
} else if (watchdogActive && has('tmux')) {
  // No launchd off macOS, so the agent cannot be registered here — but the
  // resumer script itself is portable. Install it and hand over the cron line
  // rather than skipping in silence.
  console.log('\nThe tmux fallback resumer recovers sessions that froze before their');
  console.log('cron existed (or whose process died). Registering it automatically needs');
  console.log('launchd (macOS only), but the script is portable.');
  if (await confirm('Install the script and print the cron line for it?')) {
    await installScript('limit-resume.mjs');
    if (existsSync(join(hooksDir, 'limit-resume.mjs'))) {
      console.log('\nAdd this to your crontab (crontab -e) to run it every minute:');
      console.log(`  * * * * * ${process.execPath} ${join(hooksDir, 'limit-resume.mjs')}`);
    }
  }
}

// --- 4. Apply decisions to a fresh read of settings.json ---
if (wireManual || wireGuard || rewireGuard || setStatusLine || addPerms.length) {
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
  // Drop every entry running our copy of a script (any matcher), so the
  // subsequent appendHooks re-adds it with the manifest's current matcher.
  const dropHooks = (name) => {
    for (const ev of Object.keys(fresh.hooks || {})) {
      fresh.hooks[ev] = (fresh.hooks[ev] || [])
        .map(m => ({ ...m, hooks: (m.hooks || []).filter(h => !runsInstalledCopy(h.command, name)) }))
        .filter(m => (m.hooks || []).length > 0);
      if (!fresh.hooks[ev].length) delete fresh.hooks[ev];
    }
  };
  if (rewireGuard) dropHooks('limit-guard.mjs');
  if (wireManual) appendHooks('limit-watch.mjs');
  if (wireGuard || rewireGuard) appendHooks('limit-guard.mjs');
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
