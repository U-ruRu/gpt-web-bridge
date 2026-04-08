$ErrorActionPreference = "Stop"

function Resolve-WaterfoxPath {
    if ($env:WATERFOX_EXE -and (Test-Path $env:WATERFOX_EXE)) {
        return (Resolve-Path $env:WATERFOX_EXE).Path
    }

    $command = Get-Command waterfox -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and (Test-Path $command.Source)) {
        return $command.Source
    }

    $candidates = @(
        "C:\Program Files\Waterfox\waterfox.exe",
        "C:\Program Files\Waterfox Current\waterfox.exe",
        "C:\Program Files\Waterfox Classic\waterfox.exe",
        "C:\Program Files (x86)\Waterfox\waterfox.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    throw "Waterfox executable was not found. Set WATERFOX_EXE or install Waterfox into a standard path."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$profileDir = Join-Path $env:LOCALAPPDATA "chatgpt-web-bridge\waterfox-dev-profile"
$addonDir = Join-Path $profileDir "extensions"

if (-not (Test-Path $addonDir)) {
    $installScriptPath = Join-Path $PSScriptRoot "install-waterfox-dev-addon.ps1"
    & $installScriptPath | Out-Host
}

$waterfoxPath = Resolve-WaterfoxPath
$arguments = @(
    "-no-remote",
    "-profile", $profileDir,
    "about:addons"
)

Write-Host "Starting Waterfox dev profile."
Write-Host "Executable: $waterfoxPath"
Write-Host "Profile:    $profileDir"

Start-Process -FilePath $waterfoxPath -ArgumentList $arguments
