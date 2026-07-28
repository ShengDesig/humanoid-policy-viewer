[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$MotionJson = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputRoot = ".\artifacts",

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 65535)]
    [int]$Port = 4173,

    [Parameter(Mandatory = $false)]
    [switch]$Autoplay
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host "`n=== $Description ==="
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$NodeCommand = Get-Command "node.exe" -ErrorAction Stop
$NpmCommand = Get-Command "npm.cmd" -ErrorAction Stop
$NodeExe = $NodeCommand.Source
$NpmExe = $NpmCommand.Source

if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    $ResolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
}
else {
    $ResolvedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $OutputRoot))
}

$PackageName = "G1-SysID-Viewer-Windows-x64"
$PackageRoot = Join-Path $ResolvedOutputRoot $PackageName
$SiteRoot = Join-Path $PackageRoot "site"
$RuntimeRoot = Join-Path $PackageRoot "runtime"
$ZipPath = Join-Path $ResolvedOutputRoot "$PackageName.zip"
$DistRoot = Join-Path $RepoRoot "dist"
$ServerScript = Join-Path $RepoRoot "scripts\portable-server.mjs"

Push-Location $RepoRoot
try {
    Invoke-Checked -Description "Install viewer dependencies" -Command {
        & $NpmExe install --include=dev
    }

    Invoke-Checked -Description "Build production viewer" -Command {
        & $NpmExe run build
    }

    if (-not (Test-Path (Join-Path $DistRoot "index.html"))) {
        throw "Production build did not create dist\index.html"
    }
    if (-not (Test-Path $ServerScript)) {
        throw "Portable server script is missing: $ServerScript"
    }

    Write-Host "`n=== Assemble portable package ==="
    New-Item -ItemType Directory -Force -Path $ResolvedOutputRoot | Out-Null
    Remove-Item -Recurse -Force $PackageRoot -ErrorAction SilentlyContinue
    Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $SiteRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

    Copy-Item -Path (Join-Path $DistRoot "*") -Destination $SiteRoot -Recurse -Force
    Copy-Item -Path $NodeExe -Destination (Join-Path $RuntimeRoot "node.exe") -Force
    Copy-Item -Path $ServerScript -Destination (Join-Path $RuntimeRoot "portable-server.mjs") -Force

    $MotionQuery = ""
    $MotionDescription = "No motion clip is bundled. Use the file picker to load motions/default.json."
    if (-not [string]::IsNullOrWhiteSpace($MotionJson)) {
        $ResolvedMotion = (Resolve-Path $MotionJson -ErrorAction Stop).Path
        $MotionDirectory = Join-Path $SiteRoot "motions"
        New-Item -ItemType Directory -Force -Path $MotionDirectory | Out-Null
        Copy-Item -Path $ResolvedMotion -Destination (Join-Path $MotionDirectory "default.json") -Force
        $MotionQuery = "&motion=./motions/default.json"
        $MotionDescription = "Bundled motion: motions/default.json (automatically loaded at startup)."
    }

    $AutoplayQuery = ""
    if ($Autoplay.IsPresent -and -not [string]::IsNullOrWhiteSpace($MotionQuery)) {
        $AutoplayQuery = "&autoplay=1"
    }

    $StartPage = "/?mode=sysid$MotionQuery$AutoplayQuery"
    $LauncherPath = Join-Path $PackageRoot "Start-G1-SysID-Viewer.cmd"
    $Launcher = @(
        "@echo off",
        "setlocal",
        "cd /d `%~dp0",
        "echo Starting G1 SysID Viewer...",
        "echo Keep this window open while using the viewer.",
        "`"%~dp0runtime\node.exe`" `"%~dp0runtime\portable-server.mjs`" --root `"%~dp0site`" --port $Port --page `"$StartPage`"",
        "if errorlevel 1 (",
        "  echo.",
        "  echo Viewer failed to start.",
        "  pause",
        ")",
        "endlocal"
    )
    $Launcher | Set-Content -Path $LauncherPath -Encoding ASCII

    $Commit = (& git rev-parse HEAD).Trim()
    $NodeVersion = (& $NodeExe --version).Trim()
    $ReadmePath = Join-Path $PackageRoot "README.txt"
    $Readme = @"
G1 SysID Viewer - Windows portable package
===========================================

使用方式
--------
1. 完整解壓縮 ZIP，不要直接在壓縮檔內執行。
2. 雙擊 Start-G1-SysID-Viewer.cmd。
3. 瀏覽器會自動開啟 SysID Replay。
4. 使用期間請保持黑色命令視窗開啟；關閉視窗即停止服務。

Usage
-----
1. Extract the ZIP completely.
2. Double-click Start-G1-SysID-Viewer.cmd.
3. The browser opens the SysID Replay page automatically.
4. Keep the command window open while using the viewer.

$MotionDescription

Security boundary
-----------------
The included server listens only on 127.0.0.1 (this computer). It does not expose
the viewer to other devices on the network and does not require a firewall rule.

Build information
-----------------
Viewer commit: $Commit
Bundled Node.js: $NodeVersion
Default port: $Port (the launcher automatically selects a nearby free port if busy)
"@
    $Readme | Set-Content -Path $ReadmePath -Encoding UTF8

    $NodeVersionWithoutPrefix = $NodeVersion.TrimStart("v")
    $NodeLicenseUrl = "https://raw.githubusercontent.com/nodejs/node/v$NodeVersionWithoutPrefix/LICENSE"
    $NodeLicensePath = Join-Path $PackageRoot "THIRD_PARTY_NODE_LICENSE.txt"
    try {
        Invoke-WebRequest -Uri $NodeLicenseUrl -UseBasicParsing -OutFile $NodeLicensePath
    }
    catch {
        $LicenseFallback = @"
This package includes Node.js $NodeVersion.
Node.js is distributed under the MIT license and additional third-party licenses.
Exact license source attempted: $NodeLicenseUrl
The packaging machine could not download the license text: $($_.Exception.Message)
"@
        $LicenseFallback | Set-Content -Path $NodeLicensePath -Encoding UTF8
        Write-Warning "Could not download the exact Node.js license text. A notice was included instead."
    }

    Write-Host "`n=== Create ZIP ==="
    Compress-Archive -Path $PackageRoot -DestinationPath $ZipPath -CompressionLevel Optimal

    $ZipItem = Get-Item $ZipPath
    Write-Host "`nG1_SYSID_PORTABLE_PACKAGE_OK"
    Write-Host "Folder: $PackageRoot"
    Write-Host "ZIP:    $($ZipItem.FullName)"
    Write-Host "Size:   $([Math]::Round($ZipItem.Length / 1MB, 2)) MB"
}
finally {
    Pop-Location
}
