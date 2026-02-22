# ═══════════════════════════════════════════════════════════════════════════════
# ProxyCLI - Docker Build Script (PowerShell)
# ═══════════════════════════════════════════════════════════════════════════════

param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "push", "clean", "compose-up", "compose-down", "help")]
    [string]$Command = "build",

    [Parameter()]
    [string]$Tag = "latest",

    [Parameter()]
    [string]$Name = "proxycli",

    [Parameter()]
    [ValidateSet("production", "development")]
    [string]$Target = "production",

    [Parameter()]
    [switch]$NoCache
)

# Configuration
$ImageName = $Name
$ImageTag = $Tag

# Helper functions
function Write-Info { param($Message) Write-Host "[build] $Message" -ForegroundColor Cyan }
function Write-Success { param($Message) Write-Host "[build] $Message" -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host "[build] WARNING: $Message" -ForegroundColor Yellow }
function Write-Error { param($Message) Write-Host "[build] ERROR: $Message" -ForegroundColor Red }

# Build function
function Build-Image {
    $cacheArg = if ($NoCache) { "--no-cache" } else { "" }
    
    Write-Info "Building ${ImageName}:${ImageTag} (target: ${Target})..."
    
    $buildArgs = @(
        "build"
        "--target", $Target
        "--tag", "${ImageName}:${ImageTag}"
        "--tag", "${ImageName}:latest"
        "--build-arg", "BUILDKIT_INLINE_CACHE=1"
        "--progress=plain"
    )
    
    if ($NoCache) { $buildArgs += "--no-cache" }
    $buildArgs += "."
    
    docker @buildArgs
    
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Build completed: ${ImageName}:${ImageTag}"
        
        $size = docker images "${ImageName}:${ImageTag}" --format "{{.Size}}"
        Write-Info "Image size: $size"
    } else {
        Write-Error "Build failed"
        exit 1
    }
}

# Push function
function Push-Image {
    Write-Info "Pushing ${ImageName}:${ImageTag}..."
    docker push "${ImageName}:${ImageTag}"
    Write-Success "Push completed"
}

# Clean function
function Clean-Images {
    Write-Info "Cleaning up..."
    docker system prune -f --volumes
    docker rmi "${ImageName}:${ImageTag}" 2>$null
    Write-Success "Cleanup completed"
}

# Compose up
function Start-Compose {
    Write-Info "Starting with docker compose..."
    if (Test-Path ".env") {
        docker compose --env-file .env up -d
    } else {
        Write-Warn ".env file not found, using default values"
        docker compose up -d
    }
    Write-Success "Services started"
    
    Start-Sleep -Seconds 2
    docker compose ps
}

# Compose down
function Stop-Compose {
    Write-Info "Stopping with docker compose..."
    docker compose down
    Write-Success "Services stopped"
}

# Show help
function Show-Help {
    @"
Usage: .\docker-build.ps1 [Command] [Options]

Commands:
    build           Build the Docker image (default)
    push            Push the Docker image to registry
    clean           Remove build cache and dangling images
    compose-up      Start with docker compose
    compose-down    Stop with docker compose
    help            Show this help

Options:
    -Tag TAG        Set image tag (default: latest)
    -Name NAME      Set image name (default: proxycli)
    -Target TARGET  Set build target: production|development
    -NoCache        Build without cache

Examples:
    .\docker-build.ps1 build                    # Build production image
    .\docker-build.ps1 build -Target development   # Build development image
    .\docker-build.ps1 build -Tag v1.0.0        # Build with specific tag
    .\docker-build.ps1 compose-up               # Start with docker compose
"@
}

# Main
switch ($Command) {
    "build" { Build-Image }
    "push" { Push-Image }
    "clean" { Clean-Images }
    "compose-up" { Start-Compose }
    "compose-down" { Stop-Compose }
    "help" { Show-Help }
    default { Show-Help }
}
