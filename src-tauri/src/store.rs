// User data on disk: ~/.viewport/
//
// Everything used to live in localStorage, which under WebView2 is buried in an
// opaque profile directory and silently capped at a few MB. Plain files in a
// predictable place mean projects can be found, backed up, and hand-edited.
//
//   ~/.viewport/settings.json
//   ~/.viewport/projects/<id>.json
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Root of the user's Viewport data. Same dotted folder on every platform so a
/// project directory is portable and easy to describe.
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home directory: {e}"))?;
    Ok(home.join(".viewport"))
}

/// Resolve a store key to a path inside the root.
///
/// Keys come from the webview, so they're untrusted: reject anything absolute,
/// with a drive prefix, or containing `..`, so a key can never escape the root.
fn resolve(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let base = root(app)?;
    let rel = Path::new(key);
    if rel.is_absolute()
        || key.contains("..")
        || key.contains(':')
        || key.starts_with('/')
        || key.starts_with('\\')
    {
        return Err(format!("invalid key: {key}"));
    }
    Ok(base.join(rel))
}

#[tauri::command]
pub fn store_dir(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn store_read(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let p = resolve(&app, &key)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {key}: {e}")),
    }
}

#[tauri::command]
pub fn store_write(app: AppHandle, key: String, data: String) -> Result<(), String> {
    let p = resolve(&app, &key)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    }
    // write-then-rename, so a crash mid-save can't leave a truncated project
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("could not write {key}: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("could not replace {key}: {e}"))
}

#[tauri::command]
pub fn store_remove(app: AppHandle, key: String) -> Result<(), String> {
    let p = resolve(&app, &key)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {key}: {e}")),
    }
}

/// File names (without extension) directly inside `dir`.
#[tauri::command]
pub fn store_list(app: AppHandle, dir: String) -> Result<Vec<String>, String> {
    let p = resolve(&app, &dir)?;
    let Ok(rd) = std::fs::read_dir(&p) else {
        return Ok(Vec::new()); // nothing stored yet
    };
    Ok(rd
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect())
}
