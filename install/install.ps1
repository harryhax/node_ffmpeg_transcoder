$ErrorActionPreference = 'Stop'

function Test-CommandExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-CommandExists -Name 'node')) {
    Write-Host 'Node.js is not installed. Please install Node.js 18+ and rerun this script.' -ForegroundColor Red
    exit 1
}

if (-not (Test-CommandExists -Name 'ffmpeg') -or -not (Test-CommandExists -Name 'ffprobe')) {
    Write-Host 'ffmpeg and ffprobe are required. Please install them and rerun this script.' -ForegroundColor Red
    exit 1
}

Write-Host 'Installing npm dependencies...' -ForegroundColor Cyan
npm install

Write-Host 'Starting server...' -ForegroundColor Cyan
npm run server
