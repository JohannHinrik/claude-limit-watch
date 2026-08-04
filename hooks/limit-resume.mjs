#!/usr/bin/env node
// External tmux fallback resumer. Runs OUTSIDE Claude Code (launchd on macOS,
// cron elsewhere), typically once a minute. Covers the cases no in-session
// mechanism can: a monster turn that blows through 100% before CronCreate
// happened, a session sitting on the limit modal (crons only fire while the
// REPL is idle, and a modal is not idle), or a session process that exited
// and took its in-memory cron with it.
//
// The watchdog (limit-watch.mjs) drops a `<session>-<reset>.tmux` sidecar in
// the marks dir when a tmux-hosted session arms, recording the pane, socket,
// session id and cwd. Once the window has been reset for RESUME_AFTER_S
// (later than the in-session cron's 2 minutes, so this stays the fallback),
// one of three things happens to the pane:
//
//   live Claude, limit visible   dismiss the modal if present, type the prompt
//   shell (session exited)       relaunch `claude --resume <id>`, prompt next tick
//   anything else                left alone
//
// A `.resumed` sidecar records the outcome and makes each pane once-only; a
// duplicate resume — both this and the cron firing — costs the session one
// short reply, which the prompt itself says is fine.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RESUME_AFTER_S = 300; // fire this long after the reset (cron fires at 120s)
// The resume is only typed when the limit freeze is visibly on screen
// (claude-auto-continue's idea): capture-pane text must match this before we
// touch the pane. Fails toward skipping — a finished session, a fresh Claude
// that took over the pane, or a session the in-session cron already resumed
// shows no limit message and is left alone. Tune here if the wording changes.
const LIMIT_RE = /(usage|rate|session|5-hour|weekly) limit|limit (reached|reset|will reset)|wait for limit|out of (usage|quota)|hit your.*limit|ask your admin for more usage/i;
// Claude Code blocks on a choice modal ("What do you want to do? 1. Stop and
// wait for limit to reset ...") rather than a plain message. Typing a prompt
// there would drive the selection UI, so the modal is dismissed with Escape
// first and the prompt typed into the freed input.
const MODAL_RE = /what do you want to do\?|stop and wait for limit|ask your admin for more usage/i;
const CAPTURE_LINES = 2000; // scrollback depth searched for the message
// A pane back at a shell means the session process is gone (killed, crashed,
// or exited on the limit) — the one case even a live-pane resume cannot
// reach. `claude --resume <id>` restarts it with the transcript intact; the
// prompt follows on the next tick, once the process is actually up.
const RELAUNCH_DEAD = true;
const SHELL_RE = /^-?(sh|bash|zsh|fish|ksh)$/;

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
  const typePrompt = () => {
    const prompt = `Resumed by limit-watch (tmux fallback): the usage window has reset. Read the handoff note at ${base}.md if it exists and resume from its next step; otherwise continue the interrupted task if any work remains. If everything was already complete, or an in-session resume already fired, reply briefly and stop.`;
    tmux(['send-keys', '-t', info.pane, '-l', prompt]);
    tmux(['send-keys', '-t', info.pane, 'Enter']);
  };

  try {
    const cmd = tmux(['display-message', '-p', '-t', info.pane, '#{pane_current_command}']);
    const relaunched = existsSync(`${base}.relaunched`);

    if (/^(claude|node)$/.test(cmd)) {
      // A pane we relaunched ourselves shows no limit message (fresh start),
      // so the visible-freeze gate is waived for exactly that case.
      if (!relaunched) {
        const screen = tmux(['capture-pane', '-p', '-t', info.pane, '-S', `-${CAPTURE_LINES}`]);
        if (!LIMIT_RE.test(screen)) { done('skip:no-limit-message'); continue; }
        if (MODAL_RE.test(screen)) {
          tmux(['send-keys', '-t', info.pane, 'Escape']);
        }
      }
      typePrompt();
      done(relaunched ? 'sent:after-relaunch' : 'sent');
      continue;
    }

    if (RELAUNCH_DEAD && SHELL_RE.test(cmd) && !relaunched && typeof info.session === 'string') {
      // Only ever types a `claude --resume` command, never a bare prompt, so a
      // shell that is not ours cannot be made to run something arbitrary.
      const cd = typeof info.cwd === 'string' && info.cwd ? `cd ${JSON.stringify(info.cwd)} && ` : '';
      tmux(['send-keys', '-t', info.pane, '-l', `${cd}claude --resume ${info.session}`]);
      tmux(['send-keys', '-t', info.pane, 'Enter']);
      try { writeFileSync(`${base}.relaunched`, ''); } catch {}
      continue; // prompt goes in on a later tick, once the process is up
    }

    done(`skip:${cmd}`);
  } catch {
    done('pane-gone');
  }
}
