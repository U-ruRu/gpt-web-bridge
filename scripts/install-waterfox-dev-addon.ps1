$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $projectRoot "extension\manifest.json"

if (-not (Test-Path $manifestPath)) {
    throw "Manifest was not found: $manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$addonId = [string]$manifest.browser_specific_settings.gecko.id

if (-not $version) {
    throw "Extension version is missing in manifest.json."
}

if (-not $addonId) {
    throw "Extension gecko.id is missing in manifest.json."
}

$buildScriptPath = Join-Path $PSScriptRoot "build-unsigned-addon.ps1"
& $buildScriptPath | Out-Host

$xpiPath = Join-Path $projectRoot "artifacts\unsigned-addon\chatgpt-web-bridge-$version-unsigned.xpi"
if (-not (Test-Path $xpiPath)) {
    throw "Unsigned XPI was not created: $xpiPath"
}

$nativeHostScriptPath = Join-Path $PSScriptRoot "install-firefox-native-host.ps1"
& $nativeHostScriptPath | Out-Host

$profileDir = Join-Path $env:LOCALAPPDATA "chatgpt-web-bridge\waterfox-dev-profile"
$extensionsDir = Join-Path $profileDir "extensions"
$installedXpiPath = Join-Path $extensionsDir "$addonId.xpi"
$userJsPath = Join-Path $profileDir "user.js"

New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
Copy-Item -Path $xpiPath -Destination $installedXpiPath -Force

$prefs = @(
    'user_pref("xpinstall.signatures.required", false);'
    'user_pref("extensions.autoDisableScopes", 0);'
    'user_pref("extensions.enabledScopes", 15);'
    'user_pref("browser.shell.checkDefaultBrowser", false);'
)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($userJsPath, (($prefs -join [Environment]::NewLine) + [Environment]::NewLine), $utf8NoBom)

Write-Host "Waterfox dev profile prepared."
Write-Host "Profile:  $profileDir"
Write-Host "Addon:    $installedXpiPath"
Write-Host "Prefs:    $userJsPath"
Write-Host ""
Write-Host "Next step:"
Write-Host "  npm run run:waterfox-dev"
