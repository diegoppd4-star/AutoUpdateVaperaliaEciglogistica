param(
  [Parameter(Mandatory=$true)]
  [string]$Pipeline1WorkDir
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
$workDir = (Resolve-Path -LiteralPath $Pipeline1WorkDir).Path

$required = @(
  "outputs\general.matches.valid.json",
  "outputs\prepared\eciglogistica__output.base.csv",
  "outputs\prepared\vaperalia__output.base.csv",
  "outputs\prepared\eciglogistica__output.variants.csv",
  "outputs\prepared\vaperalia__output.variants.csv"
)

foreach ($file in $required) {
  $full = Join-Path $workDir $file
  if (-not (Test-Path -LiteralPath $full)) {
    throw "Falta archivo requerido: $full"
  }
}

Copy-Item -Path (Join-Path $sacredRoot "02_PIPELINE_RESCATE_DESCRIPCION\scripts\*") -Destination (Join-Path $workDir "scripts") -Force

$node = "node"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
  $node = $bundledNode
}

Push-Location $workDir
try {
  Invoke-Native $node scripts\rescue-orphans-by-description.js --general outputs\general.matches.valid.json --a-base outputs\prepared\eciglogistica__output.base.csv --b-base outputs\prepared\vaperalia__output.base.csv --a-variants outputs\prepared\eciglogistica__output.variants.csv --b-variants outputs\prepared\vaperalia__output.variants.csv
  Invoke-Native $node scripts\build-dataset-manifest.js
} finally {
  Pop-Location
}

Write-Host "PIPELINE_2_WORKDIR=$workDir"
Write-Host "RESCUE_JSON=$(Join-Path $workDir 'outputs\description-rescue-candidates.matches.valid.json')"
Write-Host "RESCUE_AUDIT_MD=$(Join-Path $workDir 'outputs\audits\description-rescue-candidates.audit.md')"
