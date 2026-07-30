param([ValidateSet('up', 'down', 'logs')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDirectory = Join-Path $repositoryRoot '.local-runtime\livekit'
$pidPath = Join-Path $runtimeDirectory 'livekit.pid'
$logPath = Join-Path $runtimeDirectory 'livekit.log'
$binaryPath = Join-Path $repositoryRoot '.tools\livekit\livekit-server.exe'
$configPath = Join-Path $repositoryRoot 'livekit.local.yaml'
$docker = Get-Command docker -ErrorAction SilentlyContinue

function Get-NativeProcess {
  if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
  $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
  return Get-Process -Id $processId -ErrorAction SilentlyContinue
}

if ($Action -eq 'down') {
  $native = Get-NativeProcess
  if ($native) { Stop-Process -Id $native.Id; $native.WaitForExit(5000) }
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
  if ($docker) { & docker compose -f (Join-Path $repositoryRoot 'docker-compose.livekit.yml') down }
  Write-Host 'LiveKit local detenido.'
  exit 0
}

if ($Action -eq 'logs') {
  if ($docker -and -not (Get-NativeProcess)) { & docker compose -f (Join-Path $repositoryRoot 'docker-compose.livekit.yml') logs --tail 100 -f; exit $LASTEXITCODE }
  if (-not (Test-Path -LiteralPath $logPath)) { throw 'Aún no existe un registro local de LiveKit.' }
  Get-Content -LiteralPath $logPath -Tail 100 -Wait
  exit 0
}

if (Get-NativeProcess) { Write-Host 'LiveKit local ya está ejecutándose.'; exit 0 }
if ($docker) {
  & docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    & docker compose -f (Join-Path $repositoryRoot 'docker-compose.livekit.yml') up -d
    if ($LASTEXITCODE -ne 0) { throw 'Docker no pudo iniciar LiveKit local.' }
    Write-Host 'LiveKit local iniciado mediante Docker.'
    exit 0
  }
}
if (-not (Test-Path -LiteralPath $binaryPath)) { throw 'Docker no está disponible y falta el binario local. Ejecuta: npm run livekit:install' }
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$configArgument = '--config="{0}"' -f $configPath
$process = Start-Process -FilePath $binaryPath -ArgumentList @($configArgument, '--bind=0.0.0.0') -WorkingDirectory $repositoryRoot -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $runtimeDirectory 'livekit-error.log') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
Start-Sleep -Milliseconds 800
if ($process.HasExited) { throw "LiveKit terminó al iniciar. Revisa $logPath" }
Write-Host "LiveKit local iniciado con el binario oficial (PID $($process.Id))."
