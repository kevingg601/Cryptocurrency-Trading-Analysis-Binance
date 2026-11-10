param(
    [string]$ReleaseName = '20261030-ai-ab-fixed',
    [string]$Runtime = 'dist-desktop/20261007-follow-plans/win-unpacked',
    [switch]$SkipBuild
)

& (Join-Path $PSScriptRoot 'package-ai-ab.ps1') -ReleaseName $ReleaseName -Runtime $Runtime -SkipBuild:$SkipBuild
