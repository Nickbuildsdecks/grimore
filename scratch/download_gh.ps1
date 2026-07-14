$dir = "C:\Users\772wa\gh-portable"
if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir
}
$zip = Join-Path $dir "gh.zip"
Write-Output "Downloading GitHub CLI..."
Invoke-WebRequest -Uri "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_windows_amd64.zip" -OutFile $zip
Write-Output "Extracting GitHub CLI..."
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip
Write-Output "GitHub CLI installed successfully."
