---
name: gcp-docker-deploy
description: Guide for containerizing Node.js applications with Docker, setting up Caddy reverse proxy for automatic SSL/HTTPS, and automating remote ssh deployment to GCP VM instances using PowerShell scripts. Use when the user requests cloud deployment, configuring Docker files, setting up docker-compose, SSL/Caddy configuration, or running deployment scripts.
---

# Docker and GCP VM HTTPS Deployment Orchestrator

This skill defines the templates, instructions, and scripts to package, deploy, and manage Web Applications with Docker and Caddy SSL on Google Cloud Platform (GCP) Compute Engine.

## 1. Multi-Container Docker Setup

A secure production environment splits concerns into two containers:
1. **App Container**: Runs the Node.js or web server on port 3000.
2. **Caddy Container**: Acts as the reverse proxy, automatically handles Let's Encrypt SSL certifications, and redirects HTTP (port 80) to HTTPS (port 443).

### docker-compose.yml Template
```yaml
version: '3.8'

services:
  app:
    build: .
    container_name: grimore-app
    restart: always
    expose:
      - "3000"
    environment:
      - NODE_ENV=production
      - PORT=3000

  caddy:
    image: caddy:2-alpine
    container_name: grimore-caddy
    restart: always
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app

volumes:
  caddy_data:
  caddy_config:
```

### Caddyfile Template
```caddyfile
grimore.gg, www.grimore.gg {
    reverse_proxy app:3000
    
    encode gzip zstd
    
    log {
        output file /var/log/caddy/access.log
    }
}
```

---

## 2. Automated GCP Deployment Script (PowerShell)

To sync local updates to the remote VM and rebuild containers without downtime:
1. Copy updated source files into the export folder.
2. Compress files into a ZIP archive.
3. Upload the ZIP to GCP VM instance using SSH/SCP or secure copy.
4. SSH into the VM, extract the archive, and run `docker-compose up -d --build`.

### deploy-gcp.ps1 Template
```powershell
# Local paths
$src = "C:\Users\772wa\.gemini\antigravity\scratch\mtg-tournament-platform"
$zipPath = "$src\grimore-gcp-export.zip"
$gcpIP = "136.65.140.33"
$username = "nickgothard5"

Write-Host "Compressing project folder..." -ForegroundColor Cyan
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$src\gcp-export\*" -DestinationPath $zipPath -Force

Write-Host "Uploading project to GCP VM via SCP..." -ForegroundColor Cyan
scp -o StrictHostKeyChecking=no $zipPath "${username}@${gcpIP}:~/grimore-upload.zip"

Write-Host "Extracting and rebuilding containers on GCP VM..." -ForegroundColor Cyan
ssh -o StrictHostKeyChecking=no "${username}@${gcpIP}" "
  mkdir -p ~/grimore
  unzip -o ~/grimore-upload.zip -d ~/grimore/
  rm ~/grimore-upload.zip
  cd ~/grimore
  sudo docker-compose down
  sudo docker-compose up -d --build --no-cache
"

Write-Host "Deployment Completed Successfully!" -ForegroundColor Green
```

---

## 3. Operations & Maintenance CLI Commands

Use these commands via ssh to check container health:

- **Check logs**: `sudo docker-compose logs -f app`
- **Check container resource usage**: `sudo docker stats`
- **Restart services**: `sudo docker-compose restart`
- **Clear unused Docker cache**: `sudo docker system prune -af --volumes`
