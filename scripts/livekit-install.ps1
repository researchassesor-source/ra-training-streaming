$ErrorActionPreference = 'Stop'
$version = '1.13.1'
$expectedSha256 = '57afee4cdb044e5fda04c2cc00ca30f4c783bea1f1ea2f483321ce4b9cff4acf'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsDirectory = Join-Path $repositoryRoot '.tools\livekit'
$archivePath = Join-Path $toolsDirectory "livekit_$($version)_windows_amd64.zip"
$downloadUrl = "https://github.com/livekit/livekit/releases/download/v$version/livekit_$($version)_windows_amd64.zip"

New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
Write-Host "Descargando LiveKit Server v$version desde la versión oficial..."
$client = New-Object System.Net.WebClient
$client.Headers.Add('User-Agent', 'R.A.-Training-Local-QA')
$client.DownloadFile($downloadUrl, $archivePath)
$actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  Remove-Item -LiteralPath $archivePath -Force
  throw "La suma SHA-256 no coincide. Esperada: $expectedSha256; recibida: $actualSha256"
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsDirectory -Force
Remove-Item -LiteralPath $archivePath -Force
$binary = Get-ChildItem -LiteralPath $toolsDirectory -Recurse -Filter 'livekit-server.exe' | Select-Object -First 1
if (-not $binary) { throw 'El archivo oficial no contenía livekit-server.exe.' }
if ($binary.DirectoryName -ne $toolsDirectory) { Copy-Item -LiteralPath $binary.FullName -Destination (Join-Path $toolsDirectory 'livekit-server.exe') -Force }
Write-Host "LiveKit Server v$version instalado localmente en $toolsDirectory"
