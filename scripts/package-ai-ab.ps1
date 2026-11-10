param(
    [string]$ReleaseName = '20261030-ai-ab-fixed',
    [string]$Runtime = 'dist-desktop/20261007-follow-plans/win-unpacked',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($ReleaseName -notmatch '^[a-zA-Z0-9-]+$') { throw 'Invalid release name' }
$Release = [IO.Path]::GetFullPath((Join-Path $Root "dist-desktop/$ReleaseName"))
$Source = [IO.Path]::GetFullPath((Join-Path $Root $Runtime))
$Prefix = $Root.TrimEnd('\') + '\'
foreach ($Target in @($Release, $Source)) {
    if (-not $Target.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path outside workspace: $Target" }
}
$Zip = Join-Path $Root "dist-desktop/AntigravityCrypto-$ReleaseName.zip"
if ((Test-Path -LiteralPath $Release) -or (Test-Path -LiteralPath $Zip)) { throw 'Release exists; use a new name to preserve it' }
if (-not (Test-Path -LiteralPath (Join-Path $Source 'AntigravityCrypto.exe'))) { throw 'Electron runtime not found' }
if (-not $SkipBuild) {
    Push-Location $Root
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Workspace build failed' }
    } finally { Pop-Location }
}
New-Item -ItemType Directory -Path $Release | Out-Null
Copy-Item -LiteralPath $Source -Destination $Release -Recurse
& node (Join-Path $Root 'scripts/stage-desktop.mjs') $ReleaseName
if ($LASTEXITCODE -ne 0) { throw 'Workspace staging failed' }
$App = Join-Path $Release 'win-unpacked'
$Archive = Join-Path $App 'resources/app.asar'
& node (Join-Path $Root 'scripts/verify-desktop.cjs') (Join-Path $Release 'app-staging') $Archive
if ($LASTEXITCODE -ne 0) { throw 'ASAR verification failed' }
Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination $App
$Evidence = Join-Path $Root 'artifacts/ai-ab/QA.md'
if (Test-Path -LiteralPath $Evidence) { Copy-Item -LiteralPath $Evidence -Destination (Join-Path $App 'AI-AB-QA.md') }
Compress-Archive -LiteralPath $App -DestinationPath $Zip -CompressionLevel Optimal
$Contents = [IO.Compression.ZipFile]::OpenRead($Zip)
try {
    foreach ($Pattern in @('AntigravityCrypto.exe$', 'resources[/\\]app.asar$', 'app.asar.unpacked[/\\]apps[/\\]collector[/\\]src[/\\]main.js$', 'duckdb.node$')) {
        if (-not ($Contents.Entries.FullName -match $Pattern)) { throw "ZIP missing $Pattern" }
    }
    Write-Output "Verified ZIP entries: $($Contents.Entries.Count)"
} finally { $Contents.Dispose() }
Get-FileHash -LiteralPath $Archive, $Zip -Algorithm SHA256
Get-Item -LiteralPath $Zip | Select-Object FullName,Length
