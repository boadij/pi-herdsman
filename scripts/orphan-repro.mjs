import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTestRunner } from './check.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const marker = 'HERDSMAN_CONTROLLED_ORPHAN_FIXTURE_20261029';
if (process.argv[2] === 'child') {
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), 60000);
} else if (process.argv[2] === 'parent') {
  const child = spawn(process.execPath, [process.argv[1], 'child', process.argv[3], marker], { stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => process.exit(1), 20000).unref();
  const timer = setInterval(() => { if (existsSync(process.argv[4])) { clearInterval(timer); process.exit(0); } }, 20);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-repro-'));
  const pidFile = join(dir, 'pid');
  const release = join(dir, 'release');
  let pid;
  let failed = false;
  let aborted = false;
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
  try {
    const ready = (async () => {
      for (let i = 0; i < 200; i++) {
        if (existsSync(pidFile)) {
          const n = Number(readFileSync(pidFile, 'utf8'));
          if (Number.isSafeInteger(n) && n > 0) { pid = n; return Date.now() + 500; }
        }
        await pause(50);
      }
      throw new Error('readiness');
    })();
    const result = await runTestRunner([process.argv[1], 'parent', pidFile, release], ready, 'fixture', async (_runner, signal) => {
      console.log('status: snapshot-started');
      writeFileSync(release, 'release');
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve('slow snapshot deadline'), 15000);
        signal.addEventListener('abort', () => { clearTimeout(timer); aborted = true; resolve('aborted'); }, { once: true });
      });
    });
    console.log(`status: classification=${result.kind}`);
    console.log(`status: runner-tree-gone=${result.treeGone}`);
    console.log(`status: snapshot-aborted=${aborted}`);
    console.log(`status: child-survived=${alive()}`);
    if (result.kind !== 'suite-timeout' || !result.treeGone || !aborted || !alive()) failed = true;
  } catch {
    console.log('status: reproduction-error');
    failed = true;
  } finally {
    try {
      if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('missing pid');
      if (alive()) {
        const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p -and $p.CommandLine -like '*${marker}*') { exit 0 } else { exit 1 }`;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, stdio: 'ignore', windowsHide: true });
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, stdio: 'ignore', windowsHide: true });
        console.log('status: fixture-cleanup-sent');
      }
      for (let i = 0; i < 100 && alive(); i++) await pause(50);
      const gone = !alive();
      console.log(`status: fixture-child-gone=${gone}`);
      if (!gone) failed = true;
    } catch {
      console.log('status: fixture-cleanup-unverified');
      failed = true;
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { console.log('status: fixture-files-cleanup-failed'); failed = true; }
  }
  if (failed) process.exitCode = 1;
}
