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
$script:keygenCalls = 0
$script:keygenFailure = $false
$script:keygenRace = $false
function global:ssh-keygen {
  $script:keygenCalls++
  if ($script:keygenFailure) { $global:LASTEXITCODE = 1; return }
  $global:LASTEXITCODE = 0
  if ($args -contains '-y') { return $testKey }
  $path = $args[([array]::IndexOf($args, '-f') + 1)]
  [IO.File]::WriteAllText($path, 'private fixture')
  [IO.File]::WriteAllText("$path.pub", $testKey)
  if ($script:keygenRace) { [IO.File]::WriteAllText((Join-Path $HOME '.ssh/id_ed25519.pub'), 'concurrent public key') }
}
$script:dockerCalls = [Collections.Generic.List[string]]::new()
$script:hasPersistentAuthorizedKeys = $true
$script:dockerOSType = 'linux'
$script:sshPort = 2200
function docker {
  $call = $args -join ' '
  $script:dockerCalls.Add($call)
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
function Read-Host { param([string] $Prompt); if ($Prompt -notlike 'Deployment:*') { throw "Unexpected prompt: $Prompt" }; return '' }
function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
try {
  $script:dockerOSType = 'windows'
  $windowsEngineRejected = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $windowsEngineRejected = $_.Exception.Message -match 'must use a reachable Linux-container engine' }
  Assert $windowsEngineRejected 'Windows-container engine was not clearly rejected.'
  Assert (($script:dockerCalls -contains 'info --format {{.OSType}}')) 'Docker OSType was not queried natively.'
  Assert (-not ($script:dockerCalls -contains 'compose config --quiet')) 'Compose setup continued on a Windows-container engine.'
  Assert (-not ($script:dockerCalls -contains 'compose up -d')) 'Deployment started on a Windows-container engine.'
  $script:dockerOSType = 'linux'
  $script:dockerCalls.Clear()
  [IO.File]::WriteAllText((Join-Path $project '.env'), "CUSTOM=value`nHERDSMAN_SSH_PORT=2200`n")
  $setupOutput = @(. (Join-Path $root 'scripts/docker-setup.ps1'))
  Assert (($setupOutput -join "`n") -match 'ssh -p 2200 herdsman@localhost') 'Connection command ignored the customized published SSH port.'
  $envFile = Get-Content -Raw (Join-Path $project '.env')
  Assert ($envFile.Contains('CUSTOM=value')) 'Existing .env setting was lost.'
  Assert ($envFile.Contains('HERDSMAN_SSH_PORT=2200')) 'Custom SSH port setting was lost.'
  Assert ($envFile.Contains('COMPOSE_FILE=compose.yaml')) 'Default Compose selection was not saved.'
  Assert ((Test-Path (Join-Path $project 'compose.yaml'))) 'Missing Compose file was not downloaded.'
  Assert (($script:dockerCalls -contains 'compose config --quiet')) 'Compose validation was not called.'
  Assert (($script:dockerCalls -contains 'compose up -d')) 'Compose startup was not called.'
  Assert (($script:dockerCalls -contains 'compose port herdsman 22')) 'Published SSH port was not queried from Compose.'
  Assert (-not (Get-ChildItem $project -Filter '*.tmp.*' -ErrorAction SilentlyContinue)) 'Temporary download remains.'
  # Persistent authorized_keys allow a repeat without a host-side key.
  Remove-Item Env:SSH_AUTHORIZED_KEYS
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert (($script:dockerCalls -contains 'compose up -d')) 'Repeat setup did not start deployment.'
  $startupCount = @($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count
  $script:hasPersistentAuthorizedKeys = $false
  . (Join-Path $root 'scripts/docker-setup.ps1')
  $privatePath = Join-Path $HOME '.ssh/id_ed25519'
  $publicPath = "$privatePath.pub"
  Assert ($script:keygenCalls -eq 1) 'Fresh setup did not generate an identity.'
  Assert ($env:SSH_AUTHORIZED_KEYS -ceq (Get-Content -Raw -LiteralPath $publicPath).Trim()) 'Generated public key was not passed to Compose.'
  Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq ($startupCount + 1)) 'Fresh setup did not start.'
  Remove-Item Env:SSH_AUTHORIZED_KEYS
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert ($script:keygenCalls -eq 1) 'Repeat setup regenerated the identity.'
  Remove-Item Env:SSH_AUTHORIZED_KEYS
  Remove-Item -LiteralPath $publicPath
  . (Join-Path $root 'scripts/docker-setup.ps1')
  Assert ($script:keygenCalls -eq 2 -and $env:SSH_AUTHORIZED_KEYS -ceq (Get-Content -Raw -LiteralPath $publicPath).Trim()) 'Private-only identity was not recovered.'
  Remove-Item Env:SSH_AUTHORIZED_KEYS
  Remove-Item -LiteralPath $publicPath
  $script:keygenFailure = $true
  $startupCount = @($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'cannot recover SSH public key' }
  Assert ($failed -and (Get-Content -Raw -LiteralPath $privatePath) -ceq 'private fixture') 'Failed recovery did not preserve the private key.'
  Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq $startupCount) 'Failed recovery reached startup.'
  Remove-Item -LiteralPath $privatePath
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'cannot generate SSH identity' }
  Assert $failed 'Native key generation failure was not caught.'
  $script:keygenFailure = $false
  $script:keygenRace = $true
  $failed = $false
  try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'cannot publish SSH identity' }
  Assert ($failed -and (Get-Content -Raw -LiteralPath $publicPath) -ceq 'concurrent public key') 'Concurrent public key was overwritten.'
  Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq $startupCount) 'Failed generation reached startup.'
  Remove-Item -LiteralPath $privatePath, $publicPath
  $script:keygenRace = $false
  $script:hasPersistentAuthorizedKeys = $true
  $startupCount = @($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count
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
    Assert (($script:dockerCalls -contains 'compose config --quiet')) 'Quoted COMPOSE_FILE with inline comment was not parsed for Compose validation.'
    Assert ((Get-Content -Raw (Join-Path $project '.env')) -ceq $quotedComposeEnv) 'Quoted COMPOSE_FILE parsing modified .env bytes.'
  }
  Write-Output 'PowerShell Docker setup mocked checks passed.'

  # Exercise native argument serialization as well as the filesystem, in the
  # isolated home. PowerShell 7 supports testing all native argument modes.
  Remove-Item Function:global:ssh-keygen
  $nativeKeygen = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nativeKeygen) {
    $env:COMPOSE_FILE = 'compose.yaml'
    $script:hasPersistentAuthorizedKeys = $false
    $modes = if (Get-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue) { @('Legacy', 'Standard', 'Windows') } else { @('Legacy') }
    foreach ($mode in $modes) {
      if (Get-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue) { $PSNativeCommandArgumentPassing = $mode }
      Remove-Item Env:SSH_AUTHORIZED_KEYS -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $privatePath, $publicPath -Force -ErrorAction SilentlyContinue
      . (Join-Path $root 'scripts/docker-setup.ps1')
      Assert ((Test-Path -LiteralPath $privatePath -PathType Leaf) -and (Test-Path -LiteralPath $publicPath -PathType Leaf)) "Real key generation failed in $mode mode."
      $originalPublicKey = (Get-Content -Raw -LiteralPath $publicPath).Trim()
      Assert ($script:startedWithKey -ceq $originalPublicKey) "Generated key was not passed to Compose in $mode mode."
      Remove-Item Env:SSH_AUTHORIZED_KEYS
      Remove-Item -LiteralPath $publicPath
      . (Join-Path $root 'scripts/docker-setup.ps1')
      Assert ((Get-Content -Raw -LiteralPath $publicPath).Trim() -ceq $originalPublicKey) "Real recovery changed the public key in $mode mode."
      Assert ($script:startedWithKey -ceq $originalPublicKey) "Recovered key was not passed to Compose in $mode mode."
      Remove-Item Env:SSH_AUTHORIZED_KEYS
      Remove-Item -LiteralPath $privatePath, $publicPath
      & $nativeKeygen.Source -q -t ed25519 -N 'fixture-passphrase' -f $privatePath
      Assert ($LASTEXITCODE -eq 0) 'Could not create encrypted test identity.'
      Remove-Item -LiteralPath $publicPath
      $beforePrivate = [IO.File]::ReadAllBytes($privatePath)
      $startupCount = @($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count
      $failed = $false
      try { . (Join-Path $root 'scripts/docker-setup.ps1') } catch { $failed = $_.Exception.Message -match 'cannot recover SSH public key' }
      Assert ($failed -and -not (Test-Path -LiteralPath $publicPath)) "Encrypted key recovery did not fail safely in $mode mode."
      Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($privatePath)) -ceq [Convert]::ToBase64String($beforePrivate)) 'Encrypted private key was modified.'
      Assert (@($script:dockerCalls | Where-Object { $_ -eq 'compose up -d' }).Count -eq $startupCount) 'Failed native recovery reached startup.'
    }
    Write-Output 'PowerShell Docker setup real ssh-keygen checks passed.'
  } else {
    Write-Output 'PowerShell Docker setup real ssh-keygen checks skipped: executable not found.'
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:PI_HERDSMAN_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:SSH_AUTHORIZED_KEYS -ErrorAction SilentlyContinue
}
