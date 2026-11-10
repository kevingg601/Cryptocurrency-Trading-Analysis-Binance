param([string]$ProfileHome)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ProfileHome) {
    Push-Location $Root
    try {
        $ProfileHome = & node --experimental-strip-types --input-type=module -e "import { AntigravityProvider } from './apps/collector/src/ai/antigravityProvider.ts'; const p = new AntigravityProvider(); await p.verifyIsolation(); console.log(p.profileHome);"
        if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize the private CLI profile' }
    } finally { Pop-Location }
}
$ProfileHome = [IO.Path]::GetFullPath(($ProfileHome | Select-Object -Last 1))
$Marker = Join-Path $ProfileHome 'fadachi-profile.json'
if (-not (Test-Path -LiteralPath $Marker)) { throw 'Start the app once to initialize its private CLI profile, or supply its exact profile path' }
if ((Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json).kind -ne 'fadachi-analysis-profile-v1') { throw 'Incorrect profile marker' }
$Executable = if ($env:FADACHI_CLI_PATH) { $env:FADACHI_CLI_PATH } else { Join-Path $env:USERPROFILE 'AppData/Local/agy/bin/agy.exe' }
if (-not (Test-Path -LiteralPath $Executable)) { throw 'Antigravity CLI executable not found; set FADACHI_CLI_PATH' }
$env:USERPROFILE = $ProfileHome
$env:HOME = $ProfileHome
$env:APPDATA = Join-Path $ProfileHome 'AppData/Roaming'
$env:LOCALAPPDATA = Join-Path $ProfileHome 'AppData/Local'
$env:AGY_CLI_DISABLE_AUTO_UPDATE = '1'
$env:AGY_CLI_HIDE_ACCOUNT_INFO = '1'
Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:FADACHI_TOKEN -ErrorAction SilentlyContinue
Push-Location (Join-Path $ProfileHome 'workspace')
try { & $Executable } finally { Pop-Location }
