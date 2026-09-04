$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$workspaceRoot = Split-Path -Parent $projectRoot
$pythonCandidates = @(
  (Join-Path $projectRoot '.venv\Scripts\python.exe'),
  (Join-Path $projectRoot 'env\Scripts\python.exe'),
  (Join-Path $workspaceRoot 'phishlens-ai\env\Scripts\python.exe')
)
$python = $pythonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $python) {
  $python = 'py'
}

if (-not $env:TESSERACT_CMD) {
  $env:TESSERACT_CMD = 'D:\Setup\Tesseract-OCR\tesseract.exe'
}

$serverScript = Join-Path $scriptDir 'ocr_server.py'

if ($python -eq 'py') {
  & py -3.12 $serverScript
} else {
  & $python $serverScript
}
