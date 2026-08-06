param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $projectRoot 'server.js'
$dataDirectory = Join-Path $projectRoot 'data'
$pidFile = Join-Path $dataDirectory 'server.pid'
$portFile = Join-Path $dataDirectory 'server.port'
$logFile = Join-Path $dataDirectory 'launcher.log'

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

function Write-LauncherLog([string]$message) {
  [IO.File]::AppendAllText($logFile, ((Get-Date).ToString('s') + ' ' + $message + [Environment]::NewLine), [Text.Encoding]::UTF8)
}

function Show-LauncherError([string]$message) {
  Write-LauncherLog ('ERROR ' + $message)
  if ($NoBrowser) {
    Write-Error $message
    return
  }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($message, 'Local Project Register', 'OK', 'Error') | Out-Null
}

function Test-ProjectServer([int]$port) {
  $response = $null
  $reader = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/health")
    $request.Proxy = $null
    $request.Timeout = 1500
    $request.ReadWriteTimeout = 1500
    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $json = $reader.ReadToEnd()
    $payload = $json | ConvertFrom-Json
    return $payload.service -eq 'local-project-manager' -and $payload.status -eq 'ok'
  } catch {
    return $false
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Dispose() }
  }
}

function Find-AvailablePort {
  foreach ($candidate in 4170..4180) {
    $listener = Get-NetTCPConnection -LocalPort $candidate -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) { return $candidate }
  }
  return 0
}

function Save-ServerIdentity([int]$port, [int]$processId) {
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  [IO.File]::WriteAllText($pidFile, [string]$processId, [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText($portFile, [string]$port, [Text.Encoding]::ASCII)
}

try {
  Write-LauncherLog 'START'
  $activePort = 0

  if (Test-Path -LiteralPath $portFile) {
    $savedPortText = [IO.File]::ReadAllText($portFile, [Text.Encoding]::ASCII).Trim()
    if ($savedPortText -match '^\d+$' -and (Test-ProjectServer ([int]$savedPortText))) {
      $activePort = [int]$savedPortText
      Write-LauncherLog ("REUSE SAVED PORT $activePort")
    }
  }

  if ($activePort -eq 0 -and (Test-ProjectServer 4170)) {
    $activePort = 4170
    Write-LauncherLog 'REUSE PORT 4170'
  }

  if ($activePort -gt 0) {
    $listener = Get-NetTCPConnection -LocalPort $activePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
      if ($listenerProcess.Name -eq 'node.exe' -and $listenerProcess.CommandLine -match 'server\.js') {
        Save-ServerIdentity $activePort $listener.OwningProcess
        Write-LauncherLog ("RECOVER PID $($listener.OwningProcess)")
      }
    }
  } else {
    $activePort = Find-AvailablePort
    if ($activePort -eq 0) {
      Show-LauncherError 'Ports 4170 through 4180 are already in use.'
      exit 1
    }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { 'C:\Program Files\nodejs\node.exe' }
    if (-not (Test-Path -LiteralPath $nodePath)) {
      Show-LauncherError 'Node.js was not found. Install Node.js 18 or later.'
      exit 1
    }

    $env:HOST = '0.0.0.0'
    $env:PORT = [string]$activePort
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    Save-ServerIdentity $activePort $serverProcess.Id
    Write-LauncherLog ("START PID $($serverProcess.Id) PORT $activePort")

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 250
      if (Test-ProjectServer $activePort) {
        $ready = $true
        break
      }
      if ($serverProcess.HasExited) { break }
    }

    if (-not $ready) {
      if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
      Show-LauncherError "The server could not be started on port $activePort."
      exit 1
    }
  }

  if (-not $NoBrowser) {
    $serverUrl = "http://localhost:$activePort/"
    $browserStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $browserStartInfo.FileName = $serverUrl
    $browserStartInfo.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($browserStartInfo) | Out-Null
    Write-LauncherLog ("OPEN $serverUrl")
  }
  Write-LauncherLog 'DONE'
} catch {
  Show-LauncherError ('Startup failed: ' + $_.Exception.Message)
  exit 1
}
