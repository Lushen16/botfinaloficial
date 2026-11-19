# Launcher de missão Codex — árvore oficial
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File tools\codex_pka.ps1 -Mission docs\MISSOES\F2-A-passo-caminhada.md
#   powershell -ExecutionPolicy Bypass -File tools\codex_pka.ps1 -Mission docs\MISSOES\X.md -Sandbox read-only
#
# Aplica o perfil `pka` (~/.codex/pka.config.toml), fixa a raiz do projeto,
# recusa rodar sem missão existente e grava transcrição + último veredito.
# Não commita nada.

param(
  [Parameter(Mandatory = $true)]
  [string]$Mission,
  [ValidateSet('read-only', 'workspace-write')]
  [string]$Sandbox = 'workspace-write',
  [string]$Model,
  [switch]$NoLog
)

$ErrorActionPreference = 'Stop'

# O sandbox do Codex filtra o PATH do shell filho: sem isso, node e python
# somem e as missoes falham por ferramenta ausente (medido no smoke de
# 2026-11-18). Prepende os diretorios das ferramentas usadas pelas missoes.
foreach ($tool in @('node', 'python')) {
  $hit = Get-Command $tool -ErrorAction SilentlyContinue
  if ($hit -and $hit.Source) {
    $dir = Split-Path -Parent $hit.Source
    if ($env:PATH -notlike "*$dir*") { $env:PATH = "$dir;$env:PATH" }
  }
}

$root = Split-Path -Parent $PSScriptRoot
$missionPath = if ([System.IO.Path]::IsPathRooted($Mission)) { $Mission } else { Join-Path $root $Mission }
if (-not (Test-Path -LiteralPath $missionPath)) {
  throw "Missao nao encontrada: $missionPath"
}
$mission = Get-Content -Raw -LiteralPath $missionPath
if (-not $mission.Trim()) { throw "Missao vazia: $missionPath" }

$codexExe = $env:CODEX_CLI_PATH
if (-not $codexExe -or -not (Test-Path -LiteralPath $codexExe)) {
  $codexExe = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\app\resources\codex.exe'
}
if (-not (Test-Path -LiteralPath $codexExe)) { throw "codex.exe nao encontrado; defina CODEX_CLI_PATH." }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
$slug = [System.IO.Path]::GetFileNameWithoutExtension($missionPath) -replace '[^A-Za-z0-9_.-]', '-'
$outDir = Join-Path $root 'local-data\codex'
$log = Join-Path $outDir "$stamp-$slug.log"
$verdict = Join-Path $outDir "$stamp-$slug.verdict.md"

$codexArgs = @('exec', '-p', 'pka', '--strict-config', '-C', $root, '-s', $Sandbox,
  '--color', 'never', '--skip-git-repo-check', '-o', $verdict)
if ($Model) { $codexArgs += @('-m', $Model) }

Write-Host "[codex_pka] missao: $missionPath"
Write-Host "[codex_pka] sandbox: $Sandbox | perfil pka | raiz: $root"
Write-Host "[codex_pka] iniciando; nada sera commitado."

if ($mission.Length -gt 28000) {
  throw 'Missao longa demais para argumento; divida abaixo de 28k caracteres.'
}

$ErrorActionPreference = 'Continue'

if ($NoLog) {
  & $codexExe @codexArgs $mission
} else {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  & $codexExe @codexArgs $mission 2>&1 | Tee-Object -FilePath $log
}
$code = $LASTEXITCODE

Write-Host "[codex_pka] exit=$code"
if (-not $NoLog) {
  Write-Host "[codex_pka] log: $log"
  if (Test-Path -LiteralPath $verdict) { Write-Host "[codex_pka] veredito: $verdict" }
}
exit $code
