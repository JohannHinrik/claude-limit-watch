---
description: One-time setup for limit-watch — install the status line and CronCreate permission
---

The limit-watch plugin's PostToolUse/Stop hooks are already active (plugins
register hooks automatically). Two pieces cannot ship inside a plugin and must
be added to the user's settings. Complete them now:

## 1. Install the status line script

The status line is what caches the `rate_limits` block to
`~/.claude/rate-limit-state.json` — without it the watchdog hook has no data
and stays silent.

1. Locate the plugin's copy: run
   `find ~/.claude/plugins -type f -name limit-statusline.mjs` and take the
   first match.
2. Copy it to `~/.claude/hooks/limit-statusline.mjs` (create the directory if
   needed). A stable copy is used instead of the plugin path so plugin updates
   or reinstalls never break the status line reference in settings.
3. If `~/.claude/settings.json` already has a custom `statusLine` command,
   show it to the user and ask whether to merge its display into the copied
   script (dir/branch/context-style segments port over easily) or replace it.
   Whatever the outcome, the block that writes
   `~/.claude/rate-limit-state.json` must survive.

## 2. Update ~/.claude/settings.json

Read the existing file and preserve every key you do not change. Apply:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hooks/limit-statusline.mjs",
    "refreshInterval": 60
  },
  "permissions": {
    "allow": ["CronCreate"]
  }
}
```

For `permissions.allow`, append `"CronCreate"` to any existing array rather
than replacing it. The permission is required because in non-prompting
permission modes a non-allowlisted CronCreate call is silently denied and the
auto-resume cron is never created.

If the permission system denies your settings edit (auto mode blocks
self-permission changes), do NOT work around it: print the exact merged JSON
and ask the user to apply it themselves, e.g. by running the copy/edit command
with the `!` prefix.

## 3. Verify

- Confirm `node` is on PATH.
- Tell the user the status line updates on its next refresh and that
  `~/.claude/rate-limit-state.json` appearing confirms the cache is live
  (rate limits only appear for Pro/Max subscription accounts).
