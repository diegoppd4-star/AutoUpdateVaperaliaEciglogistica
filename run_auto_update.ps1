param(
  [string]$InputJson = "",
  [string]$ScraperCommand = "",
  [string]$ScraperOutputJson = "",
  [string]$ScraperConnector = "all",
  [int]$ScraperLimit = 0,
  [int]$ScraperConcurrency = 5,
  [string]$ScraperCategories = "",
  [string]$ScraperKnownUrls = "",
  [switch]$ScraperDebug,
  [switch]$SkipScraperInstall,
  [switch]$SkipPlaywrightInstall,
  [switch]$SkipPortableNodeDownload,
  [string]$OutputRoot = "",
  [string]$RunName = "",
  [int]$CodexBatchSize = 20,
  [string]$CodexModel = "",
  [switch]$SkipCodexExec,
  [switch]$DryRun,
  [switch]$KeepTempWorkDir
)

$ErrorActionPreference = "Stop"

function Get-PortableNodeRoot {
  param([string]$RepoRoot)
  $runtimeRoot = Join-Path $RepoRoot ".runtime"
  if (-not (Test-Path -LiteralPath $runtimeRoot)) {
    return $null
  }
  $candidate = Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter "node-v*-win-x64" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate.FullName "node.exe"))) {
    return $candidate.FullName
  }
  return $null
}

function Install-PortableNode {
  param([string]$RepoRoot)

  if ($SkipPortableNodeDownload) {
    throw "No se encontro npm y SkipPortableNodeDownload esta activo. Instala Node.js/npm o desactiva ese flag."
  }
  if (-not $IsWindows) {
    throw "No se encontro npm. En Linux/Docker instala Node.js/npm en la imagen; la descarga portable automatica solo esta preparada para Windows."
  }

  $version = "v22.11.0"
  $archiveName = "node-$version-win-x64.zip"
  $runtimeRoot = Join-Path $RepoRoot ".runtime"
  $downloadDir = Join-Path $runtimeRoot "downloads"
  $archivePath = Join-Path $downloadDir $archiveName
  $nodeRoot = Join-Path $runtimeRoot "node-$version-win-x64"
  $url = "https://nodejs.org/dist/$version/$archiveName"

  if (Test-Path -LiteralPath (Join-Path $nodeRoot "npm.cmd")) {
    return $nodeRoot
  }

  New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
  Write-Host "Descargando Node portable $version para ejecutar el scraper..."
  Write-Host $url
  Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing

  if (Test-Path -LiteralPath $nodeRoot) {
    Remove-Item -LiteralPath $nodeRoot -Recurse -Force
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force

  if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot "npm.cmd"))) {
    throw "La instalacion portable de Node no contiene npm.cmd: $nodeRoot"
  }
  return $nodeRoot
}

function Resolve-Node {
  param([string]$RepoRoot)
  $portableRoot = Get-PortableNodeRoot -RepoRoot $RepoRoot
  if ($portableRoot) {
    return (Join-Path $portableRoot "node.exe")
  }

  if ($env:USERPROFILE) {
    $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
      return $bundledNode
    }
  }
  return "node"
}

