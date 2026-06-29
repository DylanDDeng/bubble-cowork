---
name: dev-restart
description: Kill all running coworker/Electron dev processes and restart the dev server cleanly. Use when the dev environment is stuck, unresponsive, or needs a fresh start.
---

# Dev Restart

Kill all running coworker dev processes and restart the dev server.

## When to use

- Dev server is unresponsive or stuck
- After major dependency changes that need a clean restart
- Electron window is frozen or showing stale state
- User reports "dev server won't start" or "electron won't open"

## Procedure

### Step 1: Kill all running processes

```bash
cd /Users/chengshengdeng/coworker
pkill -f "coworker/node_modules/.bin/concurrently" 2>/dev/null
pkill -f "coworker.*launch-electron.mjs" 2>/dev/null
pkill -f "coworker/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null
sleep 2
```

### Step 2: Start dev server

```bash
cd /Users/chengshengdeng/coworker
nohup npm run dev > /tmp/coworker-dev.log 2>&1 &
disown
```

### Step 3: Wait for Electron to be ready

```bash
until pgrep -f "coworker/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1; do sleep 2; done
echo "coworker UP"
```

### Step 4: Verify

Check that the dev log shows no errors:

```bash
tail -20 /tmp/coworker-dev.log
```

## Notes

- The `pkill` commands are idempotent — safe to run even if processes are already dead.
- The `nohup` + `disown` pattern ensures the dev server survives if the terminal session ends.
- If Electron still fails to start after this, check `/tmp/coworker-dev.log` for the actual error.
