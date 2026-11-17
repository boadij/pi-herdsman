param([switch] $Isolated)
$ErrorActionPreference = 'Stop'
if (-not $Isolated) {
  $homeDir = Join-Path ([IO.Path]::GetTempPath()) ("docker setup home-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $homeDir | Out-Null
  $oldHome = $env:HOME
  $oldProfile = $env:USERPROFILE
  try {
    $env:HOME = $homeDir
    $env:USERPROFILE = $homeDir
    & (Get-Process -Id $PID).Path -NoProfile -File $PSCommandPath -Isolated
    if ($LASTEXITCODE -ne 0) { throw "Isolated PowerShell tests failed (exit $LASTEXITCODE)." }
  } finally {
    $env:HOME = $oldHome
    $env:USERPROFILE = $oldProfile
    Remove-Item -LiteralPath $homeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  return
}
Set-Variable HOME -Value $env:USERPROFILE -Force
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("docker-setup-test-" + [guid]::NewGuid().ToString('N'))
$project = Join-Path $work 'project'
New-Item -ItemType Directory -Force -Path $project | Out-Null
$env:PI_HERDSMAN_DIR = $project
$wire = [Collections.Generic.List[byte]]::new()
$typeBytes = [Text.Encoding]::ASCII.GetBytes('ssh-ed25519')
$wire.AddRange([byte[]]@(0, 0, 0, $typeBytes.Length))
$wire.AddRange($typeBytes)
$wire.AddRange([byte[]]@(0, 0, 0, 32))
$wire.AddRange([byte[]]@(1..32))
$testKey = 'ssh-ed25519 ' + [Convert]::ToBase64String($wire.ToArray()) + ' synthetic-test-key'
$env:SSH_AUTHORIZED_KEYS = $testKey
$env:COMPOSE_FILE = ''
$script:dockerCalls = [Collections.Generic.List[string]]::new()
$script:hasPersistentAuthorizedKeys = $true
$script:dockerOSType = 'linux'
$script:sshPort = 2200
$script:modelUid = ''
$script:modelGid = ''
$script:preflightOk = $true
$script:composeKey = $null
$script:networkMode = ''
$script:sidecarImage = ''
$script:containerInfo = $null
$script:homeType = 'volume'
$script:homeSource = 'home'
$script:bindOwner = '2000:2000'
$script:writable = $true
$script:deriveModel = $false
$script:ignoreDerived = $false
$script:changeDerivedProject = $false
$script:changeDerivedMount = $false
$script:postWriteFailure = ''
$script:concurrentBeforeWrite = $false
$script:writeBlocked = $false
$script:lockedReadObserved = $false
$script:candidateResolved = $false
function docker {
  $call = $args -join ' '
  $script:dockerCalls.Add($call)
  if ($call -eq 'compose config --format json' -or $call -like 'compose --env-file * config --format json') {
    $global:LASTEXITCODE = 0
    if ($args[1] -eq '--env-file') { $script:candidateResolved = $true }
    if ($script:postWriteFailure -eq 'read-error' -and $call -eq 'compose config --format json' -and $script:candidateResolved) {
      $global:LASTEXITCODE = 1
      return
    }
    $resolvedUid = $script:modelUid
    $resolvedGid = $script:modelGid
    if ($script:deriveModel -and -not $script:ignoreDerived) {
      $configEnv = if ($args[1] -eq '--env-file') { $args[2] } else { Join-Path $project '.env' }
      if (Test-Path -LiteralPath $configEnv) {
        $reader = [IO.StreamReader]::new([IO.File]::Open($configEnv, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite))
        try {
          while ($null -ne ($line = $reader.ReadLine())) {
            if ($line -match '^PUID=(\d+)$') { $resolvedUid = $Matches[1] }
            if ($line -match '^PGID=(\d+)$') { $resolvedGid = $Matches[1] }
          }
        } finally { $reader.Dispose() }
      }
    }
    if ($script:concurrentBeforeWrite -and $args[1] -eq '--env-file') {
      [IO.File]::AppendAllText((Join-Path $project '.env'), "CONCURRENT=value`n")
    }
    if ($script:deriveModel -and $call -eq 'compose config --format json' -and $resolvedUid -eq '2000') {
      $script:lockedReadObserved = $true
      try {
        $writer = [IO.File]::Open((Join-Path $project '.env'), [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $writer.Dispose()
      } catch { $script:writeBlocked = $true }
      if ($script:postWriteFailure -eq 'error') { $global:LASTEXITCODE = 1; return }
    }
    $effectiveKey = if ($null -ne $script:composeKey) { $script:composeKey } else { $env:SSH_AUTHORIZED_KEYS }
    $resolvedSource = if ($script:changeDerivedMount -and $args[1] -eq '--env-file') { $script:homeSource + '-other' } else { $script:homeSource }
    $services = @{ herdsman = @{ network_mode = $script:networkMode; environment = @{ PUID = $resolvedUid; PGID = $resolvedGid; SSH_AUTHORIZED_KEYS = $effectiveKey }; volumes = @(@{ type = $script:homeType; source = $resolvedSource; target = '/home/herdsman' }) } }
    if ($script:sidecarImage) { $services['vpn'] = @{ image = $script:sidecarImage } }
    $name = if (($script:changeDerivedProject -and $args[1] -eq '--env-file') -or ($script:postWriteFailure -eq 'mismatch' -and $call -eq 'compose config --format json' -and $resolvedUid -eq '2000')) { 'changed-project' } else { 'test-project' }
    return (@{ name = $name; services = $services; volumes = @{ home = @{ name = 'test-project_home' } } } | ConvertTo-Json -Depth 8 -Compress)
  }
  if ($call -like 'ps -aq --filter *') { $global:LASTEXITCODE = 0; if ($script:containerInfo) { return 'container-id' }; return }
  if ($call -eq 'inspect container-id') { $global:LASTEXITCODE = 0; return (ConvertTo-Json -InputObject @($script:containerInfo) -Depth 8 -Compress) }
  if ($call -like 'compose run --rm --no-deps -T --user 0:0 *stat -c*') { $global:LASTEXITCODE = 0; return $script:bindOwner }
  if ($call -like 'compose run --rm --no-deps -T --user *test -w /home/herdsman') { $global:LASTEXITCODE = if ($script:writable) { 0 } else { 1 }; return }
  if ($call -like 'compose run --rm --no-deps -T --user 0:0 *') { $global:LASTEXITCODE = if ($script:preflightOk) { 0 } else { 1 }; return }
  if ($call -like 'compose run --rm --no-deps -T --user *') {
    $script:capturedKeys = @($input)
    $global:LASTEXITCODE = if ($script:hasPersistentAuthorizedKeys -or $script:capturedKeys.Count -gt 0) { 0 } else { 1 }
    return
  }
  if ($call -eq 'compose up -d') { $script:startedWithKey = $env:SSH_AUTHORIZED_KEYS }
  if ($call -eq 'compose port herdsman 22') {
    $global:LASTEXITCODE = 0
    $configuredPort = Select-String -Path (Join-Path $project '.env') -Pattern '^HERDSMAN_SSH_PORT=(\d+)$' | Select-Object -First 1
    if ($configuredPort) { return "0.0.0.0:$($configuredPort.Matches[0].Groups[1].Value)" }
    return "0.0.0.0:$($script:sshPort)"
  }
  if ($call -eq 'info --format {{.OSType}}') {
    $global:LASTEXITCODE = 0
    return $script:dockerOSType
  }
  if ($call -like 'compose run --rm --no-deps --entrypoint sh herdsman -c *authorized_keys*') {
    $global:LASTEXITCODE = if ($script:hasPersistentAuthorizedKeys) { 0 } else { 1 }
    return
  }
  $global:LASTEXITCODE = 0
}
function Invoke-WebRequest {
  param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)
  Assert $UseBasicParsing 'Compose download omitted -UseBasicParsing.'
  [IO.File]::WriteAllText($OutFile, 'services: {}')
}
function Read-Host { param([string] $Prompt); return '' }
function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
try {
  $script:dockerOSType = 'windows'
  $windowsEngineRejected = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $windowsEngineRejected = $_.Exception.Message -match 'must use a reachable Linux-container engine' }
  Assert $windowsEngineRejected 'Windows-container engine was not clearly rejected.'
  Assert (($script:dockerCalls -contains 'info --format {{.OSType}}')) 'Docker OSType was not queried natively.'
  Assert (-not ($script:dockerCalls -contains 'compose config --format json')) 'Compose setup continued on a Windows-container engine.'
  Assert (-not ($script:dockerCalls -contains 'compose up -d')) 'Deployment started on a Windows-container engine.'
  $script:dockerOSType = 'linux'
  foreach ($override in @('compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml')) {
    $path = Join-Path $project $override
    [IO.File]::WriteAllText($path, 'services: {}')
    $script:dockerCalls.Clear()
    $failed = $false
    try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'override exists without a base' }
    Assert $failed "Orphaned $override was not rejected."
    Assert (-not (Test-Path (Join-Path $project 'compose.yaml'))) 'Orphaned override triggered a Compose download.'
    Assert (-not @($script:dockerCalls | Where-Object { $_ -like 'compose config *' -or $_ -like 'ps *' -or $_ -like 'compose run *' -or $_ -eq 'compose up -d' }).Count) 'Orphaned override reached deployment operations.'
    Remove-Item -LiteralPath $path
  }
  $script:dockerCalls.Clear()
  [IO.File]::WriteAllText((Join-Path $project '.env'), "CUSTOM=value`nHERDSMAN_SSH_PORT=2200`n")
  $setupOutput = @(. (Join-Path $root 'scripts/docker-setup.ps1'))
  Assert (($setupOutput -join "`n") -match 'ssh -p 2200 herdsman@localhost') 'Connection command ignored the customized published SSH port.'
  $envFile = Get-Content -Raw (Join-Path $project '.env')
  Assert ($envFile.Contains('CUSTOM=value')) 'Existing .env setting was lost.'
  Assert ($envFile.Contains('HERDSMAN_SSH_PORT=2200')) 'Custom SSH port setting was lost.'
  Assert (-not $envFile.Contains('COMPOSE_FILE=')) 'Default Compose selection was unnecessarily saved.'
  Assert ((Test-Path (Join-Path $project 'compose.yaml'))) 'Missing Compose file was not downloaded.'
  Assert (($script:dockerCalls -contains 'compose config --format json')) 'Compose validation was not called.'
  Assert (($script:dockerCalls -contains 'compose up -d')) 'Compose startup was not called.'
  Assert (($script:dockerCalls -contains 'compose port herdsman 22')) 'Published SSH port was not queried from Compose.'
  Assert (-not (Get-ChildItem $project -Filter '*.tmp.*' -ErrorAction SilentlyContinue)) 'Temporary download remains.'
  Remove-Item Env:PI_HERDSMAN_DIR
  Push-Location $project
  try {
    $cwdOutput = @(. (Join-Path $root 'scripts/docker-setup.ps1'))
    Assert (($cwdOutput -join "`n").Contains("Herdsman is ready in $project")) 'Setup did not use the current directory.'
  } finally {
    Pop-Location
    $env:PI_HERDSMAN_DIR = $project
  }
  foreach ($scenario in @('sidecar', 'shared-network')) {
    if ($scenario -eq 'sidecar') { $script:sidecarImage = 'tailscale/tailscale:stable' } else { $script:networkMode = 'service:vpn' }
    $script:dockerCalls.Clear()
    $failed = $false
    try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'does not support Tailscale' }
    Assert $failed "Resolved $scenario was not rejected."
    Assert (-not @($script:dockerCalls | Where-Object { $_ -like 'ps *' -or $_ -like 'compose run *' -or $_ -eq 'compose up -d' }).Count) 'Unsupported network reached container operations.'
    $script:sidecarImage = ''
    $script:networkMode = ''
  }
  $script:containerInfo = @{ Config = @{ Labels = @{ 'com.docker.compose.project.working_dir' = $project; 'com.docker.compose.service' = 'herdsman' } }; Mounts = @(@{ Destination = '/home/herdsman'; Type = 'volume'; Name = 'test-project_Home' }) }
  $script:dockerCalls.Clear()
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'refusing storage migration' }
  Assert $failed 'Case-different volume was not rejected.'
  Assert (-not @($script:dockerCalls | Where-Object { $_ -like 'compose run *' -or $_ -eq 'compose up -d' }).Count) 'Conflicting volume reached a container operation.'
  $script:containerInfo = $null
  foreach ($field in @('modelUid', 'modelGid')) {
    Set-Variable -Scope Script -Name $field -Value '01000'
    $script:dockerCalls.Clear()
    $failed = $false
    try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'positive decimal' }
    Assert $failed "Noncanonical $field was not rejected."
    Assert (-not @($script:dockerCalls | Where-Object { $_ -like 'compose run *' }).Count) 'Invalid ID reached a one-off container.'
    Assert (-not ($script:dockerCalls -contains 'compose up -d')) 'Invalid ID reached startup.'
    Set-Variable -Scope Script -Name $field -Value ''
  }
  # Explicit nonstandard IDs must pass through unchanged for an existing home.
  $script:homeType = 'bind'
  $script:homeSource = Join-Path $project 'existing-home'
  New-Item -ItemType Directory -Path $script:homeSource | Out-Null
  $script:modelUid = '2000'
  $script:modelGid = '2000'
  $script:dockerCalls.Clear()
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert (@($script:dockerCalls | Where-Object { $_ -like 'compose run --rm --no-deps -T --user 2000:2000 *authorized_keys*' }).Count -eq 1) 'Configured nonstandard IDs were not used for authorization.'
  Assert (-not @($script:dockerCalls | Where-Object { $_ -match '\bchown\b' }).Count) 'Existing bind home ownership was changed.'
  $script:modelUid = ''
  $script:modelGid = ''
  $script:deriveModel = $true
  $originalEnv = [IO.File]::ReadAllText((Join-Path $project '.env'))
  $originalEnvBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $project '.env')))
  foreach ($failure in @('unwritable', 'ignored', 'project', 'mount')) {
    $script:writable = $failure -ne 'unwritable'
    $script:ignoreDerived = $failure -eq 'ignored'
    $script:changeDerivedProject = $failure -eq 'project'
    $script:changeDerivedMount = $failure -eq 'mount'
    $script:dockerCalls.Clear()
    $failed = $false
    try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $true }
    Assert $failed "Derived-ID $failure case was accepted."
    Assert ([IO.File]::ReadAllText((Join-Path $project '.env')) -ceq $originalEnv) "Derived-ID $failure changed .env."
    Assert (-not @($script:dockerCalls | Where-Object { $_ -like '*authorized_keys*' -or $_ -eq 'compose up -d' }).Count) "Derived-ID $failure reached authorization or startup."
  }
  $script:writable = $true
  $script:ignoreDerived = $false
  $script:changeDerivedProject = $false
  $script:changeDerivedMount = $false
  foreach ($postFailure in @('error', 'mismatch', 'read-error')) {
    $script:postWriteFailure = $postFailure
    $script:candidateResolved = $false
    $script:writeBlocked = $false
    $script:dockerCalls.Clear()
    $failed = $false
    try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $true }
    Assert $failed "Post-write $postFailure was accepted."
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $project '.env'))) -ceq $originalEnvBytes) "Post-write $postFailure did not restore .env bytes."
    if ($postFailure -ne 'read-error') { Assert $script:writeBlocked "Post-write $postFailure allowed a concurrent writer." }
    Assert (-not @($script:dockerCalls | Where-Object { $_ -like '*authorized_keys*' -or $_ -eq 'compose up -d' }).Count) "Post-write $postFailure reached authorization or startup."
  }
  $script:postWriteFailure = ''
  Remove-Item -LiteralPath (Join-Path $project '.env')
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'create an empty .env' }
  Assert $failed 'Missing .env did not fail safely before persistence.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $project '.env'))) 'Failed persistence created .env.'
  [IO.File]::WriteAllText((Join-Path $project '.env'), $originalEnv)
  $script:concurrentBeforeWrite = $true
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match '.env changed' }
  Assert $failed 'Concurrent .env edit was not rejected.'
  Assert ([IO.File]::ReadAllText((Join-Path $project '.env')) -ceq ($originalEnv + "CONCURRENT=value`n")) 'Concurrent .env edit was overwritten.'
  [IO.File]::WriteAllText((Join-Path $project '.env'), $originalEnv)
  $script:concurrentBeforeWrite = $false
  $script:writeBlocked = $false
  $script:lockedReadObserved = $false
  $script:dockerCalls.Clear()
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert ($script:lockedReadObserved -and $script:writeBlocked) 'Post-write verification did not read while blocking a concurrent writer.'
  $saved = [IO.File]::ReadAllText((Join-Path $project '.env'))
  Assert ($saved -match '(?m)^PUID=2000$' -and $saved -match '(?m)^PGID=2000$') 'Derived IDs were not persisted.'
  Assert (@($script:dockerCalls | Where-Object { $_ -like 'compose --env-file * config --format json' }).Count -eq 1) 'Derived model was not validated before persistence.'
  Assert (@($script:dockerCalls | Where-Object { $_ -like '*2000:2000*test -w /home/herdsman' }).Count -eq 1) 'Derived-user writability was not checked.'
  Assert (-not @($script:dockerCalls | Where-Object { $_ -match '\bchown\b' }).Count) 'Derivation changed existing ownership.'
  [IO.File]::WriteAllText((Join-Path $project '.env'), $originalEnv)
  $script:deriveModel = $false
  $script:homeType = 'volume'
  $script:homeSource = 'home'
  $script:preflightOk = $false
  $script:dockerCalls.Clear()
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'ownership, permissions, or configured' }
  Assert $failed 'Incompatible home or ID was not rejected.'
  Assert (-not ($script:dockerCalls -contains 'compose up -d')) 'Failed home preflight reached startup.'
  $script:preflightOk = $true
  # A key resolved from the Compose service environment is authoritative,
  # even when it was supplied by .env rather than the PowerShell process.
  Remove-Item Env:SSH_AUTHORIZED_KEYS
  $script:composeKey = $testKey
  $script:hasPersistentAuthorizedKeys = $false
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert ($script:capturedKeys.Count -eq 1 -and $script:capturedKeys[0] -ceq (($testKey -split '\s+', 3)[0..1] -join ' ')) 'Effective Compose key did not reach authorization stdin.'
  $script:composeKey = $null
  $script:hasPersistentAuthorizedKeys = $true
  $env:SSH_AUTHORIZED_KEYS = $testKey
  # Persistent authorized_keys allow a repeat without a host-side key.
  Remove-Item Env:SSH_AUTHORIZED_KEYS
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert (($script:dockerCalls -contains 'compose up -d')) 'Repeat setup did not start deployment.'
  $script:hasPersistentAuthorizedKeys = $false
  $startupCount = @($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'no authorized keys' }
  Assert $failed 'Setup without authorized keys did not fail.'
  Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq $startupCount) 'Setup without authorized keys reached startup.'
  Assert (-not (Test-Path (Join-Path $HOME '.ssh/id_ed25519'))) 'Installer generated a host private key.'
  $script:hasPersistentAuthorizedKeys = $true
  $env:SSH_AUTHORIZED_KEYS = 'ssh-ed25519 AQID malformed'
  $malformedRejected = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $malformedRejected = $_.Exception.Message -match 'structurally valid OpenSSH public key' }
  Assert $malformedRejected 'Malformed OpenSSH public key was accepted.'
  Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq $startupCount) 'Malformed SSH key reached startup.'
  # Structurally encoded, but all-zero P-256 coordinates are not a valid
  # curve point. Acceptance here tests only wire structure, not key usability.
  $ecdsaType = [Text.Encoding]::ASCII.GetBytes('ecdsa-sha2-nistp256')
  $ecdsaCurve = [Text.Encoding]::ASCII.GetBytes('nistp256')
  $ecdsaPoint = [byte[]]::new(65)
  $ecdsaPoint[0] = 4
  $ecdsaWire = [Collections.Generic.List[byte]]::new()
  foreach ($component in @($ecdsaType, $ecdsaCurve, $ecdsaPoint)) {
    $length = $component.Length
    $ecdsaWire.AddRange([byte[]]@([byte](($length -shr 24) -band 255), [byte](($length -shr 16) -band 255), [byte](($length -shr 8) -band 255), [byte]($length -band 255)))
    $ecdsaWire.AddRange($component)
  }
  $env:SSH_AUTHORIZED_KEYS = 'ecdsa-sha2-nistp256 ' + [Convert]::ToBase64String($ecdsaWire.ToArray()) + ' structurally-invalid-point'
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert (($script:dockerCalls -contains 'compose up -d')) 'Structurally valid ECDSA wire fixture was rejected; this assertion does not claim key usability.'
  $env:SSH_AUTHORIZED_KEYS = $testKey
  function New-RsaPublicKey([byte[]] $Exponent, [byte[]] $Modulus) {
    $data = [Collections.Generic.List[byte]]::new()
    $rsaType = [Text.Encoding]::ASCII.GetBytes('ssh-rsa')
    $data.AddRange([byte[]]@(0, 0, 0, $rsaType.Length))
    $data.AddRange($rsaType)
    $integers = [Collections.Generic.List[byte[]]]::new()
    $integers.Add($Exponent)
    $integers.Add($Modulus)
    foreach ($integer in $integers) {
      $length = $integer.Length
      $data.AddRange([byte[]]@([byte](($length -shr 24) -band 255), [byte](($length -shr 16) -band 255), [byte](($length -shr 8) -band 255), [byte]($length -band 255)))
      $data.AddRange($integer)
    }
    return 'ssh-rsa ' + [Convert]::ToBase64String($data.ToArray()) + ' malformed-rsa'
  }
  $invalidRsaKeys = @(
    (New-RsaPublicKey ([byte[]]@(0x80)) ([byte[]]@(1))),
    (New-RsaPublicKey ([byte[]]@(0, 0x7f)) ([byte[]]@(1))),
    (New-RsaPublicKey ([byte[]]@(0, 0x80)) ([byte[]]@(0x80))),
    (New-RsaPublicKey ([byte[]]@(1)) ([byte[]]@(0)))
  )
  foreach ($invalidRsaKey in $invalidRsaKeys) {
    $env:SSH_AUTHORIZED_KEYS = $invalidRsaKey
    $rsaStartupCount = @($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count
    $rsaRejected = $false
    try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $rsaRejected = $_.Exception.Message -match 'structurally valid OpenSSH public key' }
    Assert $rsaRejected 'Malformed RSA mpint was accepted.'
    Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq $rsaStartupCount) 'Malformed RSA key reached startup.'
  }
  $env:SSH_AUTHORIZED_KEYS = New-RsaPublicKey ([byte[]]@(0, 0x80)) ([byte[]]@(0x7f))
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert (($script:dockerCalls -contains 'compose up -d')) 'Canonical positive RSA mpint was rejected.'
  $env:SSH_AUTHORIZED_KEYS = $testKey
  [IO.File]::WriteAllText((Join-Path $project '.env'), "export TS_AUTHKEY=secret-value$([Environment]::NewLine)COMPOSE_FILE=compose.yaml$([Environment]::NewLine)")
  $rejected = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $rejected = $_.Exception.Message -match 'remove TS_AUTHKEY' }
  Assert $rejected 'Exported TS_AUTHKEY in .env was not rejected.'
  $secretEnv = "export TS_AUTHKEY=secret-value$([Environment]::NewLine)CUSTOM=untouched$([Environment]::NewLine)"
  [IO.File]::WriteAllText((Join-Path $project '.env'), $secretEnv)
  Assert ((Get-Content -Raw (Join-Path $project '.env')) -ceq $secretEnv) 'Rejected TS_AUTHKEY unexpectedly modified .env.'

  $exportedComposeEnv = "export COMPOSE_FILE=compose.yaml$([Environment]::NewLine)CUSTOM=kept$([Environment]::NewLine)"
  [IO.File]::WriteAllText((Join-Path $project '.env'), $exportedComposeEnv)
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert ((Get-Content -Raw (Join-Path $project '.env')) -ceq $exportedComposeEnv) 'Exported COMPOSE_FILE was not reused without modifying .env.'

  [IO.File]::WriteAllText((Join-Path $project 'custom.yaml'), 'custom compose')
  foreach ($quotedSelection in @('"compose.yaml;custom.yaml" # trailing comment', "'compose.yaml;custom.yaml' # trailing comment")) {
    $quotedComposeEnv = "COMPOSE_FILE=$quotedSelection`nCUSTOM=kept`n"
    [IO.File]::WriteAllText((Join-Path $project '.env'), $quotedComposeEnv)
    $script:dockerCalls.Clear()
    . (Join-Path $root 'scripts/docker-setup.ps1')
    Assert (($script:dockerCalls -contains 'compose config --format json')) 'Quoted COMPOSE_FILE with inline comment was not parsed for Compose validation.'
    Assert ((Get-Content -Raw (Join-Path $project '.env')) -ceq $quotedComposeEnv) 'Quoted COMPOSE_FILE parsing modified .env bytes.'
  }
  # Exercise the exact embedded POSIX preflight when a shell is available.
  $shell = Get-Command sh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($shell) {
    $source = Get-Content -Raw (Join-Path $root 'scripts/docker-setup.ps1')
    $match = [regex]::Match($source, '(?s)\$preflightScript = @''\r?\n(.*?)\r?\n''@')
    Assert $match.Success 'Could not extract embedded preflight.'
    $mocks = @'
id() { case "$1" in -u) echo 1000;; -g) echo 1000;; esac; }
getent() { [ "$2" = 2000 ]; }
stat() { case "$2" in %u) echo 0;; %a) echo 755;; esac; }
'@
    foreach ($case in @(@('2000', '1000', 1), @('1000', '2000', 1), @('1000', '1000', 0), @('3000', '3000', 0))) {
      ($mocks + "`n" + $match.Groups[1].Value) | & $shell.Source -s -- $case[0] $case[1]
      Assert ($LASTEXITCODE -eq $case[2]) "Unexpected preflight status for UID $($case[0]), GID $($case[1])."
    }
  } else {
    Write-Output 'Embedded POSIX preflight checks skipped: sh not found.'
  }
  Write-Output 'PowerShell Docker setup mocked checks passed.'

} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:PI_HERDSMAN_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:SSH_AUTHORIZED_KEYS -ErrorAction SilentlyContinue
}