function Resolve-Npm {
  param([string]$RepoRoot)
  $npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }
  $npm = Get-Command "npm" -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  $portableRoot = Get-PortableNodeRoot -RepoRoot $RepoRoot
  if (-not $portableRoot) {
    $portableRoot = Install-PortableNode -RepoRoot $RepoRoot
  }
  return (Join-Path $portableRoot "npm.cmd")
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )

  $previousLocation = $null
  if ($WorkingDirectory) {
    $previousLocation = Get-Location
    Set-Location -LiteralPath $WorkingDirectory
  }

  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Comando fallido ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
  } finally {
    if ($previousLocation) {
      Set-Location -LiteralPath $previousLocation.Path
    }
  }
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
$scraperRoot = Join-Path $root "scraper"
$toolsRoot = Join-Path $root "tools"
$node = Resolve-Node -RepoRoot $root

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
  Write-Host "Scraper integrado: $scraperRoot"

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
      $shell = Get-Command "powershell" -ErrorAction SilentlyContinue
      if (-not $shell) {
        $shell = Get-Command "pwsh" -ErrorAction SilentlyContinue
      }
      if (-not $shell) {
        throw "No se encontro powershell/pwsh para ejecutar ScraperCommand."
      }
      Invoke-NativeCommand -FilePath $shell.Source -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $ScraperCommand)
      if (-not (Test-Path -LiteralPath $scrapeJson)) {
        throw "El scraper externo no genero el JSON esperado: $scrapeJson"
      }
    } else {
      if (-not (Test-Path -LiteralPath $scraperRoot)) {
        throw "No se encuentra el scraper integrado: $scraperRoot"
      }

      $scraperOutputDir = Join-Path $runDir "scraper-output"
      $scraperDebugDir = Join-Path $runDir "scraper-debug"
      New-Item -ItemType Directory -Path $scraperOutputDir -Force | Out-Null

      Write-Host "Ejecutando scraper integrado."
      Write-Host "Connector: $ScraperConnector"
      Write-Host "Limit: $ScraperLimit"
      Write-Host "Concurrency: $ScraperConcurrency"
      if ($ScraperCategories) {
        Write-Host "Categories: $ScraperCategories"
      }
      if ($ScraperKnownUrls) {
        Write-Host "Known URLs backfill: $ScraperKnownUrls"
      }
      Write-Host "Scraper output: $scraperOutputDir"

      $npm = Resolve-Npm -RepoRoot $root
      $node = Resolve-Node -RepoRoot $root
      Write-Host "Node scraper: $node"
      Write-Host "Npm scraper: $npm"

      if (-not $SkipScraperInstall -and -not (Test-Path -LiteralPath (Join-Path $scraperRoot "node_modules"))) {
        Write-Host "Instalando dependencias del scraper con npm ci..."
        Invoke-NativeCommand -FilePath $npm -Arguments @("ci") -WorkingDirectory $scraperRoot
      }

      if (-not $SkipPlaywrightInstall) {
        Write-Host "Verificando navegador Playwright Chromium..."
        Invoke-NativeCommand -FilePath $npm -Arguments @("exec", "--", "playwright", "install", "chromium") -WorkingDirectory $scraperRoot
      }

      Invoke-NativeCommand -FilePath $npm -Arguments @("run", "build") -WorkingDirectory $scraperRoot

      $scraperArgs = @(
        "dist/index.js",
        "--connector", $ScraperConnector,
        "--concurrency", "$ScraperConcurrency",
        "--output-dir", $scraperOutputDir
      )
      if ($ScraperLimit -gt 0) {
        $scraperArgs += @("--limit", "$ScraperLimit")
      }
      if ($ScraperCategories) {
        $scraperArgs += @("--categories", $ScraperCategories)
      }
      if ($ScraperKnownUrls) {
        $scraperArgs += @("--known-urls", $ScraperKnownUrls)
      }
      if ($ScraperDebug) {
        $scraperArgs += @("--debug", "--debug-dir", $scraperDebugDir)
      }

      Invoke-NativeCommand -FilePath $node -Arguments $scraperArgs -WorkingDirectory $scraperRoot

      $generatedScrapeJson = Join-Path $scraperOutputDir "output.json"
      if (-not (Test-Path -LiteralPath $generatedScrapeJson)) {
        throw "El scraper integrado no genero el JSON esperado: $generatedScrapeJson"
      }
      Copy-Item -LiteralPath $generatedScrapeJson -Destination $scrapeJson -Force
      Write-Host "Scraper integrado completado: $generatedScrapeJson"
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
      reviewedRescuesAudit = if ($SkipCodexExec) { $null } else { Join-Path (Join-Path $outputsDir "audits") "reviewed-rescues.audit.md" }
      codexDecisionLedger = if ($SkipCodexExec) { $null } else { Join-Path (Join-Path $outputsDir "reviews") "description-rescue-decisions.json" }
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
