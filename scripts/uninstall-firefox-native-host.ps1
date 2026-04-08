$ErrorActionPreference = "Stop"

$hostName = "chatgpt_web_bridge_host"
$hostDir = Join-Path $env:LOCALAPPDATA "chatgpt-web-bridge\native-host\firefox"
$registryKey = "HKCU\Software\Mozilla\NativeMessagingHosts\$hostName"

$null = & reg.exe delete $registryKey /f 2>$null
if (Test-Path $hostDir) {
    Remove-Item -Path $hostDir -Recurse -Force
}

Write-Host "Firefox native host removed."
Write-Host "Registry: $registryKey"
Write-Host "Directory: $hostDir"
