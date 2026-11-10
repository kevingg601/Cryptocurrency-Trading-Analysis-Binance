$ErrorActionPreference = 'Stop'
$reviewProject = (Resolve-Path -LiteralPath 'D:\PYTHON\fadachi').Path
$reviewPromptFile = (Resolve-Path -LiteralPath 'D:\PYTHON\fadachi\reviews\codex-20261030\review_prompt.txt').Path
$reviewRunDir = (Resolve-Path -LiteralPath 'D:\PYTHON\fadachi\reviews\codex-20261030').Path
$reviewCodex = (Get-Command codex -ErrorAction Stop).Source
$reviewReport = Join-Path $reviewRunDir 'review_fix_report.md'
$reviewEvents = Join-Path $reviewRunDir 'events.jsonl'
$reviewErrors = Join-Path $reviewRunDir 'stderr.log'
$reviewPrompt = Get-Content -LiteralPath $reviewPromptFile -Raw -Encoding UTF8

if ([string]::IsNullOrWhiteSpace($reviewPrompt)) {
    throw 'Review prompt file is empty.'
}
if ((Test-Path -LiteralPath $reviewReport) -or
    (Test-Path -LiteralPath $reviewEvents) -or
    (Test-Path -LiteralPath $reviewErrors)) {
    throw 'Output files already exist in review run directory.'
}

$reviewArgs = @(
    'exec', '--cd', $reviewProject,
    '--sandbox', 'workspace-write',
    '--model', 'gpt-6.1-sol',
    '-c', 'model_reasoning_effort="high"',
    '--json', '--output-last-message', $reviewReport,
    '-'
)

$reviewSavedOutputEncoding = $OutputEncoding
$reviewSavedConsoleEncoding = [Console]::OutputEncoding
$reviewSavedErrorPreference = $ErrorActionPreference
try {
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $ErrorActionPreference = 'Continue'
    $reviewPrompt | & $reviewCodex @reviewArgs 2> $reviewErrors |
        Out-File -LiteralPath $reviewEvents -Encoding UTF8 -ErrorAction Stop
    $reviewCodexExit = $LASTEXITCODE
}
finally {
    $OutputEncoding = $reviewSavedOutputEncoding
    [Console]::OutputEncoding = $reviewSavedConsoleEncoding
    $ErrorActionPreference = $reviewSavedErrorPreference
}

if ($reviewCodexExit -ne 0) {
    throw "Codex exited with code $reviewCodexExit. Check $reviewErrors and $reviewEvents."
}
if (-not (Test-Path -LiteralPath $reviewReport -PathType Leaf)) {
    throw 'Codex report was not created.'
}
Write-Output "Codex review finished successfully."
