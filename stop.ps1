$ErrorActionPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $projectRoot 'data\server.pid'
$portFile = Join-Path $projectRoot 'data\server.port'

if (Test-Path -LiteralPath $pidFile) {
  $serverPid = [int]([IO.File]::ReadAllText($pidFile, [Text.Encoding]::ASCII).Trim())
  $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
  if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine -match 'server\.js') {
    Stop-Process -Id $serverPid
  }
  Remove-Item -LiteralPath $pidFile -Force
}

Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
