# Grimore GCP Compute VM Auto-Deploy Script
# Run this script from PowerShell to compile, compress, upload, and deploy updates to your VM.

# --- CONFIGURATION ---
# Load environment variables from .env if it exists
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
# ---------------------

if (-not $VM_IP -or $VM_IP -eq "YOUR_VM_IP" -or -not $VM_USER -or $VM_USER -eq "YOUR_VM_USERNAME") {
    Write-Error "Please configure VM_IP and VM_USER in your .env file."
    exit
}

Write-Host "1. Refreshing export files..." -ForegroundColor Cyan
Copy-Item "server.js" -Destination "gcp-export/server.js" -Force
Copy-Item "db.js" -Destination "gcp-export/db.js" -Force
Copy-Item "mtgjsonService.js" -Destination "gcp-export/mtgjsonService.js" -Force
Copy-Item "scryfallService.js" -Destination "gcp-export/scryfallService.js" -Force
Copy-Item "package.json" -Destination "gcp-export/package.json" -Force
Copy-Item "package-lock.json" -Destination "gcp-export/package-lock.json" -Force
Copy-Item "Dockerfile" -Destination "gcp-export/Dockerfile" -Force
Copy-Item ".dockerignore" -Destination "gcp-export/.dockerignore" -Force
Copy-Item "docker-compose.yml" -Destination "gcp-export/docker-compose.yml" -Force
Copy-Item "Caddyfile" -Destination "gcp-export/Caddyfile" -Force
Copy-Item ".env.example" -Destination "gcp-export/.env.example" -Force
Copy-Item "logo.svg" -Destination "gcp-export/logo.svg" -Force
Copy-Item "logo.ico" -Destination "gcp-export/logo.ico" -Force
Copy-Item "public\app.js" -Destination "gcp-export\public\app.js" -Force
Copy-Item "public\index.html" -Destination "gcp-export\public\index.html" -Force
Copy-Item "public\style.css" -Destination "gcp-export\public\style.css" -Force
Copy-Item "public\search.html" -Destination "gcp-export\public\search.html" -Force
Copy-Item "public\search.js" -Destination "gcp-export\public\search.js" -Force
Copy-Item "public\suggestions.html" -Destination "gcp-export\public\suggestions.html" -Force
Copy-Item "public\suggestions.js" -Destination "gcp-export\public\suggestions.js" -Force
Copy-Item "public\collection.html" -Destination "gcp-export\public\collection.html" -Force
Copy-Item "public\collection.js" -Destination "gcp-export\public\collection.js" -Force
Copy-Item "public\logo.svg" -Destination "gcp-export\public\logo.svg" -Force
Copy-Item "public\patreon_cover_cropped.png" -Destination "gcp-export\public\patreon_cover_cropped.png" -Force

Write-Host "2. Creating zip archive..." -ForegroundColor Cyan
if (Test-Path $LOCAL_ZIP) { Remove-Item $LOCAL_ZIP -Force }
Compress-Archive -Path (Join-Path $PSScriptRoot "gcp-export\*") -DestinationPath $LOCAL_ZIP -Force

Write-Host "3. Uploading updates to VM ($VM_IP)..." -ForegroundColor Cyan
scp -o StrictHostKeyChecking=no $LOCAL_ZIP "${VM_USER}@${VM_IP}:~/grimore-gcp-export.zip"

if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP upload failed. Please verify that your VM is running, the IP is correct, and your SSH key is authorized."
    exit
}

Write-Host "4. Extracting and rebuilding containers on VM..." -ForegroundColor Cyan
ssh -o StrictHostKeyChecking=no "${VM_USER}@${VM_IP}" "unzip -o ~/grimore-gcp-export.zip -d ~/grimore; cd ~/grimore && sudo docker rm -f grimore-app 2>/dev/null; sudo /usr/bin/docker-compose up --build -d"

Write-Host "Deployment completed successfully! Grimore is live on: http://$VM_IP" -ForegroundColor Green
