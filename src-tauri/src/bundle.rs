// Project bundles: a .viewport.zip holding the project manifest plus its media.
//
//   project.json      manifest (settings + timeline + asset metadata)
//   media/<file>      one entry per source the project references
//
// Streamed both ways. A project's media is the whole point of the format and is
// routinely gigabytes, so nothing here ever holds a file in memory: entries are
// copied through a fixed buffer straight between the archive and disk. Doing
// this in the webview instead would mean the bytes crossing IPC twice and a
// browser tab trying to hold a 4GB array.
//
// Media is STOREd, not deflated. Video and audio are already compressed, so
// deflate costs a lot of CPU to save almost nothing. The manifest is small text
// and does get deflated.
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use zip::write::SimpleFileOptions;

use crate::store;

/// One file to put in the archive.
#[derive(serde::Deserialize)]
pub struct BundleEntry {
    /// absolute path on this machine
    pub path: String,
    /// file name to store it under inside `media/`
    pub name: String,
}

/// What a read bundle produced: the manifest, and where each media file landed.
#[derive(serde::Serialize)]
pub struct OpenedBundle {
    pub manifest: String,
    /// name inside the archive -> absolute path it was extracted to
    pub media: Vec<(String, String)>,
}

const MANIFEST: &str = "project.json";
const MEDIA_DIR: &str = "media";

/// Strip anything that could escape the media folder when an archive is opened.
/// Entry names come from a file the user was handed, so they are untrusted.
fn safe_name(name: &str) -> Option<String> {
    let base = Path::new(name).file_name()?.to_string_lossy().into_owned();
    if base.is_empty() || base == "." || base == ".." {
        return None;
    }
    Some(base)
}

/// Write a project bundle. `files` are copied in as `media/<name>`.
#[tauri::command]
pub fn bundle_write(out: String, manifest: String, files: Vec<BundleEntry>) -> Result<(), String> {
    let f = std::fs::File::create(&out).map_err(|e| format!("could not create {out}: {e}"))?;
    let mut z = zip::ZipWriter::new(std::io::BufWriter::new(f));

    z.start_file(MANIFEST, SimpleFileOptions::default())
        .map_err(|e| e.to_string())?;
    z.write_all(manifest.as_bytes())
        .map_err(|e| format!("could not write the manifest: {e}"))?;

    // already-compressed media: storing is far faster and no larger
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut buf = vec![0u8; 1 << 20];
    for entry in &files {
        let Some(name) = safe_name(&entry.name) else {
            continue;
        };
        let mut src = match std::fs::File::open(&entry.path) {
            Ok(f) => f,
            // A relinked-but-missing source shouldn't sink the whole export;
            // the manifest still references it and reopening will ask for it.
            Err(_) => continue,
        };
        z.start_file(format!("{MEDIA_DIR}/{name}"), stored)
            .map_err(|e| e.to_string())?;
        loop {
            let n = src
                .read(&mut buf)
                .map_err(|e| format!("could not read {}: {e}", entry.path))?;
            if n == 0 {
                break;
            }
            z.write_all(&buf[..n])
                .map_err(|e| format!("could not write {name}: {e}"))?;
        }
    }
    z.finish().map_err(|e| format!("could not finish {out}: {e}"))?;
    Ok(())
}

fn extract_into<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    dest: &Path,
) -> Result<OpenedBundle, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("could not create {dest:?}: {e}"))?;
    let mut manifest = String::new();
    let mut media = Vec::new();
    let mut buf = vec![0u8; 1 << 20];

    for i in 0..archive.len() {
        let mut item = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = item.name().to_string();
        if raw == MANIFEST {
            item.read_to_string(&mut manifest)
                .map_err(|e| format!("unreadable manifest: {e}"))?;
            continue;
        }
        if item.is_dir() || !raw.starts_with(&format!("{MEDIA_DIR}/")) {
            continue;
        }
        let Some(name) = safe_name(&raw) else { continue };
        let path = dest.join(&name);
        let mut out = std::fs::File::create(&path)
            .map_err(|e| format!("could not write {name}: {e}"))?;
        loop {
            let n = item.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])
                .map_err(|e| format!("could not write {name}: {e}"))?;
        }
        media.push((name, path.to_string_lossy().into_owned()));
    }

    if manifest.is_empty() {
        return Err("not a Viewport project bundle — no project.json inside".into());
    }
    Ok(OpenedBundle { manifest, media })
}

/// Open a bundle, unpacking its media under ~/.viewport/media/<project_id>/.
/// The caller supplies the id so the extracted files sit with the project.
#[tauri::command]
pub fn bundle_read(app: AppHandle, path: String, project_id: String) -> Result<OpenedBundle, String> {
    let Some(id) = safe_name(&project_id) else {
        return Err("invalid project id".into());
    };
    let dest: PathBuf = store::root(&app)?.join(MEDIA_DIR).join(id);
    let f = std::fs::File::open(&path).map_err(|e| format!("could not open {path}: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|e| format!("not a zip: {e}"))?;
    extract_into(&mut archive, &dest)
}
