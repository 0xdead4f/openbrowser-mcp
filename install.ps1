# OpenBrowser MCP installer for Windows — best effort, documented but untested.
# The supported platforms are macOS and Linux (install.sh); this exists so a
# Windows user has something to start from rather than nothing.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#
# Takes no extension ID: it is pinned by the public key in extension/manifest.json.

[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$Root       = $PSScriptRoot
$HostDir    = Join-Path $Root 'host'
$ExtDir     = Join-Path $Root 'extension'
$Manifest   = Join-Path $ExtDir 'manifest.json'
$Wrapper    = Join-Path $HostDir 'native-host-wrapper.cmd'
$HostJson   = Join-Path $HostDir 'io.openbrowser.mcp.json'
$HostName   = 'io.openbrowser.mcp'
$ServerName = 'openbrowser'

# Every Chromium fork reads NativeMessagingHosts from its own HKCU subtree. Windows
# gives no cheap "is it installed" signal, so all keys are written unconditionally —
# a key for an absent browser is inert.
$RegistryRoots = @(
  @{ Label = 'Google Chrome';  Path = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts' },
  @{ Label = 'Microsoft Edge'; Path = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts' },
  @{ Label = 'Brave Browser';  Path = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts' },
  @{ Label = 'Chromium';       Path = 'HKCU:\Software\Chromium\NativeMessagingHosts' },
  @{ Label = 'Vivaldi';        Path = 'HKCU:\Software\Vivaldi\NativeMessagingHosts' }
)

function Write-Ok   { param($m) Write-Host "    " -NoNewline; Write-Host "OK  " -ForegroundColor Green -NoNewline; Write-Host $m }
function Write-Skip { param($m) Write-Host "    -   $m" -ForegroundColor DarkGray }
function Write-Warn { param($m) Write-Host "    " -NoNewline; Write-Host "!   " -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Section    { param($m) Write-Host ""; Write-Host "  $m" -ForegroundColor White }

# No BOM: cmd.exe mis-parses a BOM'd .cmd, and Chrome's manifest parser is strict.
function Write-TextFile {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Uninstall) {
  Write-Host ""; Write-Host "  OpenBrowser MCP uninstaller (Windows)" -ForegroundColor White

  Section "Removing registry entries"
  foreach ($r in $RegistryRoots) {
    $key = Join-Path $r.Path $HostName
    if (Test-Path $key) { Remove-Item -Path $key -Force; Write-Ok "$($r.Label)  $key" }
    else { Write-Skip "$($r.Label)  nothing to remove" }
  }

  Section "Removing generated files"
  foreach ($f in @($Wrapper, $HostJson)) {
    if (Test-Path $f) { Remove-Item -Path $f -Force; Write-Ok $f }
  }
  $cfg = Join-Path $env:USERPROFILE '.config\openbrowser-mcp'
  if (Test-Path $cfg) { Remove-Item -Path $cfg -Recurse -Force; Write-Ok $cfg }

  Section "Removing the Claude Code MCP entry"
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    & claude mcp remove $ServerName 2>&1 | Out-Null
    Write-Ok "claude mcp remove $ServerName"
  } else {
    Write-Skip "claude CLI not found"
  }

  Write-Host ""
  Write-Host "  The extension itself is still loaded - remove it from chrome://extensions."
  Write-Host ""
  return
}

Write-Host ""; Write-Host "  OpenBrowser MCP installer (Windows, best effort)" -ForegroundColor White

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found. Install Node.js 20+ and re-run." }
$nodeVersion = (& node --version).Trim()
if ([int](($nodeVersion.TrimStart('v') -split '\.')[0]) -lt 20) {
  throw "node $nodeVersion is too old - this build needs v20+."
}
Write-Host "  OK  node $nodeVersion" -ForegroundColor Green

$ExtId = (& node (Join-Path $Root 'host\lib\extid.js') $Manifest).Trim()
if ($ExtId -notmatch '^[a-p]{32}$') { throw "derived extension ID looks wrong: '$ExtId'" }
Write-Host "  OK  extension id  $ExtId  (pinned via manifest key)" -ForegroundColor Green

Section "Writing the native messaging host wrapper"

# node is resolved when Chrome runs this, not when the installer writes it, so an
# nvm-for-windows version switch does not silently break the bridge.
$wrapperText = @'
@echo off
setlocal enabledelayedexpansion
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE for /f "delims=" %%v in ('dir /b /o-n "%APPDATA%\nvm\v*" 2^>nul') do if not defined NODE if exist "%APPDATA%\nvm\%%v\node.exe" set "NODE=%APPDATA%\nvm\%%v\node.exe"
if not defined NODE (
  echo io.openbrowser.mcp: no node found on PATH, in Program Files, or under %%APPDATA%%\nvm 1>&2
  exit /b 1
)
"%NODE%" "%~dp0native-host.js"
'@ -replace "`r?`n", "`r`n"

Write-TextFile -Path $Wrapper -Content $wrapperText
Write-Ok $Wrapper

$hostManifest = [ordered]@{
  name            = $HostName
  description     = 'OpenBrowser MCP native messaging host'
  path            = $Wrapper
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtId/")
} | ConvertTo-Json -Depth 4

Write-TextFile -Path $HostJson -Content $hostManifest
Write-Ok $HostJson

Section "Registering native messaging host $HostName"
foreach ($r in $RegistryRoots) {
  $key = Join-Path $r.Path $HostName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(Default)' -Value $HostJson
  Write-Ok "$($r.Label)  $key"
}

Section "Registering MCP server with Claude Code"
$serverJs = Join-Path $HostDir 'mcp-server.js'
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $out = & claude mcp add $ServerName -- node $serverJs 2>&1
  if ($LASTEXITCODE -eq 0) { Write-Ok "claude mcp add $ServerName -- node $serverJs" }
  elseif ("$out" -match 'already exist') { Write-Ok "already registered" }
  else {
    Write-Warn "claude mcp add failed - run it yourself:"
    Write-Host "      claude mcp add $ServerName -- node $serverJs"
  }
} else {
  Write-Skip "claude CLI not found - run this once it is installed:"
  Write-Host "      claude mcp add $ServerName -- node $serverJs"
}

Section "Last step - load the extension (once per browser):"
Write-Host "    1. open  chrome://extensions   -> Developer mode ON"
Write-Host "    2. Load unpacked -> select  $ExtDir"
Write-Host "    3. (optional) enable 'Allow in Incognito' for incognito windows"
Write-Host ""
Write-Host "  This script does not wait for the connection the way install.sh does."
Write-Host "  After loading the extension, start a Claude Code session and call"
Write-Host "  browsers_list to confirm the browser registered."
Write-Host ""
