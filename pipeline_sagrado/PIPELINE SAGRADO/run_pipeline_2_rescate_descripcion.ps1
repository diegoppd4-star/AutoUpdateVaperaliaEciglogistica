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
  (Join-Path "outputs" "general.matches.valid.json"),
  (Join-Path (Join-Path "outputs" "prepared") "eciglogistica__output.base.csv"),
  (Join-Path (Join-Path "outputs" "prepared") "vaperalia__output.base.csv"),
  (Join-Path (Join-Path "outputs" "prepared") "eciglogistica__output.variants.csv"),
  (Join-Path (Join-Path "outputs" "prepared") "vaperalia__output.variants.csv")
)

foreach ($file in $required) {
  $full = Join-Path $workDir $file
  if (-not (Test-Path -LiteralPath $full)) {
    throw "Falta archivo requerido: $full"
  }
}

Copy-Item -Path (Join-Path (Join-Path (Join-Path $sacredRoot "02_PIPELINE_RESCATE_DESCRIPCION") "scripts") "*") -Destination (Join-Path $workDir "scripts") -Force

$node = "node"
if ($env:USERPROFILE) {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
  }
}

Push-Location $workDir
try {
  $scriptsDir = Join-Path $workDir "scripts"
  $outputsDir = Join-Path $workDir "outputs"
  $preparedDir = Join-Path $outputsDir "prepared"

  Invoke-Native $node (Join-Path $scriptsDir "rescue-orphans-by-description.js") --general (Join-Path $outputsDir "general.matches.valid.json") --a-base (Join-Path $preparedDir "eciglogistica__output.base.csv") --b-base (Join-Path $preparedDir "vaperalia__output.base.csv") --a-variants (Join-Path $preparedDir "eciglogistica__output.variants.csv") --b-variants (Join-Path $preparedDir "vaperalia__output.variants.csv")
  Invoke-Native $node (Join-Path $scriptsDir "build-dataset-manifest.js")
} finally {
  Pop-Location
}

Write-Host "PIPELINE_2_WORKDIR=$workDir"
Write-Host "RESCUE_JSON=$(Join-Path (Join-Path $workDir 'outputs') 'description-rescue-candidates.matches.valid.json')"
Write-Host "RESCUE_AUDIT_MD=$(Join-Path (Join-Path (Join-Path $workDir 'outputs') 'audits') 'description-rescue-candidates.audit.md')"
