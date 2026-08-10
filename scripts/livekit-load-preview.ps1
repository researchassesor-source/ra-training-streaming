[CmdletBinding()]
param(
  [ValidateSet(25, 50, 100, 250, 500, 750, 1000)]
  [int]$Subscribers = 25,
  [ValidateRange(1, 20)]
  [int]$VideoPublishers = 3,
  [ValidateRange(0, 20)]
  [int]$AudioPublishers = 1,
  [ValidateRange(30, 3600)]
  [int]$DurationSeconds = 60,
  [string]$Room = "ra-preview-load",
  [switch]$Execute,
  [switch]$ApproveHighCost
)

$ErrorActionPreference = "Stop"
$allowedCounts = @(25, 50, 100, 250, 500, 750, 1000)
if ($Subscribers -notin $allowedCounts) { throw "Cantidad de suscriptores fuera del plan aprobado." }
if ($Room -notmatch '^[a-zA-Z0-9_-]{3,80}$') { throw "El nombre de sala no es válido." }

$estimatedParticipantMinutes = [math]::Ceiling((($Subscribers + $VideoPublishers + $AudioPublishers) * $DurationSeconds) / 60)
$summary = [ordered]@{
  mode = if ($Execute) { "execute" } else { "dry-run" }
  subscribers = $Subscribers
  videoPublishers = $VideoPublishers
  audioPublishers = $AudioPublishers
  durationSeconds = $DurationSeconds
  estimatedParticipantMinutes = $estimatedParticipantMinutes
  productionAllowed = $false
}
$summary | ConvertTo-Json

if (-not $Execute) {
  Write-Host "Simulación únicamente. Para ejecutar se exige Preview aislado, host permitido y confirmación explícita de costo."
  exit 0
}

if ($env:APP_ENV -ne "preview") { throw "La carga solo puede ejecutarse con APP_ENV=preview." }
if ($env:LOAD_TEST_PREVIEW_ACK -ne "I_ACKNOWLEDGE_PREVIEW_LOAD") { throw "Falta LOAD_TEST_PREVIEW_ACK para el entorno Preview aislado." }
if (-not $env:LIVEKIT_URL -or -not $env:LIVEKIT_API_KEY -or -not $env:LIVEKIT_API_SECRET) { throw "Falta configuración de LiveKit Preview." }
if (-not $env:LOAD_TEST_ALLOWED_HOST) { throw "Falta LOAD_TEST_ALLOWED_HOST." }
$livekitUri = [Uri]$env:LIVEKIT_URL
if ($livekitUri.Scheme -ne "wss") { throw "LiveKit debe usar WSS." }
if ($livekitUri.Host -ne $env:LOAD_TEST_ALLOWED_HOST) { throw "El host LiveKit no coincide con el host Preview autorizado." }
if ($Subscribers -ge 100 -and -not $ApproveHighCost) { throw "Las etapas de 100 o más suscriptores requieren -ApproveHighCost después de revisar límites y costo." }

$lk = Get-Command lk -ErrorAction SilentlyContinue
if (-not $lk) { throw "No se encontró LiveKit CLI (lk). Instálalo desde la distribución oficial antes de ejecutar." }

$repoRoot = Split-Path -Parent $PSScriptRoot
$reportDir = Join-Path $repoRoot ".local-runtime\load-tests"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $reportDir "livekit-$Subscribers-$stamp.log"

& $lk.Source load-test --room $Room --duration "$($DurationSeconds)s" --video-publishers $VideoPublishers --audio-publishers $AudioPublishers --subscribers $Subscribers 2>&1 |
  Tee-Object -FilePath $reportPath
if ($LASTEXITCODE -ne 0) { throw "LiveKit CLI terminó con código $LASTEXITCODE. Revisa el informe local redactado." }
Write-Host "Informe guardado localmente en $reportPath"
