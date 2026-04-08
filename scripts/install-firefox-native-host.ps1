$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distBridgePath = Join-Path $projectRoot "dist\index.js"
$distNativeHostPath = Join-Path $projectRoot "dist\native-host.js"

if (-not (Test-Path $distBridgePath)) {
    throw "Bridge entry was not found: $distBridgePath. Run `npm run build` first."
}

if (-not (Test-Path $distNativeHostPath)) {
    throw "Native host entry was not found: $distNativeHostPath. Run `npm run build` first."
}

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeExePath = $nodeCommand.Source
if (-not $nodeExePath) {
    throw "Node.js executable was not found in PATH."
}

$hostName = "chatgpt_web_bridge_host"
$extensionId = "chatgpt-web-bridge@example.local"
$hostDir = Join-Path $env:LOCALAPPDATA "chatgpt-web-bridge\native-host\firefox"
$wrapperPath = Join-Path $hostDir "chatgpt-web-bridge-native-host.cmd"
$manifestPath = Join-Path $hostDir "$hostName.json"

New-Item -ItemType Directory -Path $hostDir -Force | Out-Null

$wrapperContent = @"
@echo off
setlocal
"$nodeExePath" "$distNativeHostPath"
"@

$manifestObject = @{
    name = $hostName
    description = "ChatGPT Web Bridge native messaging host for Firefox."
    path = [System.IO.Path]::GetFileName($wrapperPath)
    type = "stdio"
    allowed_extensions = @($extensionId)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($wrapperPath, $wrapperContent.Trim() + [Environment]::NewLine, $utf8NoBom)
[System.IO.File]::WriteAllText($manifestPath, (($manifestObject | ConvertTo-Json -Depth 5) + [Environment]::NewLine), $utf8NoBom)

$registryKey = "HKCU\Software\Mozilla\NativeMessagingHosts\$hostName"
$null = & reg.exe add $registryKey /ve /t REG_SZ /d $manifestPath /f

Write-Host "Firefox native host installed."
Write-Host "Manifest: $manifestPath"
Write-Host "Wrapper:  $wrapperPath"
Write-Host "Registry: $registryKey"
