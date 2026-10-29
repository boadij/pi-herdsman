import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const queries = {
  startup: "$null = 1",
  all: "$null = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, CommandLine, CreationDate FROM Win32_Process')",
  targeted: "$null = @(Get-CimInstance -Query \"SELECT ProcessId, ParentProcessId, Name, CommandLine, CreationDate FROM Win32_Process WHERE ParentProcessId = $PID\")",
};
for (const [name, query] of Object.entries(queries)) {
  for (let sample = 1; sample <= 5; sample++) {
    const script = `$ErrorActionPreference = 'Stop'; $watch = [Diagnostics.Stopwatch]::StartNew(); ${query}; $watch.Stop(); [Console]::WriteLine($watch.ElapsedMilliseconds)`;
    const start = performance.now();
    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (!/^\d+$/.test(output)) throw new Error();
      process.stdout.write(`${name} sample=${sample} total_ms=${Math.round(performance.now() - start)} query_ms=${output}\n`);
    } catch {
      process.stdout.write(`${name} sample=${sample} status=unavailable total_ms=${Math.round(performance.now() - start)}\n`);
    }
  }
}
