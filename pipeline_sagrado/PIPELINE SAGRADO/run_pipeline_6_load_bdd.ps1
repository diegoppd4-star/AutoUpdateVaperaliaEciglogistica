param(
  [Parameter(Mandatory=$true)]
  [string]$PipelineWorkDir,

  [switch]$DryRun,

  [switch]$SkipEanEnrichment,

  [int]$BatchSize = 1000
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

function Resolve-Python {
  $candidates = @("python3", "python")
  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }
  throw "No se encontro python3/python para ejecutar SQLLoader."
}

$sacredRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workDir = (Resolve-Path -LiteralPath $PipelineWorkDir).Path
$outputsDir = Join-Path $workDir "outputs"
$masterDir = Join-Path $outputsDir "master-json"
$preparedDir = Join-Path $outputsDir "prepared"
$loaderSourceRoot = Join-Path $sacredRoot "06_CARGA_BDD\SQLLoader"
$loaderRoot = Join-Path $workDir "sql-loader"
$inputMaster = Join-Path $loaderRoot "input_master"
$inputPrepared = Join-Path $inputMaster "prepared"

$required = @(
  (Join-Path $masterDir "master_matched_both.json"),
  (Join-Path $masterDir "master_only_eciglogistica.json"),
  (Join-Path $masterDir "master_only_vaperalia.json"),
  (Join-Path $preparedDir "vaperalia__output.variants.csv"),
  (Join-Path $loaderSourceRoot "scripts\load_master_to_postgres.py")
)

foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Falta archivo requerido: $file"
  }
}

if (Test-Path -LiteralPath $loaderRoot) {
  Remove-Item -LiteralPath $loaderRoot -Recurse -Force
}
Copy-Item -LiteralPath $loaderSourceRoot -Destination $loaderRoot -Recurse -Force
if (Test-Path -LiteralPath $inputMaster) {
  Remove-Item -LiteralPath $inputMaster -Recurse -Force
}
New-Item -ItemType Directory -Path $inputPrepared -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $masterDir "master_matched_both.json") -Destination $inputMaster -Force
Copy-Item -LiteralPath (Join-Path $masterDir "master_only_eciglogistica.json") -Destination $inputMaster -Force
Copy-Item -LiteralPath (Join-Path $masterDir "master_only_vaperalia.json") -Destination $inputMaster -Force
Copy-Item -LiteralPath (Join-Path $preparedDir "vaperalia__output.variants.csv") -Destination $inputPrepared -Force

$python = Resolve-Python
$loaderArgs = @(
  "scripts\load_master_to_postgres.py",
  "--batch-size", "$BatchSize"
)
if ($DryRun) {
  $loaderArgs += "--dry-run"
}
if ($SkipEanEnrichment) {
  $loaderArgs += "--skip-ean-enrichment"
}

Push-Location $loaderRoot
try {
  Invoke-Native $python @loaderArgs
} finally {
  Pop-Location
}

Write-Host "PIPELINE_6_WORKDIR=$workDir"
Write-Host "SQLLOADER_DIR=$loaderRoot"
Write-Host "SQLLOADER_REPORT_JSON=$(Join-Path $loaderRoot 'run_output\sql-loader-report.json')"
