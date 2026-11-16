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
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/boadij/pi-herdsman/main/$Name" -OutFile $temp
    if (-not (Test-Path -LiteralPath $temp) -or (Get-Item -LiteralPath $temp).Length -eq 0) { Fail "download of $Name was empty." }
    if (-not (Test-Path -LiteralPath $Name)) { Move-Item -LiteralPath $temp -Destination $Name }
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

$scriptPath = $PSCommandPath
if ($env:PI_HERDSMAN_DIR) {
  $script:ProjectDir = $env:PI_HERDSMAN_DIR
} elseif ($scriptPath -and (Test-Path -LiteralPath $scriptPath) -and
  (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $scriptPath) '..\compose.yaml'))) {
  $script:ProjectDir = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $scriptPath) '..'))
} else {
  $script:ProjectDir = Join-Path $HOME 'pi-herdsman'
}
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
  if ($setting) {
    $selection = $setting
  } else {
    $choice = Read-Host 'Deployment: [1] Standard Docker (default)'
    if ($choice -and $choice -ne '1') { Fail 'The Windows guided setup supports standard Docker only.' }
    $selection = 'compose.yaml'
  }

  $separator = if ($env:COMPOSE_PATH_SEPARATOR) { $env:COMPOSE_PATH_SEPARATOR } else { ';' }
  $files = $selection -split [regex]::Escape($separator)
  if ($files -contains 'compose.tailscale.yaml') {
    Fail 'Windows guided setup supports standard Docker only; configure Tailscale manually after Docker Desktop acceptance.'
  }
  foreach ($file in $files) {
    if (-not $file) { Fail 'COMPOSE_FILE contains an empty entry.' }
    Download-Compose $file
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Fail "required Compose file does not exist: $file" }
  }

  if (-not $setting) {
    $line = "COMPOSE_FILE=$selection"
    if (Test-Path -LiteralPath $envPath) {
      [IO.File]::AppendAllText($envPath, [Environment]::NewLine + $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    } else {
      [IO.File]::WriteAllText($envPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    }
  }
  $key = $env:SSH_AUTHORIZED_KEYS
  if (-not $key) {
    foreach ($candidate in @((Join-Path $HOME '.ssh/id_ed25519.pub'), (Join-Path $HOME '.ssh/id_rsa.pub'))) {
      if (Test-Path -LiteralPath $candidate) { $key = (Get-Content -Raw -LiteralPath $candidate).Trim(); break }
    }
  }
  Invoke-Docker @('compose', 'config', '--quiet')
  if (-not $key) {
    & docker compose run --rm --no-deps --entrypoint sh herdsman -c 'test -s /home/herdsman/.ssh/authorized_keys' *> $null
    $hasPersistentKeys = $LASTEXITCODE -eq 0
    if (-not $hasPersistentKeys) {
      $candidate = Read-Host 'SSH public-key file [~/.ssh/id_ed25519.pub]'
      if (-not $candidate) { $candidate = Join-Path $HOME '.ssh/id_ed25519.pub' }
      $candidate = [Environment]::ExpandEnvironmentVariables($candidate.Replace('~', $HOME))
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "SSH public-key file not found: $candidate" }
      $key = (Get-Content -Raw -LiteralPath $candidate).Trim()
    }
  }
  if ($key) {
    if (-not (Test-OpenSshPublicKey $key)) { Fail 'SSH_AUTHORIZED_KEYS is not a structurally valid OpenSSH public key.' }
    $env:SSH_AUTHORIZED_KEYS = $key
  }
  Invoke-Docker @('compose', 'up', '-d')
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker compose exec -T herdsman sh -c 'test -d /run/sshd && grep -q ":0016 " /proc/net/tcp /proc/net/tcp6' *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { Fail 'Herdsman did not become ready; inspect with: docker compose logs herdsman' }
  Write-Output "Herdsman is ready in $script:ProjectDir"
  Write-Output 'Connect with: ssh -p 2222 herdsman@localhost'
  Write-Output 'Container SSH host key: docker compose exec herdsman cat /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub'
} finally {
  Pop-Location
}
