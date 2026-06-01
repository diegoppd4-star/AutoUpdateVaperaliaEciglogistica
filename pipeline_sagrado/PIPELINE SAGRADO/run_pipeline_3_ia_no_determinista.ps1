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
  (Join-Path "outputs" "description-rescue-candidates.matches.valid.json"),
  (Join-Path (Join-Path "outputs" "audits") "description-rescue-candidates.audit.md"),
  (Join-Path (Join-Path "outputs" "prepared") "eciglogistica__output.variants.csv"),
  (Join-Path (Join-Path "outputs" "prepared") "vaperalia__output.variants.csv")
)

foreach ($file in $required) {
  $full = Join-Path $workDir $file
  if (-not (Test-Path -LiteralPath $full)) {
    throw "Falta archivo requerido: $full"
  }
}

$scriptsDir = Join-Path $workDir "scripts"
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
$aiRoot = Join-Path $sacredRoot "04_ANEXO_CAPA_IA_NO_DETERMINISTA"
Copy-Item -Path (Join-Path $aiRoot "generate-description-rescue-decisions-codexexec.js") -Destination $scriptsDir -Force
Copy-Item -Path (Join-Path $aiRoot "build-reviewed-rescue-layer.js") -Destination $scriptsDir -Force

$node = "node"
if ($env:USERPROFILE) {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
  }
}

Push-Location $workDir
try {
  $outputsDir = Join-Path $workDir "outputs"
  $auditsDir = Join-Path $outputsDir "audits"
  $preparedDir = Join-Path $outputsDir "prepared"
  $reviewsDir = Join-Path $outputsDir "reviews"

  $generateArgs = @(
    (Join-Path $scriptsDir "generate-description-rescue-decisions-codexexec.js"),
    "--rescue", (Join-Path $outputsDir "description-rescue-candidates.matches.valid.json"),
    "--rescue-audit", (Join-Path $auditsDir "description-rescue-candidates.audit.md"),
    "--original-scrape", $originalScrape,
    "--out", (Join-Path $reviewsDir "description-rescue-decisions.json"),
    "--prompt-out", (Join-Path $reviewsDir "description-rescue-codexexec-prompt.json"),
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
    Invoke-Native $node (Join-Path $scriptsDir "build-reviewed-rescue-layer.js") --rescue (Join-Path $outputsDir "description-rescue-candidates.matches.valid.json") --decisions (Join-Path $reviewsDir "description-rescue-decisions.json") --a-variants (Join-Path $preparedDir "eciglogistica__output.variants.csv") --b-variants (Join-Path $preparedDir "vaperalia__output.variants.csv") --out (Join-Path $outputsDir "reviewed-rescues.matches.valid.json") --audit-md (Join-Path $auditsDir "reviewed-rescues.audit.md")
    if (Test-Path -LiteralPath (Join-Path $scriptsDir "build-dataset-manifest.js")) {
      Invoke-Native $node (Join-Path $scriptsDir "build-dataset-manifest.js")
    }
  }
} finally {
  Pop-Location
}

Write-Host "PIPELINE_3_WORKDIR=$workDir"
Write-Host "RESCUE_DECISIONS_JSON=$(Join-Path (Join-Path (Join-Path $workDir 'outputs') 'reviews') 'description-rescue-decisions.json')"
Write-Host "REVIEWED_RESCUES_JSON=$(Join-Path (Join-Path $workDir 'outputs') 'reviewed-rescues.matches.valid.json')"
Write-Host "REVIEWED_RESCUES_AUDIT_MD=$(Join-Path (Join-Path (Join-Path $workDir 'outputs') 'audits') 'reviewed-rescues.audit.md')"
