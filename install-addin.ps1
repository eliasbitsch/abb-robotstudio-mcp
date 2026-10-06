# Install the RobotStudioBridge add-in for RobotStudio as a DEVELOPER copy-install.
# Run with:  powershell -ExecutionPolicy Bypass -File install-addin.ps1
#
# End users should install the .rspak package instead (build-rspak.ps1, then RobotStudio ->
# Add-Ins tab -> Install Package): per-user, no administrator rights.
#
# This copies the built add-in into %ProgramFiles(x86)%\Common Files\ABB\RobotStudio\Addins,
# which RobotStudio scans at startup (all users, any version). Writing there needs
# administrator rights, so the script elevates itself. A General add-in with autoLoad="true"
# loads on the next RobotStudio start with no manual step.
#
# PRECEDENCE TRAP (RobotStudio 2025): installed distribution packages in
# %LocalAppData%\ABB\DistributionPackages2 are scanned BEFORE the Common Files folder, and
# RobotStudio loads only the first add-in with a given ApplicationId. An installed
# RobotStudioBridge package therefore SHADOWS this copy; the script warns about it.

param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$dll     = Join-Path $PSScriptRoot 'addin\bin\RobotStudioBridge.dll'
$rsaddin = Join-Path $PSScriptRoot 'addin\RobotStudioBridge.rsaddin'
$dest    = Join-Path ${env:ProgramFiles(x86)} 'Common Files\ABB\RobotStudio\Addins\RobotStudioBridge'

if ($Elevated) {
    # The elevated half: copy, and report failure through the exit code.
    try {
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item $dll $dest -Force
        Copy-Item $rsaddin $dest -Force
        exit 0
    } catch {
        Write-Host "Copy failed: $($_.Exception.Message)" -ForegroundColor Red
        Start-Sleep -Seconds 5
        exit 1
    }
}

if (-not (Test-Path $dll)) {
    Write-Host "ERROR: $dll not found. Build the add-in first:" -ForegroundColor Red
    Write-Host '  dotnet build addin\RobotStudioBridge.csproj -c Release'
    exit 1
}
if (Get-Process RobotStudio -ErrorAction SilentlyContinue) {
    Write-Host 'ERROR: RobotStudio is running. It loads (and locks) the add-in at startup; close it first.' -ForegroundColor Red
    exit 1
}

$shadow = Get-ChildItem "$env:LOCALAPPDATA\ABB\DistributionPackages2" -Directory -Filter 'AbbRobotStudioMcp.RobotStudioBridge-*' -ErrorAction SilentlyContinue
if ($shadow) {
    Write-Host 'WARNING: an installed RobotStudioBridge package will load INSTEAD of this copy (same ApplicationId):' -ForegroundColor Yellow
    $shadow | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Yellow }
    Write-Host "Uninstall it from RobotStudio's Add-Ins tab (or delete that folder) for this copy to load." -ForegroundColor Yellow
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item $dll $dest -Force
    Copy-Item $rsaddin $dest -Force
} else {
    Write-Host 'Elevating to write the RobotStudio add-in folder (approve the UAC prompt)...'
    try {
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated'
    } catch {
        Write-Host 'ERROR: elevation was cancelled; nothing was installed.' -ForegroundColor Red
        exit 1
    }
    if ($p.ExitCode -ne 0) {
        Write-Host "ERROR: the elevated copy failed (exit code $($p.ExitCode)); nothing was installed." -ForegroundColor Red
        exit 1
    }
}

Write-Host "RobotStudioBridge add-in installed to: $dest"
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Start RobotStudio: the add-in loads and listens on http://localhost:58080'
Write-Host '  2. Restart your MCP client so it attaches the rs_* and rws_* tools'
Write-Host '  Check: curl http://localhost:58080/ping'
