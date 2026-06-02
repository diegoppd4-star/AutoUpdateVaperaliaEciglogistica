param(
  [Parameter(Mandatory=$true)]
  [string]$PipelineWorkDir
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
$outputsDir = Join-Path $workDir "outputs"
$preparedDir = Join-Path $outputsDir "prepared"
$scriptsDir = Join-Path $workDir "scripts"

$required = @(
  (Join-Path $scriptsDir "build-dataset-manifest.js"),
  (Join-Path $scriptsDir "build-general-dataset.js"),
  (Join-Path $outputsDir "general.matches.valid.json"),
  (Join-Path $preparedDir "eciglogistica__output.base.csv"),
  (Join-Path $preparedDir "eciglogistica__output.variants.csv"),
  (Join-Path $preparedDir "vaperalia__output.base.csv"),
  (Join-Path $preparedDir "vaperalia__output.variants.csv")
)

foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Falta archivo requerido: $file"
  }
}

New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sacredRoot "05_MASTER_BDD\scripts\build-master-seed-jsons.js") -Destination $scriptsDir -Force

$node = "node"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (Test-Path -LiteralPath $bundledNode) {
  $node = $bundledNode
}

Push-Location $workDir
try {
  Invoke-Native $node scripts\build-dataset-manifest.js
  Invoke-Native $node scripts\build-general-dataset.js
  Invoke-Native $node scripts\build-master-seed-jsons.js `
    --general outputs\general.matches.valid.json `
    --ecig-base outputs\prepared\eciglogistica__output.base.csv `
    --ecig-variants outputs\prepared\eciglogistica__output.variants.csv `
    --vaperalia-base outputs\prepared\vaperalia__output.base.csv `
    --vaperalia-variants outputs\prepared\vaperalia__output.variants.csv `
    --out-dir outputs\master-json
} finally {
  Pop-Location
}

Write-Host "PIPELINE_5_WORKDIR=$workDir"
Write-Host "MASTER_MATCHED_BOTH_JSON=$(Join-Path $outputsDir 'master-json\master_matched_both.json')"
Write-Host "MASTER_ONLY_ECIGLOGISTICA_JSON=$(Join-Path $outputsDir 'master-json\master_only_eciglogistica.json')"
Write-Host "MASTER_ONLY_VAPERALIA_JSON=$(Join-Path $outputsDir 'master-json\master_only_vaperalia.json')"
