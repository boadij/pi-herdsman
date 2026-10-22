param([switch]$DefinitionsOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$package = 'pi-herdsman'

function Fail([string]$Message) { throw $Message }
function Refresh-Path {
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'), $env:Path) | Where-Object { $_ } | Select-Object -Unique
    $env:Path = $parts -join ';'
}
function Resolve-Command([string]$Name) { Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Invoke-UpstreamInstaller([string]$Url) {
    # Upstream publishes no independent signature/hash; trust is HTTPS to the official host.
    $file = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.ps1')
    try {
        Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
        if (-not (Test-Path $file) -or (Get-Item $file).Length -eq 0) { Fail "Downloaded installer was empty: $Url" }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file
        if ($LASTEXITCODE -ne 0) { Fail "Official installer failed with exit code ${LASTEXITCODE}: $Url" }
    } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
    Refresh-Path
}
function Version([string]$Command) {
    $output = & $Command --version
    if ($LASTEXITCODE -ne 0) { Fail "$Command --version failed with exit code $LASTEXITCODE" }
    $match = [regex]::Match(($output | Out-String).Trim(), '(\d+\.\d+\.\d+)(?:-preview(?:\.[0-9A-Za-z-]+)?)?\s*$')
    if (-not $match.Success) { Fail "$Command reported an invalid version" }
    return [version]$match.Groups[1].Value
}

function Invoke-Bootstrap {
try {
    if ($env:OS -ne 'Windows_NT') { Fail 'This installer supports Windows only.' }
    if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Windows bootstrap requires 64-bit Windows.' }
    try { $manifest = Invoke-RestMethod -Uri "https://registry.npmjs.org/$package/latest" -TimeoutSec 30 }
    catch { Fail 'Could not resolve pi-herdsman@latest from the npm registry over HTTPS.' }
    $herdsmanVersion = $manifest.version
    if (-not $herdsmanVersion -or -not $manifest.piHerdsman.runtime.pi -or -not $manifest.piHerdsman.runtime.herdr.version) { Fail 'Released package is missing bootstrap runtime metadata.' }
    $nodeRequirement = [regex]::Match([string]$manifest.engines.node, '^>=\s*(\d+\.\d+\.\d+)')
    if (-not $nodeRequirement.Success) { Fail 'Released package has an unsupported Node.js engine requirement.' }
    $nodeMinimum = [version]$nodeRequirement.Groups[1].Value
    $piMinimum = [version]$manifest.piHerdsman.runtime.pi
    $herdrMinimum = [version]$manifest.piHerdsman.runtime.herdr.version

    $pi = Resolve-Command 'pi.cmd'; if (-not $pi) { $pi = Resolve-Command 'pi' }
    $node = Resolve-Command 'node'
    if (-not $pi -or (Version $pi.Source) -lt $piMinimum -or -not $node -or (Version $node.Source) -lt $nodeMinimum -or -not (Resolve-Command 'npm.cmd')) {
        Write-Host "Installing/updating Pi (minimum $piMinimum) with its official installer..."
        Invoke-UpstreamInstaller 'https://pi.dev/install.ps1'
        $pi = Resolve-Command 'pi.cmd'; if (-not $pi) { $pi = Resolve-Command 'pi' }
    }
    if (-not (Resolve-Command 'node') -or -not (Resolve-Command 'npm.cmd')) { Fail "Pi installer completed, but Node.js and/or npm are unavailable. Refresh PATH or install Node.js $($manifest.engines.node) and npm, then retry." }
    $nodeVersion = Version 'node'
    $npmVersion = Version 'npm.cmd'
    if ($nodeVersion -lt $nodeMinimum) { Fail "Node.js $nodeVersion is below released package requirement $($manifest.engines.node). The Pi installer did not update Node.js. Install/update Node.js to $($manifest.engines.node) using the official installer at https://nodejs.org/en/download, close and reopen PowerShell, then rerun this command." }
    if (-not $pi) { Fail 'Pi installer completed, but pi.cmd/pi cannot be resolved. Open a new terminal or repair PATH, then retry.' }
    $installedPi = Version $pi.Source
    if ($installedPi -lt $piMinimum) { Fail "Pi $installedPi is below required minimum $piMinimum after installation." }

    $herdr = Resolve-Command 'herdr.exe'; if (-not $herdr) { $herdr = Resolve-Command 'herdr' }
    if (-not $herdr -or (Version $herdr.Source) -lt $herdrMinimum) {
        Write-Host "Installing/updating Herdr (minimum $herdrMinimum) with its official installer..."
        Invoke-UpstreamInstaller 'https://herdr.dev/install.ps1'
        $herdr = Resolve-Command 'herdr.exe'; if (-not $herdr) { $herdr = Resolve-Command 'herdr' }
    }
    if (-not $herdr) { Fail 'Herdr installer completed, but herdr.exe/herdr cannot be resolved. Open a new terminal or repair PATH, then retry.' }
    $installedHerdr = Version $herdr.Source
    if ($installedHerdr -lt $herdrMinimum) { Fail "Herdr $installedHerdr is below required minimum $herdrMinimum after installation." }

    $list = & $pi.Source list --no-approve
    if ($LASTEXITCODE -ne 0) { Fail 'Could not inspect installed Pi packages; refusing speculative installation.' }
    $lines = $list | ForEach-Object { "$($_)".Trim() }
    if ($lines | Where-Object { $_ -match '^npm:pi-herdsman@\S+(?:\s+\(filtered\))?$' }) { Fail "Pi Herdsman is version-pinned; change/remove the pin using Pi's package manager, then rerun." }
    if ($lines | Where-Object { $_ -match '^npm:pi-herdsman(?:\s+\(filtered\))?$' }) { & $pi.Source update "npm:$package" --no-approve }
    else { & $pi.Source install "npm:$package" --no-approve }
    if ($LASTEXITCODE -ne 0) { Fail "Pi package reconciliation failed with exit code $LASTEXITCODE." }
    & $herdr.Source integration install pi
    if ($LASTEXITCODE -ne 0) { Fail "Herdr integration installation failed with exit code $LASTEXITCODE." }
    $integrationStatus = & $herdr.Source integration status
    if ($LASTEXITCODE -ne 0) { Fail "Herdr integration verification failed with exit code $LASTEXITCODE." }
    if (-not (($integrationStatus -join "`n") -match '(?m)^pi: current \(v\d+\)(?: .+)?$')) { Fail "Herdr Pi integration is not enabled/current:`n$($integrationStatus -join "`n")" }

    Write-Host "`nPi Herdsman package operation completed (target release $herdsmanVersion). Pi $installedPi and Herdr $installedHerdr are available.`n"
    Write-Host "Next steps:`n  1. Open your project and run: herdr`n  2. Start Pi inside a Herdr pane: pi`n  3. In Pi, use /login if authentication is needed`n  4. Ask: Use scout to inspect this repository without changing files.`n  5. Open /herdsman for controls"
} catch {
    [Console]::Error.WriteLine("  x $($_.Exception.Message)")
    throw
}
}

if (-not $DefinitionsOnly) {
    try { Invoke-Bootstrap } catch { exit 1 }
}
