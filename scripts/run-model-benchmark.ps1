[CmdletBinding()]
param(
    [switch]$NewRun,
    [string]$RunDir,
    [switch]$Smoke
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mainPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
$manifestPath = Join-Path $repoRoot 'data\model-benchmark\bootstrap-manifest.json'
$runnerArgs = @('-m', 'research.model_benchmark.runner')
if ($NewRun) { $runnerArgs += '--new-run' }
if ($RunDir) { $runnerArgs += @('--run-dir', $RunDir) }
if ($Smoke) { $runnerArgs += '--smoke' }

if (-not (Test-Path -LiteralPath $mainPython -PathType Leaf)) {
    throw "專案既有 Python 環境不存在：$mainPython"
}

$sleepGuardType = 'FadachiModelBenchmark.SleepGuard'
if (-not ([System.Management.Automation.PSTypeName]$sleepGuardType).Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FadachiModelBenchmark {
  public static class SleepGuard {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint SetThreadExecutionState(uint flags);
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
  }
}
'@
}

$repoHash = [System.Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $repoHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant()))
    $mutexSuffix = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '')
}
finally {
    $repoHash.Dispose()
}
$mutex = $null
$mutexOwned = $false
$activated = $false
try {
    $mutexName = "Local\FadachiBenchmark-$mutexSuffix"
    $mutex = [System.Threading.Mutex]::new($false, $mutexName)
    try {
        $mutexOwned = $mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $mutexOwned = $true
    }
    if (-not $mutexOwned) {
        throw '此專案已有另一個模型基準啟動器執行中。'
    }

    [void][FadachiModelBenchmark.SleepGuard]::SetThreadExecutionState(
        [FadachiModelBenchmark.SleepGuard]::ES_CONTINUOUS -bor [FadachiModelBenchmark.SleepGuard]::ES_SYSTEM_REQUIRED)
    $activated = $true

    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    Push-Location $repoRoot
    try {
        Write-Host '準備獨立模型環境與鎖定權重…'
        & $mainPython -m research.model_benchmark.bootstrap --prepare --manifest $manifestPath
        $bootstrapExit = $LASTEXITCODE
        if ($bootstrapExit -ne 0 -and $bootstrapExit -ne 2) {
            throw "模型環境準備程序失敗，exit=$bootstrapExit"
        }
        if ($bootstrapExit -eq 2) {
            Write-Warning "部分環境或權重準備失敗；runner 會逐模型記錄失敗並繼續可執行模型。詳見 $manifestPath"
        }

        & $mainPython @runnerArgs
        $runnerExit = $LASTEXITCODE
        exit $runnerExit
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($activated) {
        [void][FadachiModelBenchmark.SleepGuard]::SetThreadExecutionState(
            [FadachiModelBenchmark.SleepGuard]::ES_CONTINUOUS)
    }
    if ($mutex) {
        if ($mutexOwned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
