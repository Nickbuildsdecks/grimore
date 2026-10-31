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
#
# This used to `Set-Location` into "web" and run `npm run build` there. That directory does not exist --
# the React app is `apps/web`, a pnpm workspace member -- so the cd failed, the build ran in whatever
# directory it landed in, `| Out-Null` swallowed the output and $LASTEXITCODE was never checked. The step
# has been silently doing nothing, and the deploy has been shipping whatever `apps/web/dist` happened to
# be left over from the last successful local build.
#
# Now it runs the workspace build from the repository root and STOPS on failure. Shipping a stale
# frontend quietly is worse than failing loudly.
Show-DeploymentProgress -Percent 20 -Status "[1/6] Building React frontend static bundle locally..."
Set-Location -Path $PSScriptRoot
pnpm --filter @grimore/web build
if ($LASTEXITCODE -ne 0) {
    Write-Error "React build failed - aborting deploy rather than shipping a stale apps/web/dist."
    exit 1
}

# STEP 2: Packaging Export Directory
Show-DeploymentProgress -Percent 40 -Status "[2/6] Refreshing export bundle & static assets..."
if (Test-Path "gcp-export") { Remove-Item "gcp-export" -Recurse -Force }
New-Item -ItemType Directory -Path "gcp-export" -Force | Out-Null

$filesToCopy = @(
    "server.js", "db.js", "mtgjsonService.js", "scryfallService.js", "multiplayer.js",
    "package.json", "package-lock.json", "Dockerfile", ".dockerignore",
    "docker-compose.yml", "Caddyfile", ".env.example", "logo.svg", "logo.ico",
    # Legacy requires these at runtime: the CommonJS halves of the account token discipline, the
    # password policy and the mail transport. Omitting one makes `node server.js` fail at require time,
    # which is a boot loop rather than a degraded feature.
    "accountTokens.js", "passwordPolicy.js", "mailer.js",
    # The v2 workspace manifests. apps/api's image is built from the repository root and
    # `pnpm install --frozen-lockfile` needs the lockfile plus the workspace definition; tsconfig.base.json
    # is extended by every packages/* tsconfig.
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "tsconfig.base.json"
)

