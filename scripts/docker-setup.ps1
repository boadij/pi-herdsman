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
  $existingCompose = $setting -or @( 'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml' | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0
  if (-not $existingCompose) {
    $orphanedOverrides = @('compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml' | Where-Object { Test-Path -LiteralPath $_ })
    if ($orphanedOverrides.Count -gt 0) { Fail "Compose override exists without a base configuration: $($orphanedOverrides -join ', '); restore the base or explicitly select a configuration." }
    $choice = Read-Host 'Deployment: [1] Standard Docker (default)'
    if ($choice -and $choice -ne '1') { Fail 'The Windows guided setup supports standard Docker only.' }
    Download-Compose 'compose.yaml'
  }

  & docker compose config --quiet
  if ($LASTEXITCODE -ne 0) { Fail 'could not resolve Compose configuration.' }
  $services = @(& docker compose config --services)
  if ($LASTEXITCODE -ne 0 -or 'herdsman' -notin $services) { Fail 'selected Compose configuration does not contain a herdsman service.' }
  $containers = @(& docker compose ps --all --quiet | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0) { Fail 'could not list existing Compose containers.' }
  foreach ($container in $containers) {
    $workingDir = (& docker inspect --format '{{index .Config.Labels `com.docker.compose.project.working_dir`}}' $container | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $workingDir -or -not [string]::Equals([IO.Path]::GetFullPath($workingDir).TrimEnd('\', '/'), $script:ProjectDir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
      Fail "Compose containers belong to '$workingDir', not '$script:ProjectDir'."
    }
  }
  $running = @(& docker compose ps --quiet herdsman | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0) { Fail 'could not list running Compose containers.' }
  if ($containers.Count -gt 0 -and $running.Count -eq 0) {
    if ((Read-Host 'Start the existing containers without recreating them? [y/N]') -notmatch '^(?i:y|yes)$') { return }
    Invoke-Docker @('compose', 'start')
    $running = @(& docker compose ps --quiet herdsman | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0 -or $running.Count -eq 0) { Fail 'Herdsman did not start; inspect existing containers and networking without recreating them.' }
  }
  if ($containers.Count -eq 0 -and $env:TS_AUTHKEY) { Fail 'remove TS_AUTHKEY from the environment; Windows setup does not bootstrap Tailscale.' }
  if ($containers.Count -eq 0 -and $existingCompose) {
    Write-Output 'Existing configuration found. Inspect custom bind mounts and create their homes safely before startup; Windows setup does not initialize them.'
    if ((Read-Host 'Start a new deployment with this configuration? [y/N]') -notmatch '^(?i:y|yes)$') { return }
  }

  $keys = [Collections.Generic.List[string]]::new()
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
[ -w "$home" ] || exit 1
[ ! -L "$sshdir" ] && { [ ! -e "$sshdir" ] || [ -d "$sshdir" ]; } || exit 1
[ ! -L "$auth" ] && { [ ! -e "$auth" ] || [ -f "$auth" ]; } || exit 1
while IFS= read -r key || [ -n "$key" ]; do
  case "$key" in *[![:space:]]*) ;; *) continue ;; esac
  printf '%s\n' "$key"
done > "$keys"
# A removed container does not imply an unused home. Never restore stale
# environment keys alongside a selection or into an initialized home.
if [ ! -s "$keys" ]; then
  entries=$(find "$home" -mindepth 1 -maxdepth 1 -print -quit) || exit 1
  if [ -z "$entries" ]; then printf '%s\n' "${SSH_AUTHORIZED_KEYS:-}" > "$keys"; fi
fi
while IFS= read -r key; do
  case "$key" in *[![:space:]]*) ;; *) continue ;; esac
  fingerprint=$(printf '%s\n' "$key" | ssh-keygen -lf - | awk 'NR == 1 {print $2}')
  [ -n "$fingerprint" ] || exit 1
done < "$keys"
mkdir -p "$sshdir"
[ ! -L "$auth" ] && { [ ! -e "$auth" ] || [ -f "$auth" ]; } || exit 1
touch "$auth"
chmod 700 "$sshdir"
chmod 600 "$auth"
while IFS= read -r key; do
  case "$key" in *[![:space:]]*) ;; *) continue ;; esac
  fingerprint=$(printf '%s\n' "$key" | ssh-keygen -lf - | awk 'NR == 1 {print $2}')
  if ! ssh-keygen -lf "$auth" 2>/dev/null | awk -v f="$fingerprint" '$2 == f {found=1} END {exit !found}'; then
    [ ! -s "$auth" ] || [ "$(tail -c 1 "$auth" | wc -l)" -ne 0 ] || printf '\n' >> "$auth"
    printf '%s\n' "$key" >> "$auth"
  fi
done < "$keys"
ssh-keygen -lf "$auth" >/dev/null 2>&1
'@
  # Base64 keeps shell programs free of native Windows argument quoting hazards.
  # Public keys remain on stdin, never on the command line.
  $encodedAuthorization = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($authorizationScript))
  $decodeScript = 'set -f; IFS=; s=$(echo $1|base64 -d); shift; eval $s'
  if ($containers.Count -gt 0 -and $keys.Count -eq 0) {
    # Leave a running deployment and its authorization untouched unless asked.
  } elseif ($containers.Count -gt 0) {
    @($keys | ForEach-Object { ($_ -split '\s+', 3)[0..1] -join ' ' }) | & docker compose exec -T --user herdsman herdsman env -u SSH_AUTHORIZED_KEYS sh -c $decodeScript sh $encodedAuthorization
    if ($LASTEXITCODE -ne 0) { Fail 'could not safely update authorized_keys.' }
  } else {
    # Resolve IDs inside the container from Compose's effective environment, never on the host.
    $switchUser = @'
set -eu
uid=${PUID:-1000}; gid=${PGID:-1000}
case "$uid:$gid" in *[!0-9:]*|0*:*|*:0*|:*|*:) exit 1;; esac
set -f; IFS=
s=$(echo $1 | base64 -d)
exec setpriv --reuid $uid --regid $gid --clear-groups sh -c $s
'@
    $encodedSwitch = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($switchUser))
    @($keys | ForEach-Object { ($_ -split '\s+', 3)[0..1] -join ' ' }) | & docker compose run --rm --no-deps -T --user '0:0' --entrypoint sh herdsman -c $decodeScript sh $encodedSwitch $encodedAuthorization
    if ($LASTEXITCODE -ne 0) { Fail 'could not safely update authorized_keys, or no authorized keys exist.' }
    Invoke-Docker @('compose', 'up', '-d')
  }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker compose exec -T herdsman sh -c 'test -d /run/sshd && grep -q :0016 /proc/net/tcp /proc/net/tcp6' *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { Fail 'Herdsman did not become ready; inspect with: docker compose logs herdsman' }
  Write-Output "Herdsman is ready in $script:ProjectDir"
  Write-Output 'SSH authorization checked against the persistent home.'
  Write-Output 'Container outgoing SSH public key: docker compose exec herdsman cat /home/herdsman/.ssh/id_ed25519.pub'
  $publishedPort = & docker compose port herdsman 22
  if ($LASTEXITCODE -eq 0 -and ($publishedPort | Out-String).Trim() -match ':(\d+)$') {
    Write-Output "Connect with: ssh -p $($Matches[1]) herdsman@localhost"
  } else {
    Write-Output 'No published SSH port found. For Tailscale or custom networking, use the configured network address and SSH port.'
  }
  Write-Output 'Container SSH host key: docker compose exec herdsman cat /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub'
} finally {
  Pop-Location
}
