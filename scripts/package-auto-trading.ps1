param(
    [string]$ReleaseName = '20261007-auto-trading',
    [string]$Runtime = 'dist-desktop/20261007-follow-plans/win-unpacked'
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
if ((Test-Path -LiteralPath $Release) -or (Test-Path -LiteralPath $Zip)) { throw 'Release already exists; choose a new release name to preserve it' }
if (-not (Test-Path -LiteralPath (Join-Path $Source 'AntigravityCrypto.exe'))) { throw 'Existing Electron runtime not found' }
if (-not (Test-Path -LiteralPath (Join-Path $Root 'dist/index.html'))) { throw 'Build the frontend first' }

New-Item -ItemType Directory -Path $Release | Out-Null
Copy-Item -LiteralPath $Source -Destination $Release -Recurse
$App = Join-Path $Release 'win-unpacked'
$Staging = Join-Path $Release 'app-staging'
New-Item -ItemType Directory -Path $Staging | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'dist') -Destination $Staging -Recurse
Copy-Item -LiteralPath (Join-Path $Root 'main.cjs'), (Join-Path $Root 'package.json') -Destination $Staging
$Archive = Join-Path $App 'resources/app.asar'
& node (Join-Path $Root 'node_modules/@electron/asar/bin/asar.js') pack $Staging $Archive
if ($LASTEXITCODE -ne 0) { throw 'ASAR packaging failed' }
& node (Join-Path $Root 'scripts/verify-desktop.cjs') $Staging $Archive
if ($LASTEXITCODE -ne 0) { throw 'ASAR verification failed' }

$Qa = Join-Path $Root 'artifacts/auto-trading'
if (Test-Path -LiteralPath $Qa) { Copy-Item -LiteralPath $Qa -Destination (Join-Path $App 'QA') -Recurse }
Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination $App
Compress-Archive -LiteralPath $App -DestinationPath $Zip -CompressionLevel Optimal
$Contents = [IO.Compression.ZipFile]::OpenRead($Zip)
try {
    if (-not ($Contents.Entries.FullName -match 'AntigravityCrypto.exe$') -or -not ($Contents.Entries.FullName -match 'resources[/\\]app.asar$')) {
        throw 'ZIP is missing the executable or application archive'
    }
    Write-Output "Verified ZIP entries: $($Contents.Entries.Count)"
} finally { $Contents.Dispose() }
Get-FileHash -LiteralPath $Archive, $Zip -Algorithm SHA256
Get-Item -LiteralPath $Zip | Select-Object FullName, Length
