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
    $BundledNodeExe = Join-Path $RuntimeRoot "node.exe"
    Copy-Item -Path $NodeExe -Destination $BundledNodeExe -Force
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
        "setlocal EnableExtensions",
        "cd /d `"%~dp0`"",
        "set `"LOG=%~dp0viewer-startup.log`"",
        "> `"%LOG%`" echo G1_SYSID_VIEWER_STARTUP_V2",
        ">> `"%LOG%`" echo Started: %DATE% %TIME%",
        ">> `"%LOG%`" echo Package: %~dp0",
        "echo Starting G1 SysID Viewer...",
        "echo Do not use Run as administrator. Normal double-click is sufficient.",
        "echo Keep this window open while using the viewer.",
        "echo Startup log: %LOG%",
        "echo.",
        "`"%~dp0runtime\node.exe`" --version >> `"%LOG%`" 2>&1",
        "if errorlevel 1 (",
        "  echo Windows could not start runtime\node.exe.",
        "  echo Check Windows Security ^> Protection history for Smart App Control.",
        "  echo Unblock the downloaded ZIP before extracting it, then extract again.",
        "  echo.",
        "  type `"%LOG%`"",
        "  pause",
        "  exit /b 1",
        ")",
        "`"%~dp0runtime\node.exe`" `"%~dp0runtime\portable-server.mjs`" --root `"%~dp0site`" --port $Port --page `"$StartPage`"",
        "set `"EXIT_CODE=%ERRORLEVEL%`"",
        "if not `"%EXIT_CODE%`"==`"0`" (",
        "  echo.",
        "  echo Viewer stopped with exit code %EXIT_CODE%.",
        "  echo Review viewer-startup.log and Windows Security ^> Protection history.",
        "  pause",
        ")",
        "endlocal & exit /b %EXIT_CODE%"
    )
    $Launcher | Set-Content -Path $LauncherPath -Encoding ASCII

    $DiagnosticPath = Join-Path $PackageRoot "Check-G1-SysID-Viewer.cmd"
    $Diagnostic = @(
        "@echo off",
        "setlocal EnableExtensions",
        "cd /d `"%~dp0`"",
        "echo G1 SysID Viewer startup check",
        "echo Package: %CD%",
        "echo.",
        "if not exist `"%~dp0runtime\node.exe`" (",
        "  echo ERROR: runtime\node.exe is missing.",
        "  pause",
        "  exit /b 1",
        ")",
        "if not exist `"%~dp0runtime\portable-server.mjs`" (",
        "  echo ERROR: runtime\portable-server.mjs is missing.",
        "  pause",
        "  exit /b 1",
        ")",
        "if not exist `"%~dp0site\index.html`" (",
        "  echo ERROR: site\index.html is missing.",
        "  pause",
        "  exit /b 1",
        ")",
        "echo Running bundled Node.js preflight...",
        "`"%~dp0runtime\node.exe`" --version",
        "if errorlevel 1 (",
        "  echo.",
        "  echo ERROR: Windows blocked or could not start runtime\node.exe.",
        "  echo Check Windows Security ^> Protection history.",
        "  pause",
        "  exit /b 1",
        ")",
        "echo.",
        "echo PRECHECK_OK",
        "pause",
        "endlocal"
    )
    $Diagnostic | Set-Content -Path $DiagnosticPath -Encoding ASCII

    $Commit = (& git rev-parse HEAD).Trim()
    $NodeVersion = (& $NodeExe --version).Trim()
    $NodeSignature = Get-AuthenticodeSignature -FilePath $BundledNodeExe
    $NodeSignatureStatus = [string]$NodeSignature.Status
    $NodeSigner = if ($NodeSignature.SignerCertificate) {
        [string]$NodeSignature.SignerCertificate.Subject
    }
    else {
        "No signer certificate reported"
    }

    $ReadmePath = Join-Path $PackageRoot "README.txt"
    $Readme = @"
G1 SysID Viewer - Windows portable package
===========================================

重要：如果 Windows 顯示「智慧應用程式控制系統已封鎖」
--------------------------------------------------------
1. 不要使用「以系統管理員身分執行」；系統管理員權限不會讓檔案變可信。
2. 回到原始 ZIP，按右鍵 -> 內容/屬性 -> 勾選「解除封鎖」-> 套用。
3. 刪除先前解壓出的資料夾。
4. 將已解除封鎖的 ZIP 重新完整解壓到本機磁碟，例如 C:\G1-SysID-Viewer。
5. 正常雙擊 Start-G1-SysID-Viewer.cmd，不要使用系統管理員模式。
6. 若仍無法啟動，執行 Check-G1-SysID-Viewer.cmd，並查看 viewer-startup.log。
7. 到 Windows 安全性 -> 保護歷程記錄，確認被封鎖的是 .cmd 或 runtime\node.exe。

使用方式
--------
1. 完整解壓縮 ZIP，不要直接在壓縮檔內執行。
2. 雙擊 Start-G1-SysID-Viewer.cmd。
3. 瀏覽器會自動開啟 SysID Replay。
4. 使用期間請保持黑色命令視窗開啟；關閉視窗即停止服務。

Usage
-----
1. If Windows marks the download as blocked, unblock the ZIP before extraction.
2. Extract the ZIP completely to a local disk.
3. Double-click Start-G1-SysID-Viewer.cmd normally; do not run it as administrator.
4. Keep the command window open while using the viewer.
5. Run Check-G1-SysID-Viewer.cmd if startup fails.

$MotionDescription

Security boundary
-----------------
The included server listens only on 127.0.0.1 (this computer). It does not expose
the viewer to other devices on the network and does not require a firewall rule.

Build information
-----------------
Viewer commit: $Commit
Bundled Node.js: $NodeVersion
Node signature status: $NodeSignatureStatus
Node signer: $NodeSigner
Default port: $Port (the launcher automatically selects a nearby free port if busy)
"@
    $Readme | Set-Content -Path $ReadmePath -Encoding UTF8

    $StartHerePath = Join-Path $PackageRoot "START-HERE.txt"
    @"
先不要用系統管理員執行。

若 Windows 顯示「智慧應用程式控制系統已封鎖」：
1. 對原始 ZIP 按右鍵 -> 內容/屬性 -> 解除封鎖。
2. 刪除舊的解壓資料夾，再重新解壓。
3. 正常雙擊 Start-G1-SysID-Viewer.cmd。
4. 啟動失敗時執行 Check-G1-SysID-Viewer.cmd。
5. 查看 viewer-startup.log 與 Windows 安全性 -> 保護歷程記錄。
"@ | Set-Content -Path $StartHerePath -Encoding UTF8

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
