param(
  [string]$InputJson = "",
  [string]$ScraperCommand = "",
  [string]$ScraperOutputJson = "",
  [string]$OutputRoot = "",
  [string]$RunName = "",
  [int]$CodexBatchSize = 20,
  [string]$CodexModel = "",
  [switch]$SkipCodexExec,
  [switch]$DryRun,
  [switch]$KeepTempWorkDir
)

$ErrorActionPreference = "Stop"

function Resolve-Node {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode) {
    return $bundledNode
  }
  return "node"
}

function New-SafeRunName {
  param([string]$Name)
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  if (-not $Name) {
    return "autoupdate-$stamp"
  }
  $safe = ($Name.ToLowerInvariant() -replace "[^a-z0-9_-]+", "-").Trim("-")
  if (-not $safe) {
    $safe = "autoupdate"
  }
  return "$stamp-$safe"
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Script
  )
  Write-Host ""
  Write-Host "== $Name =="
  & $Script
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pipelineRoot = Join-Path $root "pipeline_sagrado\PIPELINE SAGRADO"
$toolsRoot = Join-Path $root "tools"
$node = Resolve-Node

if (-not (Test-Path -LiteralPath $pipelineRoot)) {
  throw "No se encuentra Pipeline Sagrado autocontenido: $pipelineRoot"
}

if (-not $OutputRoot) {
  $OutputRoot = Join-Path $root "runs"
}

$runDir = Join-Path $OutputRoot (New-SafeRunName -Name $RunName)
if (Test-Path -LiteralPath $runDir) {
  throw "RunDir ya existe: $runDir"
}

$inputDir = Join-Path $runDir "input"
$logsDir = Join-Path $runDir "logs"
$pipelineWorkDir = Join-Path $runDir "pipeline-work"
New-Item -ItemType Directory -Path $inputDir -Force | Out-Null
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$transcriptPath = Join-Path $logsDir "run.log"
Start-Transcript -Path $transcriptPath -Force | Out-Null

