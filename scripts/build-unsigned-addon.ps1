$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$extensionDir = Join-Path $projectRoot "extension"
$manifestPath = Join-Path $extensionDir "manifest.json"

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

$artifactsDir = Join-Path $projectRoot "artifacts\unsigned-addon"
$xpiPath = Join-Path $artifactsDir "chatgpt-web-bridge-$version-unsigned.xpi"

New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null
if (Test-Path $xpiPath) {
    Remove-Item -Path $xpiPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($xpiPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $baseUri = [System.Uri]("$extensionDir\")
    Get-ChildItem -Path $extensionDir -Recurse -File | ForEach-Object {
        $fileUri = [System.Uri]$_.FullName
        $relativePath = $baseUri.MakeRelativeUri($fileUri).ToString()
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $_.FullName,
            $relativePath,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Host "Unsigned XPI created."
Write-Host "XPI:      $xpiPath"
Write-Host "Addon ID: $addonId"
