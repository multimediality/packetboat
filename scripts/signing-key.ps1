# Resolve the Tauri updater signing key + password into the environment so a
# release build signs the updater `.sig` without an interactive prompt.
#
# Dot-source, then call:
#   . (Join-Path $PSScriptRoot 'signing-key.ps1')
#   Initialize-SigningKey -WorkspaceRoot $workspace
#
# Private key: loaded from .tauri/packetboat.key (gitignored) unless already set.
# Password precedence (first hit wins):
#   1. $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD already set (e.g. a CI secret).
#   2. 1Password CLI: `op read` of $env:PACKETBOAT_OP_PASSWORD_REF (default below).
#      If $env:OP_SERVICE_ACCOUNT_TOKEN is set, `op` authenticates with it
#      automatically (no biometric prompt) — that's the preferred path here.
#      Without it, `op` falls back to your signed-in 1Password desktop session.
#      Either way the reference is a pointer, not a secret; the password never
#      touches disk.
#   3. Gitignored plaintext fallback .tauri/packetboat.key.pass.
#
# A missing password is not fatal here; the caller (build-local.ps1) decides
# whether to prompt or bail.

# 1Password secret reference for the signing-key password. Override per-machine
# with the PACKETBOAT_OP_PASSWORD_REF env var, or edit this default to your item.
$script:DefaultOpPasswordRef = 'op://Development/Packetboat/h45hpkrdaxawvnuhnk62iutvge'

function Initialize-SigningKey {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$WorkspaceRoot)

    # Private key from the gitignored key file, unless the caller already exported it.
    $keyFile = Join-Path $WorkspaceRoot '.tauri\packetboat.key'
    if ((Test-Path $keyFile) -and [string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY)) {
        $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyFile -Raw)
    }

    # 1. Already provided (CI secret / explicit export) — nothing to do.
    if (-not [string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        return
    }

    # 2. 1Password. Capturing op's stdout into a variable avoids any shell
    #    re-interpretation of the password's symbols. `op` itself prefers
    #    OP_SERVICE_ACCOUNT_TOKEN over the desktop-app session automatically
    #    when it's set — we just report which one applied, for troubleshooting.
    $opRef = if ($env:PACKETBOAT_OP_PASSWORD_REF) { $env:PACKETBOAT_OP_PASSWORD_REF } else { $script:DefaultOpPasswordRef }
    $opAuth = if (-not [string]::IsNullOrEmpty($env:OP_SERVICE_ACCOUNT_TOKEN)) { "service account" } else { "desktop-app session" }
    if (Get-Command op -ErrorAction SilentlyContinue) {
        try {
            $pw = (& op read $opRef 2>$null)
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrEmpty($pw)) {
                $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ([string]$pw).TrimEnd("`r", "`n")
                Write-Host "Signing password loaded from 1Password ($opRef, via $opAuth)." -ForegroundColor DarkGray
                return
            }
            Write-Host "1Password ($opAuth): couldn't read $opRef (op exit $LASTEXITCODE); trying file fallback." -ForegroundColor DarkYellow
        } catch {
            Write-Host "1Password lookup failed ($($_.Exception.Message)); trying file fallback." -ForegroundColor DarkYellow
        }
    }

    # 3. Gitignored plaintext fallback.
    $passFile = Join-Path $WorkspaceRoot '.tauri\packetboat.key.pass'
    if (Test-Path $passFile) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $passFile -Raw).TrimEnd("`r", "`n")
    }
}
