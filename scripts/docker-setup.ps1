# Native Windows setup for Docker Desktop. The guided flow intentionally offers standard Docker only.
$ErrorActionPreference = 'Stop'

function Fail([string] $Message) { throw "docker-setup: $Message" }
function Invoke-Docker([string[]] $Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "docker $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}
function ConvertFrom-ComposeDotenvValue([string] $Value) {
  $value = $Value.Trim()
  $quote = [char]0
  for ($index = 0; $index -lt $value.Length; $index++) {
    $character = $value[$index]
    if ($quote -ne [char]0) {
      if ($character -eq $quote) { $quote = [char]0 }
    } elseif (($character -eq '"' -or $character -eq "'") -and $index -eq 0) {
      $quote = $character
    } elseif ($character -eq '#' -and $index -gt 0 -and [char]::IsWhiteSpace($value[$index - 1])) {
      $value = $value.Substring(0, $index).TrimEnd()
      break
    }
  }
  if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
    return $value.Substring(1, $value.Length - 2)
  }
  return $value
}
function Read-ComposeSetting([string] $Path) {
  if ($env:COMPOSE_FILE) { return ConvertFrom-ComposeDotenvValue $env:COMPOSE_FILE }
  if (Test-Path -LiteralPath $Path) {
    foreach ($line in Get-Content -LiteralPath $Path) {
      if ($line -match '^\s*(?:export\s+)?COMPOSE_FILE\s*=\s*(.*?)\s*$') { return ConvertFrom-ComposeDotenvValue $Matches[1] }
    }
  }
  return ''
}
function Test-PositiveCanonicalMpint([byte[]] $Value) {
  if ($Value.Length -eq 0 -or $Value[0] -ge 128) { return $false }
  if ($Value[0] -eq 0) {
    return $Value.Length -ge 2 -and $Value[1] -ge 128
  }
  return $true
}
function Test-OpenSshPublicKey([string] $Key) {
  if ($Key -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\s+([A-Za-z0-9+/]+={0,2})(\s+.*)?$') { return $false }
  $type = $Matches[1]
  try { $bytes = [Convert]::FromBase64String($Matches[2]) } catch { return $false }
  $stream = [IO.MemoryStream]::new($bytes, $false)
  $reader = [IO.BinaryReader]::new($stream)
  function Read-SshString {
    param([IO.BinaryReader] $Reader)
    if (($Reader.BaseStream.Length - $Reader.BaseStream.Position) -lt 4) { throw 'truncated length' }
    $lengthBytes = $Reader.ReadBytes(4)
    $length = ([long]$lengthBytes[0] * 16777216) + ([long]$lengthBytes[1] * 65536) + ([long]$lengthBytes[2] * 256) + [long]$lengthBytes[3]
    if ($length -eq 0 -or $length -gt ($Reader.BaseStream.Length - $Reader.BaseStream.Position)) { throw 'invalid string length' }
    return ,($Reader.ReadBytes([int]$length))
  }
  try {
    $wireType = [Text.Encoding]::ASCII.GetString((Read-SshString $reader))
    if ($wireType -cne $type) { return $false }
    switch -Regex ($type) {
      '^ssh-ed25519$' {
        if ((Read-SshString $reader).Length -ne 32) { return $false }
      }
      '^sk-ssh-ed25519@openssh.com$' {
        if ((Read-SshString $reader).Length -ne 32) { return $false }
        if ((Read-SshString $reader).Length -lt 1) { return $false }
      }
      '^ssh-rsa$' {
        if (-not (Test-PositiveCanonicalMpint (Read-SshString $reader))) { return $false }
        if (-not (Test-PositiveCanonicalMpint (Read-SshString $reader))) { return $false }
      }
      '^(?:sk-)?ecdsa-sha2-' {
        $curve = [Text.Encoding]::ASCII.GetString((Read-SshString $reader))
        $expectedCurve = $type -replace '^(?:sk-)?ecdsa-sha2-', '' -replace '@openssh.com$', ''
        if ($curve -cne $expectedCurve) { return $false }
        $point = Read-SshString $reader
        $expected = switch -Regex ($type) { 'nistp256$' { 65 } 'nistp384$' { 97 } 'nistp521$' { 133 } }
        if ($point.Length -ne $expected -or $point[0] -ne 4) { return $false }
        if ($type -like 'sk-*' -and (Read-SshString $reader).Length -lt 1) { return $false }
      }
    }
    return $reader.BaseStream.Position -eq $reader.BaseStream.Length
  } catch {
    return $false
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Download-Compose([string] $Name) {
  if (Test-Path -LiteralPath $Name) { return }
  if ($Name -notin @('compose.yaml', 'compose.tailscale.yaml', 'compose.bind-mount.yaml')) { return }
  $temp = Join-Path $script:ProjectDir (".$Name.tmp.$([guid]::NewGuid().ToString('N'))")
  try {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/boadij/pi-herdsman/main/$Name" -OutFile $temp -UseBasicParsing
    if (-not (Test-Path -LiteralPath $temp) -or (Get-Item -LiteralPath $temp).Length -eq 0) { Fail "download of $Name was empty." }
    if (-not (Test-Path -LiteralPath $Name)) { Move-Item -LiteralPath $temp -Destination $Name }
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

$script:ProjectDir = [IO.Path]::GetFullPath($(if ($env:PI_HERDSMAN_DIR) {
  $env:PI_HERDSMAN_DIR
} else {
  (Get-Location).ProviderPath
}))
New-Item -ItemType Directory -Force -Path $script:ProjectDir | Out-Null
Push-Location $script:ProjectDir
try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker CLI is required; install Docker Desktop first.' }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose v2 is required.' }
  $dockerOSType = & docker info --format '{{.OSType}}' 2>$null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker engine is unavailable; start Docker Desktop and retry.' }
  if (($dockerOSType | Out-String).Trim() -cne 'linux') {
    Fail "Docker must use a reachable Linux-container engine (reported OSType: '$($dockerOSType -join ' ')'). Switch Docker Desktop to Linux containers and retry."
  }

  $envPath = Join-Path $script:ProjectDir '.env'
  if (Test-Path -LiteralPath $envPath) {
    if (Select-String -LiteralPath $envPath -Pattern '^\s*(export\s+)?TS_AUTHKEY\s*=\s*\S' -Quiet) {
      Fail 'remove TS_AUTHKEY from .env; do not persist bootstrap credentials.'
    }
  }

  $setting = Read-ComposeSetting $envPath
  $separator = if ($env:COMPOSE_PATH_SEPARATOR) { $env:COMPOSE_PATH_SEPARATOR } else { ';' }
  if ($setting -and (($setting -split [regex]::Escape($separator)) -contains 'compose.tailscale.yaml')) {
    Fail 'Windows guided setup supports standard Docker only; configure Tailscale manually after Docker Desktop acceptance.'
  }
  $existingCompose = $setting -or @( 'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml' | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0
  if (-not $existingCompose) {
    $orphanedOverrides = @('compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml' | Where-Object { Test-Path -LiteralPath $_ })
    if ($orphanedOverrides.Count -gt 0) { Fail "Compose override exists without a base configuration: $($orphanedOverrides -join ', '); restore the base or explicitly select a configuration." }
    $choice = Read-Host 'Deployment: [1] Standard Docker (default)'
    if ($choice -and $choice -ne '1') { Fail 'The Windows guided setup supports standard Docker only.' }
    Download-Compose 'compose.yaml'
  }

  $modelText = & docker compose config --format json
  if ($LASTEXITCODE -ne 0) { Fail 'could not resolve Compose configuration.' }
  try { $model = ($modelText | Out-String) | ConvertFrom-Json } catch { Fail 'Compose returned invalid configuration JSON.' }
  if (-not $model.services.herdsman) { Fail 'selected Compose configuration does not contain a herdsman service.' }
  # Network namespace sharing requires sidecar lifecycle management, which the
  # Windows guided flow does not implement. Inspect the merged model, not file names.
  $sidecars = @($model.services.PSObject.Properties | Where-Object {
    $_.Name -ieq 'tailscale' -or [string]$_.Value.image -match '(^|/)tailscale(?:/tailscale)?(?::|@|$)'
  })
  if ($sidecars.Count -gt 0 -or [string]$model.services.herdsman.network_mode -match '^service:') {
    Fail 'Windows guided setup does not support Tailscale or service network namespace sharing; configure it manually.'
  }
  $mounts = @($model.services.herdsman.volumes | Where-Object { $_.target -eq '/home/herdsman' })
  if ($mounts.Count -ne 1) { Fail 'expected exactly one Herdsman home mount.' }
  $mount = $mounts[0]
  $uid = [string]$model.services.herdsman.environment.PUID
  $gid = [string]$model.services.herdsman.environment.PGID
  if (-not $uid) { $uid = '1000' }
  if (-not $gid) { $gid = '1000' }
  if ($uid -notmatch '^[1-9][0-9]*$' -or $gid -notmatch '^[1-9][0-9]*$') {
    Fail 'PUID and PGID must be positive decimal integers; use nonzero IDs.'
  }
  $projectName = [string]$model.name
  if (-not $projectName) { Fail 'Compose did not report a project name.' }
  $containers = @(& docker ps -aq --filter "label=com.docker.compose.project=$projectName")
  if ($LASTEXITCODE -ne 0) { Fail 'could not inspect existing Compose containers.' }
  foreach ($container in $containers) {
    if (-not $container) { continue }
    $inspectText = & docker inspect $container
    if ($LASTEXITCODE -ne 0) { Fail 'could not inspect an existing Compose container.' }
    try { $info = @(($inspectText | Out-String) | ConvertFrom-Json)[0] } catch { Fail 'Docker returned invalid container inspection JSON.' }
    $workingDir = $info.Config.Labels.'com.docker.compose.project.working_dir'
    if (-not $workingDir -or -not [string]::Equals([IO.Path]::GetFullPath($workingDir).TrimEnd('\', '/'), $script:ProjectDir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
      Fail "Compose project '$projectName' belongs to '$workingDir', not '$script:ProjectDir'."
    }
    if ($info.Config.Labels.'com.docker.compose.service' -eq 'herdsman') {
      $oldHome = @($info.Mounts | Where-Object { $_.Destination -eq '/home/herdsman' })
      $expectedSource = if ($mount.type -eq 'volume') { $model.volumes.($mount.source).name } else { [IO.Path]::GetFullPath($mount.source) }
      $oldSource = if ($mount.type -eq 'volume') { $oldHome[0].Name } else { $oldHome[0].Source }
      $sourceComparison = if ($mount.type -eq 'volume') { [StringComparison]::Ordinal } else { [StringComparison]::OrdinalIgnoreCase }
      if ($oldHome.Count -ne 1 -or $oldHome[0].Type -ne $mount.type -or -not [string]::Equals($oldSource, $expectedSource, $sourceComparison)) {
        Fail 'existing Herdsman home mount differs from the selected configuration; refusing storage migration.'
      }
    }
  }
  # Do not allow Compose to create a missing bind source as root. Existing
  # sources are checked below from inside the Linux engine, where its actual
  # ownership and access semantics apply.
  if ($mount.type -eq 'bind' -and -not (Test-Path -LiteralPath $mount.source -PathType Container)) {
    Fail 'bind-mounted home must already exist; create and configure it manually before setup.'
  }
  if ($mount.type -notin @('volume', 'bind')) { Fail 'unsupported Herdsman home mount type.' }

  # Check the image account database and StrictModes without changing either.
  $preflightScript = @'
set -eu
uid=$1
gid=$2
current_uid=$(id -u herdsman)
current_gid=$(id -g herdsman)
if [ "$uid" != "$current_uid" ] && getent passwd "$uid" >/dev/null; then exit 1; fi
if [ "$gid" != "$current_gid" ] && getent group "$gid" >/dev/null; then exit 1; fi
owner=$(stat -c %u /home/herdsman)
mode=$(stat -c %a /home/herdsman)
{ [ "$owner" = 0 ] || [ "$owner" = "$uid" ]; } && [ $((0$mode & 022)) -eq 0 ]
'@
  & docker compose run --rm --no-deps -T --user '0:0' --entrypoint sh herdsman -c $preflightScript sh $uid $gid
  if ($LASTEXITCODE -ne 0) { Fail 'home ownership, permissions, or configured PUID/PGID conflict with the image; refusing startup.' }

  $keys = [Collections.Generic.List[string]]::new()
  # Compose has already applied interpolation, env files and precedence.
  $effectiveKeys = [string]$model.services.herdsman.environment.SSH_AUTHORIZED_KEYS
  if ($effectiveKeys) {
    foreach ($line in ($effectiveKeys -split "`r?`n")) { if ($line.Trim()) { $keys.Add($line.Trim()) } }
  }
  if (-not [Console]::IsInputRedirected) {
    foreach ($candidate in @((Join-Path $HOME '.ssh/id_ed25519.pub'), (Join-Path $HOME '.ssh/id_rsa.pub'))) {
      if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Read-Host "Authorize public key $candidate to connect to Herdsman? [y/N]") -match '^(?i:y|yes)$') {
        foreach ($line in (Get-Content -LiteralPath $candidate)) { if ($line.Trim()) { $keys.Add($line.Trim()) } }
      }
    }
    while ($true) {
      $inputKey = Read-Host 'Additional public key or path to .pub file (Enter to finish)'
      if (-not $inputKey) { break }
      if (Test-Path -LiteralPath $inputKey -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $inputKey)) { if ($line.Trim()) { $keys.Add($line.Trim()) } }
      } else { $keys.Add($inputKey.Trim()) }
    }
  }
  foreach ($key in $keys) {
    if (-not (Test-OpenSshPublicKey $key)) { Fail 'SSH_AUTHORIZED_KEYS or selected key is not a structurally valid OpenSSH public key.' }
  }
  $authorizationScript = @'
set -eu
umask 077
home=/home/herdsman
sshdir="$home/.ssh"
auth="$sshdir/authorized_keys"
# Complete effective validation before touching any persistent authorization.
keys=$(mktemp)
trap 'rm -f "$keys"' EXIT HUP INT TERM
while IFS= read -r key; do
  [ -n "$key" ] || continue
  fingerprint=$(printf '%s\n' "$key" | ssh-keygen -lf - | awk 'NR == 1 {print $2}')
  [ -n "$fingerprint" ] || exit 1
  printf '%s\n' "$key" >> "$keys"
done
[ -w "$home" ] || exit 1
[ ! -L "$sshdir" ] && { [ ! -e "$sshdir" ] || [ -d "$sshdir" ]; } || exit 1
mkdir -p "$sshdir"
[ ! -L "$auth" ] && { [ ! -e "$auth" ] || [ -f "$auth" ]; } || exit 1
touch "$auth"
chmod 700 "$sshdir"
chmod 600 "$auth"
while IFS= read -r key; do
  fingerprint=$(printf '%s\n' "$key" | ssh-keygen -lf - | awk 'NR == 1 {print $2}')
  if ! ssh-keygen -lf "$auth" 2>/dev/null | awk -v f="$fingerprint" '$2 == f {found=1} END {exit !found}'; then
    [ ! -s "$auth" ] || [ "$(tail -c 1 "$auth" | wc -l)" -ne 0 ] || printf '\n' >> "$auth"
    printf '%s\n' "$key" >> "$auth"
  fi
done < "$keys"
ssh-keygen -lf "$auth" >/dev/null 2>&1
'@
  # Public keys are passed on stdin, never on the command line.
  @($keys | ForEach-Object { ($_ -split '\s+', 3)[0..1] -join ' ' }) | & docker compose run --rm --no-deps -T --user "${uid}:${gid}" --entrypoint sh herdsman -c $authorizationScript
  if ($LASTEXITCODE -ne 0) { Fail 'could not safely update authorized_keys, or no authorized keys exist.' }
  Invoke-Docker @('compose', 'up', '-d')
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker compose exec -T herdsman sh -c 'test -d /run/sshd && grep -q ":0016 " /proc/net/tcp /proc/net/tcp6' *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { Fail 'Herdsman did not become ready; inspect with: docker compose logs herdsman' }
  Write-Output "Herdsman is ready in $script:ProjectDir"
  Write-Output "Compose project: $projectName; home storage: $($mount.type); UID/GID: ${uid}:${gid}"
  Write-Output 'SSH authorization checked against the persistent home.'
  Write-Output 'Container outgoing SSH public key: docker compose exec herdsman cat /home/herdsman/.ssh/id_ed25519.pub'
  $publishedPort = & docker compose port herdsman 22
  if ($LASTEXITCODE -ne 0 -or ($publishedPort | Out-String).Trim() -notmatch ':(\d+)$') { Fail 'could not determine the published Herdsman SSH port.' }
  $sshPort = $Matches[1]
  Write-Output "Connect with: ssh -p $sshPort herdsman@localhost"
  Write-Output 'Container SSH host key: docker compose exec herdsman cat /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub'
} finally {
  Pop-Location
}
