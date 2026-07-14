$dir = "C:\Users\772wa\git-portable"
if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir
}
$zip = Join-Path $dir "git.zip"
Write-Output "Downloading MinGit..."
Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.2/MinGit-2.55.0.2-64-bit.zip" -OutFile $zip
Write-Output "Extracting MinGit..."
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip
Write-Output "MinGit installed successfully."
