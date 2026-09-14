# Grimore High-Speed GCP Compute VM Auto-Deploy Script
# Features: Local pre-compilation, zero-VM-build overhead, and real-time progress indicators.

# --- CONFIGURATION ---
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | Foreach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line.Split("=", 2)
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                [System.Environment]::SetEnvironmentVariable($key, $val)
            }
        }
    }
}

$VM_IP = $env:VM_IP
$VM_USER = $env:VM_USER
$LOCAL_ZIP = Join-Path $PSScriptRoot "grimore-gcp-export.zip"

if (-not $VM_IP -or $VM_IP -eq "YOUR_VM_IP" -or -not $VM_USER -or $VM_USER -eq "YOUR_VM_USERNAME") {
    Write-Error "Please configure VM_IP and VM_USER in your .env file."
    exit
}

function Show-DeploymentProgress {
    param(
        [int]$Percent,
        [string]$Status
    )
    Write-Progress -Activity "Deploying Grimore to GCP VM ($VM_IP)" -Status $Status -PercentComplete $Percent
    $barWidth = 30
    $filled = [math]::Round(($Percent / 100) * $barWidth)
    $empty = $barWidth - $filled
    $bar = "█" * $filled + "░" * $empty
    Write-Host "`n[PROGRESS $Percent%] [$bar] $Status" -ForegroundColor Yellow
}

# STEP 0: Preflight — block the deploy if any JS fails to parse or a CSS file is brace-unbalanced.
# Catches AI-edit truncations / duplicate declarations before they ship (see scripts/preflight.js).
Write-Host "`n[PREFLIGHT] Validating source before build..." -ForegroundColor Yellow
node (Join-Path $PSScriptRoot "scripts/preflight.js")
if ($LASTEXITCODE -ne 0) {
    Write-Error "Preflight failed - aborting deploy. Fix the parse/brace errors above and retry."
    exit 1
}

# STEP 1: Local Pre-Compilation
Show-DeploymentProgress -Percent 20 -Status "[1/5] Building React frontend static bundle locally..."
Set-Location -Path (Join-Path $PSScriptRoot "web")
npm run build | Out-Null
Set-Location -Path $PSScriptRoot

# STEP 2: Packaging Export Directory
Show-DeploymentProgress -Percent 40 -Status "[2/5] Refreshing export bundle & static assets..."
if (Test-Path "gcp-export") { Remove-Item "gcp-export" -Recurse -Force }
New-Item -ItemType Directory -Path "gcp-export" -Force | Out-Null

$filesToCopy = @(
    "server.js", "db.js", "mtgjsonService.js", "scryfallService.js", "multiplayer.js",
    "package.json", "package-lock.json", "Dockerfile", ".dockerignore",
    "docker-compose.yml", "Caddyfile", ".env.example", "logo.svg", "logo.ico"
)

foreach ($file in $filesToCopy) {
    if (Test-Path $file) { Copy-Item $file -Destination "gcp-export\" -Force }
}

Copy-Item "public" -Destination "gcp-export\public" -Recurse -Force

if (Test-Path "execution") {
    Copy-Item "execution" -Destination "gcp-export\execution" -Recurse -Force
}

# SECURITY / DATA-SAFETY: never ship the local dev grimore.db to the VM.
# Doing so (a) baked the full user database into Docker image layers, and
# (b) overwrote live production data with a stale local snapshot on every deploy.
# Production data lives only on the VM (persisted via the ./data docker volume).

# Copy pre-built React dist directory
if (Test-Path "apps\web\dist") {
    New-Item -ItemType Directory -Path "gcp-export\apps\web" -Force | Out-Null
    Copy-Item "apps\web\dist" -Destination "gcp-export\apps\web\dist" -Recurse -Force
}

# STEP 3: Compressing Export Zip
Show-DeploymentProgress -Percent 60 -Status "[3/5] Creating lightweight release archive..."
if (Test-Path $LOCAL_ZIP) { Remove-Item $LOCAL_ZIP -Force }
Compress-Archive -Path (Join-Path $PSScriptRoot "gcp-export\*") -DestinationPath $LOCAL_ZIP -Force

# STEP 4: High-Speed SCP Transfer
Show-DeploymentProgress -Percent 80 -Status "[4/5] Transferring release package to GCP VM ($VM_IP)..."
scp -o StrictHostKeyChecking=no $LOCAL_ZIP "${VM_USER}@${VM_IP}:~/grimore-gcp-export.zip"

if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP upload failed. Please check VM network connectivity."
    exit
}

# STEP 5: Fast Remote Container Swap
# NOTE: the automatic `migrate_sqlite_to_postgres.js` step was REMOVED. It ran on every
# deploy and TRUNCATEd production tables, re-seeding them from the shipped local DB — i.e.
# guaranteed user-data loss after launch. Run any one-time migration MANUALLY, with a
# backup, behind the migration script's own FORCE_RESEED guard.
Show-DeploymentProgress -Percent 95 -Status "[5/5] Restarting live containers..."
ssh -o StrictHostKeyChecking=no "${VM_USER}@${VM_IP}" "unzip -o ~/grimore-gcp-export.zip -d ~/grimore; cd ~/grimore && sudo docker-compose up --build -d"

Show-DeploymentProgress -Percent 100 -Status "Deployment Complete! Grimore is Live!"

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host "🚀 DEPLOYMENT COMPLETE! Grimore is Live on:" -ForegroundColor Green
Write-Host "   👉 http://$VM_IP" -ForegroundColor Cyan
Write-Host "==================================================`n" -ForegroundColor Green
