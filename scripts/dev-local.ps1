$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $PSScriptRoot 'livekit-local.ps1') up
try {
  Set-Location -LiteralPath $repositoryRoot
  node server/index.js
} finally {
  & (Join-Path $PSScriptRoot 'livekit-local.ps1') down
}
