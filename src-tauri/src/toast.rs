//! Windows toast identity. The notification plugin only tags toasts with our
//! app id for the *installed* build; running unpackaged (`tauri dev`) it falls
//! back to PowerShell's app id, so toasts show "PowerShell" with no icon.
//!
//! Here we register our own AppUserModelID (display name + icon) in the registry
//! and send toasts under it, so notifications attribute to **Packetboat** — with
//! our icon in the toast header *and* beside the text — in dev and packaged
//! builds alike.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri_winrt_notification::{IconCrop, Toast};

/// Must match `tauri.conf.json` `identifier`.
const APP_USER_MODEL_ID: &str = "com.multimediality.packetboat";
const DISPLAY_NAME: &str = "Packetboat";
/// 256×256 square PNG used for both the registry icon and the toast logo.
const TOAST_ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");

static PREPARED: OnceLock<()> = OnceLock::new();

/// Register our AUMID (display name + icon) and adopt it as this process's app
/// id so unpackaged toasts are delivered under it. Runs its work once.
pub fn prepare() {
    if PREPARED.get().is_some() {
        return;
    }
    let _ = register_app_user_model_id(icon_path().as_deref());
    set_process_app_user_model_id();
    let _ = PREPARED.set(());
}

/// Show a branded toast (icon in the header via the AUMID, icon beside the text
/// via `appLogoOverride`). `on_click` runs when the user clicks the toast (fired
/// on a WinRT thread — keep it cheap and thread-safe). Returns `Err` if the
/// toast couldn't be shown.
pub fn show<F>(title: &str, body: &str, on_click: F) -> Result<(), String>
where
    F: FnMut() + Send + 'static,
{
    prepare();
    let mut on_click = on_click;
    let mut toast = Toast::new(APP_USER_MODEL_ID).title(title).text1(body);
    if let Some(icon) = icon_path() {
        toast = toast.icon(&icon, IconCrop::Square, DISPLAY_NAME);
    }
    toast
        .on_activated(move |_arg| {
            on_click();
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

/// Materialize the embedded icon to the config dir (once) and return its path —
/// the registry `IconUri` and the toast `appLogoOverride` both need a file path.
fn icon_path() -> Option<PathBuf> {
    let dir = crate::backend::config_dir();
    let path = dir.join("toast-icon.png");
    if !path.is_file() {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, TOAST_ICON_PNG).ok()?;
    }
    Some(path)
}

fn register_app_user_model_id(icon: Option<&Path>) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) =
        hkcu.create_subkey(format!(r"Software\Classes\AppUserModelId\{APP_USER_MODEL_ID}"))?;
    key.set_value("DisplayName", &DISPLAY_NAME)?;
    if let Some(icon) = icon {
        // Windows wants a `file:///C:/…` URI to a square PNG.
        let uri = format!("file:///{}", icon.display().to_string().replace('\\', "/"));
        key.set_value("IconUri", &uri)?;
    }
    // Transparent tile background (ARGB), per Microsoft's unpackaged sample.
    key.set_value("IconBackgroundColor", &"0")?;
    Ok(())
}

fn set_process_app_user_model_id() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let wide: Vec<u16> = OsStr::new(APP_USER_MODEL_ID)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a null-terminated UTF-16 string for the Win32 call.
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}
