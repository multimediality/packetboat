# Build Packetboat installers + binaries locally, injecting the updater signing
# key + password (env > 1Password > .tauri/*.pass file > interactive prompt) so
# the signed updater artifacts build without exposing the password in your shell
# history. CI signs from GitHub secrets and does not use this script.
#
#   .\scripts\build-local.ps1
#
# Output (Windows): src-tauri\target\release\bundle\{msi,nsis}\ + the portable exe.

$ErrorActionPreference = "Stop"
$workspace = Split-Path $PSScriptRoot -Parent

# Save the signing env so a build never leaves the caller's shell mutated.
$prevSignKey = $env:TAURI_SIGNING_PRIVATE_KEY
$prevSignPass = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
try {
    . (Join-Path $PSScriptRoot 'signing-key.ps1')
    Initialize-SigningKey -WorkspaceRoot $workspace

    if ([string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY)) {
        throw "No signing key at .tauri\packetboat.key. Generate one (README > Auto-updates) before a signed build."
    }
    # Final fallback: prompt for the password if nothing else resolved it.
    if ([string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        $secure = Read-Host "Signing key password" -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD =
                [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    Write-Host "`nBuilding Packetboat (signed)..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }

    $release = Join-Path $workspace 'src-tauri\target\release'
    Write-Host "`nBuild complete!" -ForegroundColor Green
    Write-Host "  MSI installer:  $release\bundle\msi\" -ForegroundColor Cyan
    Write-Host "  NSIS installer: $release\bundle\nsis\" -ForegroundColor Cyan
    Write-Host "  Portable exe:   $release\packetboat.exe" -ForegroundColor Cyan
    Write-Host "  Updater bundles (.zip + .sig) sit beside each installer." -ForegroundColor DarkGray
} finally {
    foreach ($pair in @(
            @{ Name = 'TAURI_SIGNING_PRIVATE_KEY'; Val = $prevSignKey },
            @{ Name = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'; Val = $prevSignPass }
        )) {
        if ($null -eq $pair.Val) {
            Remove-Item "Env:$($pair.Name)" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item "Env:$($pair.Name)" -Value $pair.Val
        }
    }
}
