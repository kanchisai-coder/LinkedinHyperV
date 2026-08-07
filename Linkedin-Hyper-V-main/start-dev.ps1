Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Load-EnvFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Target
  )

  if (-not (Test-Path -LiteralPath $Path)) { return }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { return }

    $key = $matches[1]
    $value = $matches[2].Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $Target[$key] = $value
  }
}

function Get-ListeningPidsForPort {
  param([Parameter(Mandatory = $true)][int]$Port)

  $pids = @()
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess)
  } catch {
    $raw = cmd /c "netstat -ano | findstr LISTENING | findstr :$Port"
    foreach ($line in $raw) {
      $parts = ($line -replace '\s+', ' ').Trim().Split(' ')
      if ($parts.Length -ge 5) {
        $parsedPid = 0
        if ([int]::TryParse($parts[4], [ref]$parsedPid)) {
          $pids += $parsedPid
        }
      }
    }
  }

  return @($pids | Sort-Object -Unique)
}

function Invoke-PrismaSchemaSync {
  param(
    [Parameter(Mandatory = $true)][string]$WorkerRoot,
    [Parameter(Mandatory = $true)][string]$DatabaseUrl
  )

  Write-Host "Ensuring Prisma schema (db push)..."
  $cmd = "set `"DATABASE_URL=$DatabaseUrl`" && .\node_modules\.bin\prisma.cmd db push --schema=prisma/schema.prisma"
  $tmpOut = Join-Path $env:TEMP ("prisma-db-push-" + [Guid]::NewGuid().ToString("N") + ".log")
  & cmd.exe /c "$cmd > `"$tmpOut`" 2>&1"
  $exitCode = $LASTEXITCODE
  $output = @()
  if (Test-Path -LiteralPath $tmpOut) {
    $output = Get-Content -LiteralPath $tmpOut -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue
  }

  if ($exitCode -eq 0) {
    Write-Host "Prisma schema ready."
    return
  }

  Write-Warning "Prisma schema sync skipped (database may be offline or unreachable)."
  if ($output) {
    $output | Select-Object -Last 8 | ForEach-Object { Write-Host $_ }
  }
}

function Get-DbEndpointFromUrl {
  param([Parameter(Mandatory = $true)][string]$DatabaseUrl)
  try {
    $uri = [System.Uri]$DatabaseUrl
    $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    return @{ Host = $uri.Host; Port = $port }
  } catch {
    return $null
  }
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)][string]$TargetHost,
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutMs = 1200
  )
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $ar = $client.BeginConnect($TargetHost, $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      $client.Close()
      return $false
    }
    $client.EndConnect($ar) | Out-Null
    $client.Close()
    return $true
  } catch {
    if ($client) { $client.Close() }
    return $false
  }
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerRoot = Join-Path $repoRoot "worker"

$baseEnv = @{}
Load-EnvFile -Path (Join-Path $repoRoot ".env") -Target $baseEnv

$envMap = @{}
# Match Next.js precedence: .env.local should override .env
Load-EnvFile -Path (Join-Path $repoRoot ".env") -Target $envMap
Load-EnvFile -Path (Join-Path $repoRoot ".env.local") -Target $envMap

$databaseUrl = if ($envMap.ContainsKey("DATABASE_URL")) { $envMap["DATABASE_URL"] } else { "postgresql://linkedinuser:dev-postgres-password-change-me@localhost:5432/linkedin_db" }
$redisHost = if ($envMap.ContainsKey("REDIS_HOST")) { $envMap["REDIS_HOST"] } else { "localhost" }
$redisPort = if ($envMap.ContainsKey("REDIS_PORT")) { $envMap["REDIS_PORT"] } else { "6379" }
$redisPassword = if ($envMap.ContainsKey("REDIS_PASSWORD")) { $envMap["REDIS_PASSWORD"] } elseif ($baseEnv.ContainsKey("REDIS_PASSWORD")) { $baseEnv["REDIS_PASSWORD"] } else { "redis-dev-password-change-in-prod" }
$apiSecret = if ($envMap.ContainsKey("API_SECRET")) { $envMap["API_SECRET"] } else { "dev-api-secret-key-change-in-production" }
$sessionKey = if ($envMap.ContainsKey("SESSION_ENCRYPTION_KEY")) { $envMap["SESSION_ENCRYPTION_KEY"] } else { "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
$accountIds = if ($envMap.ContainsKey("ACCOUNT_IDS") -and $envMap["ACCOUNT_IDS"].Trim().Length -gt 0) { $envMap["ACCOUNT_IDS"] } else { "dev-account" }
$redisPortInt = 6379
if (-not [int]::TryParse($redisPort, [ref]$redisPortInt)) {
  $redisPortInt = 6379
}

$disableRedis = "1"
if ($envMap.ContainsKey("DISABLE_REDIS") -and $envMap["DISABLE_REDIS"].Trim().Length -gt 0) {
  $disableRedis = $envMap["DISABLE_REDIS"]
} else {
  $disableRedis = if (Test-TcpPort -TargetHost $redisHost -Port $redisPortInt -TimeoutMs 1500) { "0" } else { "1" }
}
$skipPrismaPush = if ($envMap.ContainsKey("SKIP_PRISMA_PUSH") -and $envMap["SKIP_PRISMA_PUSH"].Trim().Length -gt 0) { $envMap["SKIP_PRISMA_PUSH"] } else { "0" }

# Free required ports first.
$ports = @(3000, 3001)
foreach ($port in $ports) {
  $pids = Get-ListeningPidsForPort -Port $port
  foreach ($processId in $pids) {
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Host "Stopped PID $processId on port $port"
    } catch {
      # Best-effort fallback through taskkill (may still require admin)
      cmd.exe /c "taskkill /F /PID $processId >NUL 2>NUL"
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Stopped PID $processId on port $port via taskkill"
      } else {
        Write-Warning "Could not stop PID $processId on port ${port}: $($_.Exception.Message)"
      }
    }
  }
}