try {
  Write-Host "AutoUpdateVaperaliaEciglogistica"
  Write-Host "RunDir: $runDir"
  Write-Host "Node: $node"
  Write-Host "Pipeline: $pipelineRoot"

  $scrapeJson = Join-Path $inputDir "scrape.json"

  Invoke-Step "Entrada de scrapeo" {
    if ($InputJson) {
      $resolvedInput = (Resolve-Path -LiteralPath $InputJson).Path
      Copy-Item -LiteralPath $resolvedInput -Destination $scrapeJson -Force
      Write-Host "Usando JSON ya scrapeado: $resolvedInput"
    } elseif ($ScraperCommand) {
      if ($ScraperOutputJson) {
        $scrapeJson = $ScraperOutputJson
      }
      $env:AUTOUPDATE_SCRAPE_OUTPUT_JSON = $scrapeJson
      $env:AUTOUPDATE_RUN_DIR = $runDir
      Write-Host "Ejecutando scraper externo."
      Write-Host "AUTOUPDATE_SCRAPE_OUTPUT_JSON=$env:AUTOUPDATE_SCRAPE_OUTPUT_JSON"
      powershell -NoProfile -ExecutionPolicy Bypass -Command $ScraperCommand
      if ($LASTEXITCODE -ne 0) {
        throw "El scraper externo termino con codigo $LASTEXITCODE"
      }
      if (-not (Test-Path -LiteralPath $scrapeJson)) {
        throw "El scraper externo no genero el JSON esperado: $scrapeJson"
      }
    } else {
      throw @"
No hay entrada de scrapeo.

Este repositorio contiene el Pipeline Sagrado y el contrato del scraper, pero no contiene el ejecutable real del scraper de Eciglogistica/Vaperalia.

Usa una de estas opciones:

1. Pasar un JSON ya scrapeado:
   -InputJson "C:\ruta\output.json"

2. Pasar un comando de scraper externo que escriba en la ruta indicada por la variable:
   `$env:AUTOUPDATE_SCRAPE_OUTPUT_JSON

Ejemplo:
   -ScraperCommand "cd C:\ruta\scraper; npm start -- --connector all --full-refresh --out `$env:AUTOUPDATE_SCRAPE_OUTPUT_JSON"
"@
    }
    Write-Host "Scrape JSON de trabajo: $scrapeJson"
  }

  Invoke-Step "Validacion de contrato del scrapeo" {
    $validationReport = Join-Path $runDir "validation-report.json"
    & $node (Join-Path $toolsRoot "validate-scrape-contract.js") --input $scrapeJson --out $validationReport
    if ($LASTEXITCODE -ne 0) {
      throw "El JSON de scrapeo no cumple contrato minimo. Ver: $validationReport"
    }
    Write-Host "Contrato OK: $validationReport"
  }

  if ($DryRun) {
    Write-Host ""
    Write-Host "DryRun activo: se ha validado la entrada, no se ejecutan los pipelines."
    $summary = [ordered]@{
      generatedAt = (Get-Date).ToUniversalTime().ToString("o")
      mode = "dry-run"
      runDir = $runDir
      scrapeJson = $scrapeJson
      validationReport = (Join-Path $runDir "validation-report.json")
      pipelineWorkDir = $pipelineWorkDir
      codexExec = -not $SkipCodexExec
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDir "run-summary.json") -Encoding UTF8
    return
  }

  Invoke-Step "Pipeline 1 - matching determinista principal" {
    & (Join-Path $pipelineRoot "run_pipeline_1_principal.ps1") -InputJson $scrapeJson -WorkDir $pipelineWorkDir
    if ($LASTEXITCODE -ne 0) {
      throw "Pipeline 1 fallo con codigo $LASTEXITCODE"
    }
  }

  Invoke-Step "Pipeline 2 - rescate determinista por descripcion" {
    & (Join-Path $pipelineRoot "run_pipeline_2_rescate_descripcion.ps1") -Pipeline1WorkDir $pipelineWorkDir
    if ($LASTEXITCODE -ne 0) {
      throw "Pipeline 2 fallo con codigo $LASTEXITCODE"
    }
  }

  if ($SkipCodexExec) {
    Write-Host ""
    Write-Host "SkipCodexExec activo: no se ejecuta la capa IA no determinista."
  } else {
    Invoke-Step "Pipeline 3 - capa IA no determinista con CodexExec" {
      $args = @(
        "-PipelineWorkDir", $pipelineWorkDir,
        "-OriginalScrapeJson", $scrapeJson,
        "-BatchSize", "$CodexBatchSize"
      )
      if ($CodexModel) {
        $args += @("-CodexModel", $CodexModel)
      }
      & (Join-Path $pipelineRoot "run_pipeline_3_ia_no_determinista.ps1") @args
      if ($LASTEXITCODE -ne 0) {
        throw "Pipeline 3 fallo con codigo $LASTEXITCODE"
      }
    }
  }

  Invoke-Step "Resumen de ejecucion" {
    $outputsDir = Join-Path $pipelineWorkDir "outputs"
    $summary = [ordered]@{
      generatedAt = (Get-Date).ToUniversalTime().ToString("o")
      mode = "completed"
      runDir = $runDir
      scrapeJson = $scrapeJson
      validationReport = (Join-Path $runDir "validation-report.json")
      pipelineWorkDir = $pipelineWorkDir
      outputsDir = $outputsDir
      generalMatches = (Join-Path $outputsDir "general.matches.valid.json")
      descriptionRescueCandidates = (Join-Path $outputsDir "description-rescue-candidates.matches.valid.json")
      reviewedRescues = if ($SkipCodexExec) { $null } else { Join-Path $outputsDir "reviewed-rescues.matches.valid.json" }
      reviewedRescuesAudit = if ($SkipCodexExec) { $null } else { Join-Path $outputsDir "audits\reviewed-rescues.audit.md" }
      codexDecisionLedger = if ($SkipCodexExec) { $null } else { Join-Path $outputsDir "reviews\description-rescue-decisions.json" }
      log = $transcriptPath
    }
    $summaryPath = Join-Path $runDir "run-summary.json"
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
    Write-Host "Resumen: $summaryPath"
    Write-Host "General: $($summary.generalMatches)"
    Write-Host "Rescate descripcion: $($summary.descriptionRescueCandidates)"
    if (-not $SkipCodexExec) {
      Write-Host "IA reviewed-rescues: $($summary.reviewedRescues)"
      Write-Host "Ledger CodexExec: $($summary.codexDecisionLedger)"
    }
  }
} finally {
  Stop-Transcript | Out-Null
}
