#!/usr/bin/env node
// External tmux fallback resumer. Runs OUTSIDE Claude Code (launchd on macOS,
// cron elsewhere), typically once a minute. Covers the case the in-session
// cron cannot: a monster turn that blows through 100% before CronCreate ever
// happened, or a session process whose cron died with it.
//
// The watchdog (limit-watch.mjs) drops a `<session>-<reset>.tmux` sidecar in
// the marks dir when a tmux-hosted session arms, recording the pane and
// socket. Once a window has been reset for RESUME_AFTER_S (later than the
// in-session cron's 2 minutes, so this is strictly the fallback), the prompt
// is typed into the pane via send-keys. A `.resumed` sidecar makes each
// attempt once-only; a duplicate resume — both paths firing — costs the
// session one short reply, which the prompt itself says is fine.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RESUME_AFTER_S = 300; // fire this long after the reset (cron fires at 120s)

const markDir = join(homedir(), '.claude', 'limit-watch-marks');
const now = Math.floor(Date.now() / 1000);

let files = [];
try { files = readdirSync(markDir); } catch { process.exit(0); }
for (const f of files) {
  const m = f.match(/^(.+-(\d+))\.tmux$/);
  if (!m) continue;
  const resets = Number(m[2]);
  if (!Number.isFinite(resets)) continue;
  if (resets + RESUME_AFTER_S > now) continue; // window not reset long enough yet
  if (resets + 86400 < now) continue;          // stale; the watchdog prunes these
  const base = join(markDir, m[1]);
  if (existsSync(`${base}.resumed`)) continue;

  let info = null;
  try { info = JSON.parse(readFileSync(join(markDir, f), 'utf8')); } catch {}
  const done = (outcome) => { try { writeFileSync(`${base}.resumed`, outcome); } catch {} };
  if (typeof info?.pane !== 'string' || typeof info?.socket !== 'string') { done('bad-sidecar'); continue; }

  const tmux = (args) => execFileSync('tmux', ['-S', info.socket, ...args],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
  try {
    // Only type into a pane still running a Claude process; anything else
    // means the session ended and the shell (or another program) owns it now.
    const cmd = tmux(['display-message', '-p', '-t', info.pane, '#{pane_current_command}']);
    if (!/^(claude|node)$/.test(cmd)) { done(`skip:${cmd}`); continue; }
    const prompt = `Resumed by limit-watch (tmux fallback): the usage window has reset. Read the handoff note at ${base}.md if it exists and resume from its next step; otherwise continue the interrupted task if any work remains. If everything was already complete, or an in-session resume already fired, reply briefly and stop.`;
    tmux(['send-keys', '-t', info.pane, '-l', prompt]);
    tmux(['send-keys', '-t', info.pane, 'Enter']);
    done('sent');
  } catch {
    done('pane-gone');
  }
}
