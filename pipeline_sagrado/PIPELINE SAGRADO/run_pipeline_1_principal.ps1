param(
  [Parameter(Mandatory=$true)]
  [string]$InputJson,

  [string]$WorkDir = ""
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
if (-not $WorkDir) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $WorkDir = Join-Path $env:TEMP "pipeline-sagrado-principal-$stamp"
}

if (Test-Path -LiteralPath $WorkDir) {
  throw "WorkDir ya existe. Usa una carpeta nueva para evitar pisar resultados: $WorkDir"
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
Copy-Item -Path (Join-Path $sacredRoot "01_PIPELINE_PRINCIPAL\scripts") -Destination $WorkDir -Recurse -Force
Copy-Item -Path (Join-Path $sacredRoot "03_INPUTS") -Destination (Join-Path $WorkDir "inputs") -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $WorkDir "outputs\prepared") -Force | Out-Null

$node = "node"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
  $node = $bundledNode
}

Push-Location $WorkDir
try {
  Invoke-Native $node scripts\prepare-products-json.js --in $InputJson --distributor Eciglogistica --base-out outputs\prepared\eciglogistica__output.base.csv --variants-out outputs\prepared\eciglogistica__output.variants.csv
  Invoke-Native $node scripts\prepare-products-json.js --in $InputJson --distributor Vaperalia --base-out outputs\prepared\vaperalia__output.base.csv --variants-out outputs\prepared\vaperalia__output.variants.csv
  Invoke-Native $node scripts\run-fuzzy-hardware-tramos.js --tramos-file inputs\tramos_full_2026-05-14.txt
  Invoke-Native $node scripts\build-inverse-vaperalia-audit.js
  Invoke-Native $node scripts\build-catalog-filtered-unmatched.js
  Invoke-Native $node scripts\build-dataset-manifest.js
  Invoke-Native $node scripts\build-general-dataset.js
} finally {
  Pop-Location
}

Write-Host "PIPELINE_1_WORKDIR=$WorkDir"
Write-Host "GENERAL_JSON=$(Join-Path $WorkDir 'outputs\general.matches.valid.json')"
