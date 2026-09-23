# Build the RobotStudioBridge add-in and package it as a RobotStudio Distribution
# Package (.rspak). Users install the result natively from RobotStudio's
# Add-Ins tab -> "Install Package" -- per-user, no admin, no file copying.
#
# Run with:  powershell -ExecutionPolicy Bypass -File build-rspak.ps1
#
# Requires: the .NET SDK (dotnet) or MSBuild, plus the RobotStudio SDK
# (RspakTool.exe -- free download from developercenter.robotstudio.com).
#
# The package version comes from DisplayVersion in addin\RobotStudioBridge.rsaddin
# (the single source of truth; the script passes it to the compiler too, so
# the assembly version reported by /ping matches).

param(
    [string]$Configuration = 'Release',
    [string]$OutDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

# -- Version: single source of truth is the .rsaddin's DisplayVersion. ------
$rsaddinPath = Join-Path $PSScriptRoot 'addin\RobotStudioBridge.rsaddin'
$rsaddinXml  = [xml](Get-Content $rsaddinPath)
$version     = $rsaddinXml.RobotStudioAddIn.DisplayVersion
if (-not $version) { throw "DisplayVersion not found in $rsaddinPath" }

# The MCP server and the add-in ship together and refuse to work across a major-version
# mismatch, so their versions must be the same.
$pkgVersion = (Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($pkgVersion -ne $version) {
    throw "Version mismatch: addin\RobotStudioBridge.rsaddin says $version, package.json says $pkgVersion. Make them equal."
}
Write-Host "Packaging RobotStudioBridge v$version"

# -- 1. Build the add-in DLL. -----------------------------------------------
$csproj = Join-Path $PSScriptRoot 'addin\RobotStudioBridge.csproj'
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnet) {
    & $dotnet.Source build $csproj -c $Configuration "-p:Version=$version"
} else {
    $msbuild = Get-Command msbuild -ErrorAction SilentlyContinue
    if (-not $msbuild) {
        # Last resort: locate MSBuild through vswhere (Visual Studio installer).
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path $vswhere) {
            $msbuildPath = & $vswhere -latest -requires Microsoft.Component.MSBuild `
                -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
            if ($msbuildPath) { $msbuild = @{ Source = $msbuildPath } }
        }
    }
    if (-not $msbuild) { throw 'Neither dotnet nor MSBuild found. Install the .NET SDK or Visual Studio.' }
    & $msbuild.Source $csproj /restore "/p:Configuration=$Configuration" "/p:Version=$version"
}
if ($LASTEXITCODE -ne 0) { throw 'Add-in build failed.' }
$built = [Reflection.AssemblyName]::GetAssemblyName((Join-Path $PSScriptRoot 'addin\bin\RobotStudioBridge.dll')).Version.ToString(3)
if ($built -ne $version) { throw "The built RobotStudioBridge.dll is version $built, expected $version." }

# -- 2. Locate RspakTool.exe (ships in the RobotStudio SDK root). -----------
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'ABB\SDK'
$rspakTool = Get-ChildItem -Path $sdkRoot -Recurse -Filter 'RspakTool.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $rspakTool) {
    throw "RspakTool.exe not found under $sdkRoot -- install the RobotStudio SDK from developercenter.robotstudio.com."
}
Write-Host "Using $($rspakTool.FullName)"

# -- 3. Build the .rspak from the spec. -------------------------------------
$spec = Join-Path $PSScriptRoot 'addin\RobotStudioBridge.rspakspec'
& $rspakTool.FullName -i $spec -p "version=$version" -o $OutDir
if ($LASTEXITCODE -ne 0) { throw 'RspakTool failed.' }

$package = Join-Path $OutDir "AbbRobotStudioMcp.RobotStudioBridge-$version.rspak"
Write-Host ''
Write-Host "Package ready: $package"
Write-Host 'Install: RobotStudio -> Add-Ins tab -> Install Package -> select the .rspak, then restart RobotStudio.'
Write-Host 'Verify:  curl http://localhost:58080/ping   (reports the loaded version + assembly location)'