foreach ($file in $filesToCopy) {
    if (Test-Path $file) { Copy-Item $file -Destination "gcp-export\" -Force }
}

Copy-Item "public" -Destination "gcp-export\public" -Recurse -Force

# apps/api and packages/, for the v2 API image.
#
# Shipping these does NOT start anything: the `api` service in docker-compose.yml sits behind the `v2`
# profile, and the remote command below runs a plain `docker-compose up` with no `--profile`. So this
# puts the files on the VM and changes nothing about what runs -- the migrations are a separate,
# deliberate step. See claude/cutover-runbook.md.
#
# node_modules and dist are excluded: the image builds them, and copying a Windows node_modules tree to
# a Linux VM ships broken native bindings.
# The whole workspace, not just apps/api. `pnpm install --frozen-lockfile` inside the image refuses to
# run unless EVERY workspace member's package.json is present -- including apps/web and apps/realtime,
# which that image never builds. Shipping apps/api alone produced a bundle whose image build fails with
# "lockfile out of sync", which is a failure on the VM rather than here.
foreach ($dir in @("apps", "packages")) {
    if (Test-Path $dir) {
        $dest = Join-Path "gcp-export" $dir
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item (Join-Path $dir "*") -Destination $dest -Recurse -Force
        # node_modules and dist are stripped after the copy rather than excluded during it: Copy-Item's
        # -Exclude only matches leaf names at the top level, so nested ones survive it. A Windows
        # node_modules tree on a Linux VM means broken native bindings, and the image rebuilds both anyway.
        Get-ChildItem -Path $dest -Include @("node_modules", "dist") -Recurse -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Property FullName -Descending |
            ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

if (Test-Path "execution") {
    Copy-Item "execution" -Destination "gcp-export\execution" -Recurse -Force
}

# scripts/ was never shipped, so the read-only audit and the staging-rehearsal tooling could not be run
# on the VM -- which is the only place they can be run, since the database is reachable from nowhere else.
if (Test-Path "scripts") {
    Copy-Item "scripts" -Destination "gcp-export\scripts" -Recurse -Force
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

# The bundle has to satisfy apps/api/Dockerfile, which copies every workspace manifest before running
# `pnpm install --frozen-lockfile`. Rather than maintain that list by hand here -- where getting it wrong
# surfaces as a build failure on the VM, after the upload -- read it back out of the Dockerfile and check.
# This is the same idea as the Dockerfile guard in scripts/guards.js, applied to the shipped bundle.
$dockerfile = Join-Path $PSScriptRoot "apps\api\Dockerfile"
if (Test-Path $dockerfile) {
    $required = Select-String -Path $dockerfile -Pattern 'COPY\s+([A-Za-z0-9/_-]+/package\.json)' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value }
    $missing = @()
    foreach ($manifest in $required) {
        $local = Join-Path "gcp-export" ($manifest -replace '/', '\')
        if (-not (Test-Path $local)) { $missing += $manifest }
    }
    if ($missing.Count -gt 0) {
        Write-Error ("The release bundle is missing manifests that apps/api/Dockerfile requires, so its " +
            "image build would fail on the VM with a lockfile-out-of-sync error: " + ($missing -join ", "))
        exit 1
    }
    Write-Host ("[bundle] all " + $required.Count + " workspace manifests present") -ForegroundColor DarkGray
}

# STEP 3: Compressing Export Zip
Show-DeploymentProgress -Percent 60 -Status "[3/6] Creating lightweight release archive..."
if (Test-Path $LOCAL_ZIP) { Remove-Item $LOCAL_ZIP -Force }
Compress-Archive -Path (Join-Path $PSScriptRoot "gcp-export\*") -DestinationPath $LOCAL_ZIP -Force

# STEP 4: High-Speed SCP Transfer
Show-DeploymentProgress -Percent 80 -Status "[4/6] Transferring release package to GCP VM ($VM_IP)..."
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
Show-DeploymentProgress -Percent 95 -Status "[5/6] Restarting live containers..."
ssh -o StrictHostKeyChecking=no "${VM_USER}@${VM_IP}" "unzip -o ~/grimore-gcp-export.zip -d ~/grimore; cd ~/grimore && sudo docker-compose up --build -d"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Remote container restart failed. The VM may be mid-deploy - check `ssh ${VM_USER}@${VM_IP} 'cd ~/grimore && sudo docker-compose ps'` before retrying."
    exit 1
}

# STEP 6: Confirm the legacy app is actually answering, rather than reporting success because scp did.
Show-DeploymentProgress -Percent 98 -Status "[6/6] Verifying the app responds..."
$healthy = $false
foreach ($attempt in 1..10) {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -Uri "http://$VM_IP/api/auth/me" -TimeoutSec 5 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
        # Still restarting; keep trying.
    }
}
if (-not $healthy) {
    Write-Warning "The app did not answer on /api/auth/me within 30s. It may still be starting - check `sudo docker-compose logs --tail=50 app` on the VM."
}

Show-DeploymentProgress -Percent 100 -Status "Deployment Complete! Grimore is Live!"

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host "🚀 DEPLOYMENT COMPLETE! Grimore is Live on:" -ForegroundColor Green
Write-Host "   👉 http://$VM_IP" -ForegroundColor Cyan
Write-Host "==================================================`n" -ForegroundColor Green

# What this deploy deliberately did NOT do:
#
#   * It did not run any database migration. apps/api and packages/ are now ON the VM, but the `api`
#     service is behind the `v2` compose profile and was not started, so the schema is untouched.
#   * Migrations 0002-0014 are the one-way door, and they are a separate, deliberate step that starts
#     with a backup. The exact commands are in claude/cutover-runbook.md.
#
# Until those migrations run, password recovery keeps failing on production -- the tables it needs do
# not exist yet.
Write-Host "Note: no migration was run. The v2 files are on the VM but the api service is not started." -ForegroundColor Yellow
Write-Host "      To migrate, follow claude/cutover-runbook.md - it begins with a database backup.`n" -ForegroundColor Yellow