# If ports are still occupied, abort so we don't keep running stale worker/frontend code.
$blocked = @()
foreach ($port in $ports) {
  $left = @(Get-ListeningPidsForPort -Port $port)
  if ($left.Count -gt 0) {
    $blocked += [PSCustomObject]@{ Port = $port; Pids = ($left -join ',') }
  }
}
if ($blocked.Count -gt 0) {
  $existingFrontend = "000"
  $existingBackend = "000"
  try { $existingFrontend = curl.exe --max-time 3 -s -o NUL -w "%{http_code}" "http://localhost:3000" } catch {}
  try { $existingBackend = curl.exe --max-time 3 -s -o NUL -w "%{http_code}" "http://localhost:3001/health" } catch {}

  $frontendOk = @("200", "307", "308") -contains $existingFrontend
  $backendOk = $existingBackend -eq "200"

  if ($frontendOk -and $backendOk) {
    Write-Warning "Ports are occupied by protected processes, but both services are already healthy. Reusing existing processes."
    Write-Host "Frontend : http://localhost:3000 (HTTP $existingFrontend)"
    Write-Host "Backend  : http://localhost:3001/health (HTTP $existingBackend)"
    exit 0
  }

  Write-Error @"
Ports are still occupied by protected processes.
Please open PowerShell as Administrator and stop these PIDs:
$($blocked | ForEach-Object { "  Port $($_.Port): PID(s) $($_.Pids)" } | Out-String)
Then re-run .\start-dev.ps1.
"@
  exit 1
}

# Best-effort DB schema sync for local dev (non-fatal when DB is down).
if ($skipPrismaPush -ne "1") {
  try {
    $endpoint = Get-DbEndpointFromUrl -DatabaseUrl $databaseUrl
    if ($endpoint -and (Test-TcpPort -TargetHost $endpoint.Host -Port $endpoint.Port)) {
      Push-Location $workerRoot
      try {
        Invoke-PrismaSchemaSync -WorkerRoot $workerRoot -DatabaseUrl $databaseUrl
      } finally {
        Pop-Location
      }
    } else {
      Write-Warning "Skipping Prisma schema sync because PostgreSQL is not reachable at local dev DATABASE_URL."
    }
  } catch {
    Write-Warning "Prisma schema sync step failed: $($_.Exception.Message)"
  }
}

# Start frontend (Next.js dev server)
# Start directly via npm to avoid cmd redirection edge-cases where Next dev exits.
$env:DISABLE_REDIS = $disableRedis
Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") -WorkingDirectory $repoRoot | Out-Null

# Start backend (worker API)
$workerLog = Join-Path $workerRoot "worker_run.log"
try {
  Set-Content -LiteralPath $workerLog -Value "" -Encoding UTF8
} catch {
  Write-Warning "Could not reset worker log file (it may be locked by an old process): $($_.Exception.Message)"
}
$workerArgs = "/c set DATABASE_URL=$databaseUrl&& set REDIS_HOST=$redisHost&& set REDIS_PORT=$redisPort&& set REDIS_PASSWORD=$redisPassword&& set DISABLE_REDIS=$disableRedis&& set API_SECRET=$apiSecret&& set SESSION_ENCRYPTION_KEY=$sessionKey&& set ACCOUNT_IDS=$accountIds&& set DISABLE_MESSAGE_SYNC=1&& set DIRECT_VERIFY=1&& set DIRECT_EXECUTION=1&& set DISABLE_QUEUE=1&& set BROWSER_HEADLESS=1&& set REFRESH_SESSION_COOKIES=0&& npm run start > `"$workerLog`" 2>&1"
Start-Process -FilePath "cmd.exe" -ArgumentList $workerArgs -WorkingDirectory $workerRoot | Out-Null

function Wait-HttpStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][int[]]$OkStatuses,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $status = curl.exe --max-time 10 -s -o NUL -w "%{http_code}" $Url
      if ($status -match '^\d{3}$') {
        $statusInt = [int]$status
        if ($OkStatuses -contains $statusInt) {
          return $status
        }
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return "000"
}

# Wait for frontend and backend to be reachable.
$frontendStatus = Wait-HttpStatus -Url "http://localhost:3000" -OkStatuses @(200, 307, 308) -TimeoutSeconds 90
$backendStatus = Wait-HttpStatus -Url "http://localhost:3001/health" -OkStatuses @(200) -TimeoutSeconds 90

Write-Host ""
Write-Host "Frontend : http://localhost:3000"
Write-Host "Backend  : http://localhost:3001/health"

Write-Host "Frontend HTTP status: $frontendStatus"

try {
  $health = curl.exe --max-time 5 -s http://localhost:3001/health
  Write-Host "Backend health: $health"
} catch {
  Write-Warning "Could not verify backend health endpoint."
}

if ($frontendStatus -eq "000" -or $backendStatus -eq "000") {
  Write-Warning "One or both services did not bind in time. Showing recent logs:"
  if (Test-Path -LiteralPath $workerLog) {
    Write-Host "`n--- Backend log (tail) ---"
    Get-Content -LiteralPath $workerLog -Tail 40
  }
}

Write-Host ""
Write-Host "Logs:"
Write-Host "  Backend  -> $workerLog"
