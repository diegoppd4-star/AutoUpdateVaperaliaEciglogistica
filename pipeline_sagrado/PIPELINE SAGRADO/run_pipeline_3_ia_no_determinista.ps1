param(
  [Parameter(Mandatory=$true)]
  [string]$PipelineWorkDir,

  [Parameter(Mandatory=$true)]
  [string]$OriginalScrapeJson,

  [int]$BatchSize = 25,

  [string]$CodexModel = "",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
function Invoke-Native {
  param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Comando fallido ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
  }
}

$sacredRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workDir = (Resolve-Path -LiteralPath $PipelineWorkDir).Path
$originalScrape = (Resolve-Path -LiteralPath $OriginalScrapeJson).Path

$required = @(
  "outputs\description-rescue-candidates.matches.valid.json",
  "outputs\audits\description-rescue-candidates.audit.md",
  "outputs\prepared\eciglogistica__output.variants.csv",
  "outputs\prepared\vaperalia__output.variants.csv"
)

foreach ($file in $required) {
  $full = Join-Path $workDir $file
  if (-not (Test-Path -LiteralPath $full)) {
    throw "Falta archivo requerido: $full"
  }
}

$scriptsDir = Join-Path $workDir "scripts"
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
Copy-Item -Path (Join-Path $sacredRoot "04_ANEXO_CAPA_IA_NO_DETERMINISTA\generate-description-rescue-decisions-codexexec.js") -Destination (Join-Path $workDir "scripts") -Force
Copy-Item -Path (Join-Path $sacredRoot "04_ANEXO_CAPA_IA_NO_DETERMINISTA\build-reviewed-rescue-layer.js") -Destination (Join-Path $workDir "scripts") -Force

$node = "node"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
  $node = $bundledNode
}

Push-Location $workDir
try {
  $generateArgs = @(
    "scripts\generate-description-rescue-decisions-codexexec.js",
    "--rescue", "outputs\description-rescue-candidates.matches.valid.json",
    "--rescue-audit", "outputs\audits\description-rescue-candidates.audit.md",
    "--original-scrape", $originalScrape,
    "--out", "outputs\reviews\description-rescue-decisions.json",
    "--prompt-out", "outputs\reviews\description-rescue-codexexec-prompt.json",
    "--batch-size", "$BatchSize"
  )
  if ($CodexModel) {
    $generateArgs += @("--model", $CodexModel)
  }
  if ($DryRun) {
    $generateArgs += "--dry-run"
  }

  Invoke-Native $node @generateArgs

  if (-not $DryRun) {
    Invoke-Native $node scripts\build-reviewed-rescue-layer.js --rescue outputs\description-rescue-candidates.matches.valid.json --decisions outputs\reviews\description-rescue-decisions.json --a-variants outputs\prepared\eciglogistica__output.variants.csv --b-variants outputs\prepared\vaperalia__output.variants.csv --out outputs\reviewed-rescues.matches.valid.json --audit-md outputs\audits\reviewed-rescues.audit.md
    if (Test-Path -LiteralPath "scripts\build-dataset-manifest.js") {
      Invoke-Native $node scripts\build-dataset-manifest.js
    }
  }
} finally {
  Pop-Location
}

Write-Host "PIPELINE_3_WORKDIR=$workDir"
Write-Host "RESCUE_DECISIONS_JSON=$(Join-Path $workDir 'outputs\reviews\description-rescue-decisions.json')"
Write-Host "REVIEWED_RESCUES_JSON=$(Join-Path $workDir 'outputs\reviewed-rescues.matches.valid.json')"
Write-Host "REVIEWED_RESCUES_AUDIT_MD=$(Join-Path $workDir 'outputs\audits\reviewed-rescues.audit.md')"
