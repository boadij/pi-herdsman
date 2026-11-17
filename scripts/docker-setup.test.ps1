$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ('docker-setup-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$oldDir = $env:PI_HERDSMAN_DIR
$oldCompose = $env:COMPOSE_FILE
$oldAuth = $env:TS_AUTHKEY
$oldKeys = $env:SSH_AUTHORIZED_KEYS
$env:SSH_AUTHORIZED_KEYS = ''
$env:PI_HERDSMAN_DIR = $work
$env:COMPOSE_FILE = ''
$env:TS_AUTHKEY = ''
# The installer runs in a child script scope; both scripts share this mock state.
$global:dockerSetupTestState = @{
  calls = [Collections.Generic.List[string]]::new()
  containers = @('container-1')
  running = @('container-1')
  workingDir = $work
  port = '0.0.0.0:2200'
  startRunsHerdsman = $true
  authorization = $null
}
function docker {
  $call = $args -join ' '
  $global:dockerSetupTestState.calls.Add($call)
  if ($args[0] -eq 'compose' -and $args[1] -eq 'run') {
    $global:dockerSetupTestState.authorization = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[-1]))
  }
  $global:LASTEXITCODE = 0
  switch ($call) {
    'info --format {{.OSType}}' { return 'linux' }
    'compose config --services' { return 'herdsman' }
    'compose ps --all --quiet' { return $global:dockerSetupTestState.containers }
    'compose ps --quiet herdsman' { return $global:dockerSetupTestState.running }
    'compose start' { if ($global:dockerSetupTestState.startRunsHerdsman) { $global:dockerSetupTestState.running = @('container-1') }; return }
    'compose port herdsman 22' { return $global:dockerSetupTestState.port }
  }
  if ($args[0] -eq 'inspect') { return $global:dockerSetupTestState.workingDir }
}
function Read-Host { param([string] $Prompt); if ($Prompt -like 'Additional public key*') { return '' }; return 'yes' }
function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
try {
  $compose = Join-Path $work 'compose.yaml'
  $override = Join-Path $work 'compose.override.yaml'
  $dotenv = Join-Path $work '.env'
  [IO.File]::WriteAllText($compose, 'original compose')
  [IO.File]::WriteAllText($override, 'original override')
  [IO.File]::WriteAllText($dotenv, 'CUSTOM=value')
  & (Join-Path $PSScriptRoot 'docker-setup.ps1') | Out-Null
  Assert ($global:dockerSetupTestState.calls.Contains('compose config --quiet')) 'Compose was not validated.'
  Assert (-not $global:dockerSetupTestState.calls.Contains('compose up -d')) 'Running deployment was recreated.'
  Assert ([IO.File]::ReadAllText($compose) -ceq 'original compose') 'Compose was modified.'
  Assert ([IO.File]::ReadAllText($override) -ceq 'original override') 'Override was modified.'
  Assert ([IO.File]::ReadAllText($dotenv) -ceq 'CUSTOM=value') '.env was modified.'
  $global:dockerSetupTestState.calls.Clear()
  $global:dockerSetupTestState.workingDir = Join-Path $work 'another'
  $failed = $false
  try { & (Join-Path $PSScriptRoot 'docker-setup.ps1') | Out-Null } catch { $failed = $_.Exception.Message -match 'belong to' }
  Assert $failed 'Cross-directory collision was not rejected.'
  Assert (-not $global:dockerSetupTestState.calls.Contains('compose up -d')) 'Collision reached startup.'
  $global:dockerSetupTestState.workingDir = $work
  $global:dockerSetupTestState.running = @()
  $global:dockerSetupTestState.calls.Clear()
  & (Join-Path $PSScriptRoot 'docker-setup.ps1') | Out-Null
  Assert ($global:dockerSetupTestState.calls.Contains('compose start')) 'Stopped Herdsman was not started when a sidecar exists.'
  Assert (-not $global:dockerSetupTestState.calls.Contains('compose up -d')) 'Existing deployment was recreated.'
  $global:dockerSetupTestState.port = ''
  $output = & (Join-Path $PSScriptRoot 'docker-setup.ps1')
  Assert (($output -join "`n") -match 'Tailscale or custom networking') 'No-port networking was not reported.'
  $global:dockerSetupTestState.port = '0.0.0.0:2200'
  $global:dockerSetupTestState.containers = @()
  $global:dockerSetupTestState.running = @()
  $global:dockerSetupTestState.calls.Clear()
  & (Join-Path $PSScriptRoot 'docker-setup.ps1') | Out-Null
  Assert ($global:dockerSetupTestState.calls.Contains('compose up -d')) 'Confirmed existing configuration was not started.'
  $setupSource = Get-Content -Raw (Join-Path $PSScriptRoot 'docker-setup.ps1')
  Assert ($setupSource.Contains('compose exec -T --user herdsman herdsman env -u SSH_AUTHORIZED_KEYS sh -c')) 'Existing authorization does not clear the stale environment key.'
  # Exercise native argument serialization when a POSIX shell is available.
  $shell = Get-Command sh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($shell) {
    $program = 'printf ''%s\n'' "quoted value"; printf ''arg=%s\n'' "$1"'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($program))
    $result = & $shell.Source -c 'set -f; IFS=; s=$(echo $1|base64 -d); shift; eval $s' sh $encoded 'test'
    Assert ($LASTEXITCODE -eq 0 -and ($result -join ',') -ceq 'quoted value,arg=test') 'Native shell transport changed script bytes or arguments.'
    $keygen = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($keygen) {
      $keyPath = Join-Path $work 'test-key'
      & $keygen.Source -q -t ed25519 -N '' -f $keyPath
      if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen test fixture failed.' }
      $homePath = Join-Path $work 'container-home'
      New-Item -ItemType Directory -Path $homePath | Out-Null
      # Shell paths are only portable here when sh sees this host path directly.
      if ($homePath -notmatch '[\\ ]') {
        $program = $global:dockerSetupTestState.authorization.Replace('home=/home/herdsman', "home=$homePath")
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($program))
        $decoder = 'set -f; IFS=; s=$(echo $1|base64 -d); shift; eval $s'
        '' | & $shell.Source -c $decoder sh $encoded
        Assert ($LASTEXITCODE -ne 0) 'Missing authorization was accepted.'
        $key = Get-Content -Raw ($keyPath + '.pub')
        $key | & $shell.Source -c $decoder sh $encoded
        Assert ($LASTEXITCODE -eq 0) 'Public key authorization failed.'
        $key | & $shell.Source -c $decoder sh $encoded
        Assert ($LASTEXITCODE -eq 0 -and @(Get-Content (Join-Path $homePath '.ssh/authorized_keys')).Count -eq 1) 'Repeat key was duplicated.'
        $stalePath = Join-Path $work 'stale-key'
        & $keygen.Source -q -t ed25519 -N '' -f $stalePath
        if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen stale key fixture failed.' }
        $stale = Get-Content -Raw ($stalePath + '.pub')
        $env:SSH_AUTHORIZED_KEYS = $stale
        $newPath = Join-Path $work 'new-key'
        & $keygen.Source -q -t ed25519 -N '' -f $newPath
        if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen selected key fixture failed.' }
        $newKey = Get-Content -Raw ($newPath + '.pub')
        $envCommand = Get-Command env -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $newKey | & $envCommand.Source -u SSH_AUTHORIZED_KEYS $shell.Source -c $decoder sh $encoded
        Assert ($LASTEXITCODE -eq 0) 'Existing authorization failed.'
        $authorized = Get-Content -Raw (Join-Path $homePath '.ssh/authorized_keys')
        Assert ($authorized.Contains($key.Trim()) -and $authorized.Contains($newKey.Trim()) -and -not $authorized.Contains($stale.Trim())) 'Existing authorization restored a stale environment key or lost an existing key.'
        # Simulate a removed container retaining its home: the one-off path
        # receives the environment, but must only add the selected key.
        $newKey | & $shell.Source -c $decoder sh $encoded
        $authorized = Get-Content -Raw (Join-Path $homePath '.ssh/authorized_keys')
        Assert ($LASTEXITCODE -eq 0 -and -not $authorized.Contains($stale.Trim())) 'Removed-container authorization restored a revoked key.'
        '' | & $shell.Source -c $decoder sh $encoded
        $authorized = Get-Content -Raw (Join-Path $homePath '.ssh/authorized_keys')
        Assert ($LASTEXITCODE -eq 0 -and -not $authorized.Contains($stale.Trim())) 'Initialized home consumed the environment fallback.'
        $freshHome = Join-Path $work 'fresh-home'
        New-Item -ItemType Directory -Path $freshHome | Out-Null
        $freshProgram = $global:dockerSetupTestState.authorization.Replace('home=/home/herdsman', "home=$freshHome")
        $freshEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($freshProgram))
        $newKey | & $shell.Source -c $decoder sh $freshEncoded
        $authorized = Get-Content -Raw (Join-Path $freshHome '.ssh/authorized_keys')
        Assert ($LASTEXITCODE -eq 0 -and $authorized.Contains($newKey.Trim()) -and -not $authorized.Contains($stale.Trim())) 'Explicit key did not suppress fallback in empty home.'
        $fallbackHome = Join-Path $work 'fallback-home'
        New-Item -ItemType Directory -Path $fallbackHome | Out-Null
        $fallbackProgram = $global:dockerSetupTestState.authorization.Replace('home=/home/herdsman', "home=$fallbackHome")
        $fallbackEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fallbackProgram))
        @() | & $shell.Source -c $decoder sh $fallbackEncoded
        $authorized = Get-Content -Raw (Join-Path $fallbackHome '.ssh/authorized_keys')
        Assert ($LASTEXITCODE -eq 0 -and $authorized.Contains($stale.Trim())) 'Empty home ignored the environment fallback.'
        $blankHome = Join-Path $work 'blank-home'
        New-Item -ItemType Directory -Path $blankHome | Out-Null
        $blankProgram = $global:dockerSetupTestState.authorization.Replace('home=/home/herdsman', "home=$blankHome")
        $blankEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($blankProgram))
        @('', '  ', '') | & $shell.Source -c $decoder sh $blankEncoded
        $authorized = Get-Content -Raw (Join-Path $blankHome '.ssh/authorized_keys')
        Assert ($LASTEXITCODE -eq 0 -and $authorized.Contains($stale.Trim())) 'Blank-line input suppressed the environment fallback.'
        $mixedHome = Join-Path $work 'mixed-home'
        New-Item -ItemType Directory -Path $mixedHome | Out-Null
        $mixedProgram = $global:dockerSetupTestState.authorization.Replace('home=/home/herdsman', "home=$mixedHome")
        $mixedEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($mixedProgram))
        @('', $newKey, '') | & $shell.Source -c $decoder sh $mixedEncoded
        $authorized = Get-Content -Raw (Join-Path $mixedHome '.ssh/authorized_keys')
        Assert ($LASTEXITCODE -eq 0 -and $authorized.Contains($newKey.Trim()) -and -not $authorized.Contains($stale.Trim()) -and @(Get-Content (Join-Path $mixedHome '.ssh/authorized_keys')).Count -eq 1) 'Blank lines changed selected-key authorization.'

        $env:SSH_AUTHORIZED_KEYS = ''
      } else { Write-Output 'SSH authorization shell test skipped: shell path mapping unavailable.' }
    } else { Write-Output 'SSH authorization shell test skipped: ssh-keygen unavailable.' }
  } else { Write-Output 'Native shell transport test skipped: sh unavailable.' }
  Write-Output 'PowerShell Docker setup tests passed.'
} finally {
  $env:PI_HERDSMAN_DIR = $oldDir
  $env:COMPOSE_FILE = $oldCompose
  $env:TS_AUTHKEY = $oldAuth
  $env:SSH_AUTHORIZED_KEYS = $oldKeys
  Remove-Variable -Name dockerSetupTestState -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
