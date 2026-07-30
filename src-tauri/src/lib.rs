// Viewport desktop shell (Tauri v2). The UI is the web app (dist/); this process
// hosts it and owns everything the browser can't do: native file dialogs and
// video export (frames piped straight into ffmpeg).
//
// Everything the frontend needs is exposed as a #[tauri::command] and called via
// `invoke`, so it never depends on plugin JS globals being injected.
mod bundle;
mod ffmpeg;
mod store;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ---------- native dialogs ----------

/// Native "save as". `default_name` may be a bare file name or a full path —
/// callers that already know where the file is going (the export dialog) send
/// the path, and a path handed to `set_file_name` would land in the dialog as
/// one absurd file name. Split it so the dialog opens in the right folder with
/// the name filled in.
#[tauri::command]
fn pick_save_path(app: AppHandle, default_name: String, ext: String) -> Option<String> {
    let requested = PathBuf::from(&default_name);
    let name = requested
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(default_name);
    let mut d = app.dialog().file().set_file_name(&name);
    if let Some(parent) = requested.parent().filter(|p| p.is_dir()) {
        d = d.set_directory(parent);
    }
    d.add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file()
        .map(|p| p.to_string())
}

/// Pick one existing file with the given extension (project bundles).
#[tauri::command]
fn pick_open_path(app: AppHandle, label: String, ext: String) -> Option<String> {
    app.dialog()
        .file()
        .add_filter(&label, &[ext.as_str()])
        .blocking_pick_file()
        .map(|p| p.to_string())
}

#[tauri::command]
fn pick_media_paths(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .add_filter(
            "Media",
            &[
                "mp4", "mov", "webm", "mkv", "avi", "m4v", "png", "jpg", "jpeg", "webp", "gif",
                "bmp", "svg", "avif", "mp3", "wav", "ogg", "m4a", "flac", "aac",
            ],
        )
        .blocking_pick_files()
        .map(|v| v.into_iter().map(|p| p.to_string()).collect())
        .unwrap_or_default()
}

// ---------- video export ----------

/// A running encode. Frames don't go down the pipe on the caller's thread: a
/// `#[tauri::command]` that isn't `async` runs on the event-loop thread, so
/// `write_all` there parks the whole app for as long as ffmpeg takes to drain
/// the pipe — which, once the encoder is the slow half, is most of the export.
/// Instead a dedicated writer owns ffmpeg's stdin and `export_frame` just hands
/// bytes over. The queue is deliberately short: it's backpressure, not a buffer,
/// so a slow encoder still throttles the renderer instead of eating memory.
struct Session {
    child: Child,
    log: PathBuf,
    audio: Option<PathBuf>,
    /// `None` once the stream has been closed by `export_end`
    tx: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
    writer: Option<std::thread::JoinHandle<()>>,
    /// first write error the writer hit, if any (usually ffmpeg having exited)
    failed: std::sync::Arc<Mutex<Option<String>>>,
}
/// 0: the running encode. 1: a finished audio file waiting for `export_begin`.
/// 2: an audio file still being streamed in by `export_audio_chunk`.
#[derive(Default)]
struct Export(
    Mutex<Option<Session>>,
    Mutex<Option<PathBuf>>,
    Mutex<Option<(std::io::BufWriter<File>, PathBuf)>>,
);

/// Frames in flight between the UI and ffmpeg. Each is one batch (~24MB), so
/// this caps the queue at ~48MB before `export_frame` starts blocking.
const FRAME_QUEUE: usize = 2;

impl Session {
    /// Close the pipe and wait for every queued frame to reach ffmpeg. Dropping
    /// the sender ends the writer loop, which drops stdin and gives ffmpeg its
    /// EOF — so this has to happen before `child.wait()`, or we deadlock waiting
    /// on a process that's still waiting on input.
    fn finish_writes(&mut self) {
        self.close_sender();
        self.join_writer();
    }

    /// Stop accepting frames. The writer finishes whatever write it is in and
    /// then exits, dropping stdin — which is what gives ffmpeg its EOF.
    fn close_sender(&mut self) {
        self.tx.take();
    }

    /// Wait for the writer to actually be done. Only safe once ffmpeg is either
    /// still draining the pipe or dead: a writer parked in `write_all` on a pipe
    /// nobody is reading unblocks when the process is killed, and not before.
    fn join_writer(&mut self) {
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
    }
}

/// Is an ffmpeg available (system-wide or our own downloaded copy)?
#[tauri::command]
fn ffmpeg_available(app: AppHandle) -> bool {
    ffmpeg::resolve(&app).is_some()
}

/// Encoders and containers this ffmpeg supports — the export dialog builds its
/// choices from this, so nothing offered can fail at encode time.
#[tauri::command]
fn ffmpeg_caps(app: AppHandle) -> Result<ffmpeg::Caps, String> {
    ffmpeg::caps(&app)
}

/// Which ffmpeg binary is being used, and its version.
#[tauri::command]
fn ffmpeg_info(app: AppHandle) -> Option<ffmpeg::Info> {
    ffmpeg::info(&app)
}

/// Which of `names` this machine can actually open right now. Runs off-thread —
/// each check spawns ffmpeg — so the dialog stays responsive while it fills in.
#[tauri::command]
async fn probe_encoders(app: AppHandle, names: Vec<String>) -> Result<Vec<ffmpeg::Probe>, String> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::probe(&app, &names))
        .await
        .map_err(|e| format!("probe failed: {e}"))?
}

/// Fetch a private copy of ffmpeg into the app data directory. Runs on a worker
/// thread so the download doesn't block the webview; progress arrives as
/// `ffmpeg-download` events.
#[tauri::command]
async fn download_ffmpeg(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::download(&app).map(|_| ()))
        .await
        .map_err(|e| format!("download task failed: {e}"))?
}

/// Where exports go: a `Viewport` folder inside the user's videos directory.
///
/// Its own folder rather than the videos root, so a few exports don't get lost
/// among everything else that writes there. `video_dir` is the platform's real
/// one on all three targets (Windows `Videos` via the known folder, macOS
/// `~/Movies`, Linux `XDG_VIDEOS_DIR`) — never a hardcoded name, which is wrong
/// the moment the account is not in English or the folder has been relocated.
/// The fallbacks cover a Linux box with no XDG user-dirs configured at all.
fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let p = app.path();
    let base = p
        .video_dir()
        .or_else(|_| p.download_dir())
        .or_else(|_| p.desktop_dir())
        .or_else(|_| p.home_dir())
        .map_err(|e| format!("no place to save to: {e}"))?;
    let dir = base.join("Viewport");
    // Created here, not at first export: the dialog shows this path before
    // anything is written, and offering a folder that doesn't exist yet is how
    // a save dialog opens somewhere else entirely.
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Where exports should default to. Without an absolute path ffmpeg writes to
/// the process's working directory — which in `tauri dev` is src-tauri/, so the
/// file watcher sees the new video and restarts the app mid-export.
#[tauri::command]
fn default_export_dir(app: AppHandle) -> String {
    export_dir(&app)
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Extract a source's audio track to a standalone WAV, natively.
///
/// The web path decodes with WebAudio and re-encodes sample-by-sample on the
/// main thread, which locks the UI solid on anything long. ffmpeg does it in one
/// pass without touching the render thread.
#[tauri::command]
async fn extract_audio(app: AppHandle, input: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ff = ffmpeg::resolve(&app).ok_or("ffmpeg not found")?;
        let tmp = app.path().temp_dir().map_err(|e| format!("no temp dir: {e}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = tmp.join(format!("viewport-audio-{stamp}.wav"));

        let mut cmd = Command::new(&ff);
        // -vn drops video; 16-bit PCM matches what the timeline expects
        cmd.arg("-y")
            .arg("-i")
            .arg(&input)
            .args(["-vn", "-acodec", "pcm_s16le", "-ar", "48000"])
            .arg(&out)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        ffmpeg::hide_console(&mut cmd);

        let res = cmd.output().map_err(|e| format!("could not run ffmpeg: {e}"))?;
        if !res.status.success() {
            let err = String::from_utf8_lossy(&res.stderr);
            let last: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
            return Err(last[last.len().saturating_sub(3)..].join(" | "));
        }
        if !out.exists() {
            return Err("the source has no audio track".into());
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("extract task failed: {e}"))?
}

/// Decode one span of one source to WAV for the export mixdown, cached.
///
/// Separate from `extract_audio`, which produces a permanent asset for the
/// timeline out of a whole file. This is a scratch decode of the seconds a clip
/// actually uses — see `ffmpeg::extract_span` for why the mixdown can't just
/// hand the source to the webview.
#[tauri::command]
async fn extract_audio_span(
    app: AppHandle,
    input: String,
    start: f64,
    duration: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::extract_span(&app, &input, start, duration))
        .await
        .map_err(|e| format!("audio task failed: {e}"))?
}

/// Build (or reuse) the audio-only stand-in the preview mixer plays.
#[tauri::command]
async fn audio_proxy(app: AppHandle, input: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::audio_proxy(&app, &input))
        .await
        .map_err(|e| format!("audio proxy task failed: {e}"))?
}

/// Stage the mixed-down audio for the next export, as raw WAV bytes.
///
/// Sent separately from `export_begin` and over the raw IPC body: a long
/// timeline mixes down to hundreds of MB, and base64 would both inflate it by a
/// third and cost a giant string build on the render thread.
///
/// Streamed in chunks rather than handed over in one call. A half-hour stereo
/// mix is ~360MB, and a single IPC message that size means the webview builds a
/// 360MB body while this side holds another copy and writes it to disk — on the
/// event-loop thread, since a non-async command runs there. The UI simply stops
/// until it's done. Appending bounded chunks keeps both peaks at chunk size and
/// each write short enough not to be felt.
#[tauri::command]
fn export_audio_begin(app: AppHandle, state: State<Export>) -> Result<(), String> {
    let tmp = app.path().temp_dir().map_err(|e| format!("no temp dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let p = tmp.join(format!("viewport-audio-in-{stamp}.wav"));
    let f = File::create(&p).map_err(|e| format!("could not stage audio: {e}"))?;
    let mut slot = state.2.lock().map_err(|e| e.to_string())?;
    // a staging file left over from an abandoned export is dead weight
    if let Some((_, old)) = slot.take() {
        let _ = std::fs::remove_file(old);
    }
    *slot = Some((std::io::BufWriter::new(f), p));
    Ok(())
}

#[tauri::command]
fn export_audio_chunk(state: State<Export>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("audio must be sent as raw bytes".into());
    };
    let mut slot = state.2.lock().map_err(|e| e.to_string())?;
    let (f, _) = slot.as_mut().ok_or("audio staging not started")?;
    f.write_all(bytes).map_err(|e| format!("could not stage audio: {e}"))
}

/// Close the staging file and hand it to the next `export_begin`.
#[tauri::command]
fn export_audio_end(state: State<Export>) -> Result<(), String> {
    let (f, p) = state
        .2
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("audio staging not started")?;
    // BufWriter only surfaces a full-disk error on the final flush
    f.into_inner()
        .map_err(|e| format!("could not stage audio: {e}"))?
        .sync_all()
        .map_err(|e| format!("could not stage audio: {e}"))?;
    let mut slot = state.1.lock().map_err(|e| e.to_string())?;
    *slot = Some(p);
    Ok(())
}

/// Build (or reuse) an all-intra proxy for a source video, so per-frame seeking
/// during export doesn't have to decode from a keyframe every time.
#[tauri::command]
async fn make_proxy(
    app: AppHandle,
    input: String,
    width: u32,
    height: u32,
    // worker cap; omitted or 0 lets ffmpeg use the whole machine
    threads: Option<u32>,
) -> Result<ffmpeg::ProxyOut, String> {
    let threads = threads.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || ffmpeg::proxy(&app, &input, width, height, threads))
        .await
        .map_err(|e| format!("proxy task failed: {e}"))?
}

/// Stop the proxy transcode in flight. Cancelling used to end the frontend's
/// loop only: the ffmpeg already chewing through a multi-GB source kept going,
/// so the machine stayed busy long after the export was "cancelled".
#[tauri::command]
fn cancel_proxy() {
    ffmpeg::cancel_proxy()
}

/// Bytes held by cached proxies, and a way to drop them.
#[tauri::command]
fn proxy_size(app: AppHandle) -> u64 {
    ffmpeg::proxy_size(&app)
}
#[tauri::command]
fn clear_proxies(app: AppHandle) -> Result<(), String> {
    ffmpeg::clear_proxies(&app)
}

/// Start encoding. Frames are pushed with `export_frame` (raw RGBA) and the
/// stream is closed by `export_end`. Any audio staged by `export_audio` is muxed.
#[tauri::command]
fn export_begin(
    app: AppHandle,
    state: State<Export>,
    out: String,
    settings: ffmpeg::Settings,
) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut old) = slot.take() {
        let _ = old.child.kill();
    }

    let tmp = app
        .path()
        .temp_dir()
        .map_err(|e| format!("no temp dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    // audio was staged separately by export_audio, if there is any
    let audio_path = state.1.lock().map_err(|e| e.to_string())?.take();

    // A relative path resolves against this process's working directory, which
    // under `tauri dev` is src-tauri/ — writing a video there trips the file
    // watcher and restarts the app mid-encode. Never let that happen, whatever
    // the frontend sent.
    let requested = PathBuf::from(&out);
    let out: PathBuf = if requested.is_absolute() {
        requested
    } else {
        let name = requested
            .file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("export.mp4"));
        export_dir(&app)?.join(name)
    };

    let log_path = tmp.join(format!("viewport-ffmpeg-{stamp}.log"));
    let log = File::create(&log_path).map_err(|e| format!("could not create log: {e}"))?;

    let ff = ffmpeg::resolve(&app).ok_or("ffmpeg not found")?;
    let mut cmd = Command::new(&ff);
    // Raw RGBA rather than PNG: the renderer reads pixels straight out of the GL
    // framebuffer, so there's no image compression on the render thread and no
    // base64 across the IPC boundary. Raw frames carry no header, hence the
    // explicit size.
    if settings.wire.as_deref() == Some("h264") {
        // An encoded elementary stream: it carries its own dimensions and SPS/PPS,
        // so only the rate needs asserting (H.264 in Annex-B has no container
        // timing of its own, and without this ffmpeg assumes 25).
        cmd.args(["-y", "-f", "h264", "-framerate", &settings.fps.to_string(), "-i", "-"]);
    } else {
        let raw_fmt = settings.raw_pix_fmt.clone().unwrap_or_else(|| "rgba".into());
        cmd.args([
            "-y",
            "-f", "rawvideo",
            "-pixel_format", &raw_fmt,
            "-video_size", &format!("{}x{}", settings.width, settings.height),
            "-framerate", &settings.fps.to_string(),
            "-i", "-",
        ]);
    }
    // audio input has to be declared before the output flags that reference it
    if let Some(a) = &audio_path {
        cmd.arg("-i").arg(a);
    }
    // codec / quality / container flags, all chosen in the export dialog
    let mut s = settings.clone();
    if audio_path.is_none() {
        s.a_codec = None; // nothing to encode; emits -an
    }
    cmd.args(ffmpeg::output_args(&s));
    cmd.arg(&out);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        // a file (not a pipe) so ffmpeg can never block on an unread stderr
        .stderr(Stdio::from(log));
    ffmpeg::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        format!("could not start ffmpeg — install it and make sure it's on PATH ({e})")
    })?;

    // Hand stdin to a writer thread; from here on nothing touches the pipe on
    // the event-loop thread. Taking it out of `child` also means `export_end`
    // can't close it out from under the queue — the writer's own exit does that.
    let mut stdin = child.stdin.take().ok_or("ffmpeg stdin unavailable")?;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(FRAME_QUEUE);
    let failed = std::sync::Arc::new(Mutex::new(None::<String>));
    let slot_failed = failed.clone();
    let writer = std::thread::spawn(move || {
        for frame in rx {
            if let Err(e) = stdin.write_all(&frame) {
                if let Ok(mut f) = slot_failed.lock() {
                    f.get_or_insert(format!("ffmpeg stopped accepting frames ({e})"));
                }
                break; // pipe is gone; drain nothing, the export is already lost
            }
        }
        // stdin drops here → ffmpeg sees EOF and finalises the container
    });

    *slot = Some(Session {
        child,
        log: log_path,
        audio: audio_path,
        tx: Some(tx),
        writer: Some(writer),
        failed,
    });
    Ok(())
}

/// Queue one raw RGBA frame for ffmpeg's stdin.
///
/// Takes the IPC body directly instead of a base64 string — a 1080p frame is
/// 8MB, and base64 would inflate that by a third and cost a full string build
/// per frame on the render thread.
///
/// Returns as soon as the bytes are handed to the writer thread, so the render
/// side gets on with the next frame while this one is still going down the pipe.
/// It only blocks once `FRAME_QUEUE` frames are already waiting, which is the
/// point at which the encoder — not us — is what's setting the pace.
#[tauri::command]
fn export_frame(state: State<Export>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("frame must be sent as raw bytes".into());
    };
    // Take a handle to the queue and release the lock *before* blocking on it.
    //
    // Sending holds this thread until the writer has room, and this is the
    // event-loop thread. Doing that with the session lock still held means no
    // other command can touch the export while we wait — including
    // `export_cancel`, which is precisely the one you reach for when the queue
    // is full because ffmpeg has fallen behind. A cloned sender keeps the
    // channel open only for as long as this call, and if a cancel kills ffmpeg
    // in the meantime the writer dies, the receiver drops, and the send below
    // returns an error instead of waiting forever.
    let (tx, log) = {
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        let s = slot.as_mut().ok_or("export not started")?;
        // A write failure surfaces on the writer thread, so it's reported here
        // on the next frame. ffmpeg having exited is the usual cause and its log
        // holds the real reason, so lead with that; the pipe error is the symptom.
        if let Ok(f) = s.failed.lock() {
            if let Some(e) = f.clone() {
                let log = tail(&s.log);
                return Err(if log.is_empty() { e } else { log });
            }
        }
        (
            s.tx.clone().ok_or("export already finished")?,
            s.log.clone(),
        )
    };
    tx.send(bytes.to_vec()).map_err(|_| {
        let log = tail(&log);
        if log.is_empty() {
            "ffmpeg stopped accepting frames".to_string()
        } else {
            log
        }
    })?;
    Ok(())
}

/// Close the stream and wait for ffmpeg to finish writing the file.
#[tauri::command]
fn export_end(state: State<Export>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    let mut s = slot.take().ok_or("export not started")?;
    s.finish_writes(); // flush the queue, then EOF → ffmpeg finalises the container
    if let Ok(f) = s.failed.lock() {
        if let Some(e) = f.clone() {
            let log = tail(&s.log);
            return Err(if log.is_empty() { e } else { log });
        }
    }
    let status = s.child.wait().map_err(|e| format!("ffmpeg wait failed: {e}"))?;
    let log = tail(&s.log);
    let _ = std::fs::remove_file(&s.log);
    if let Some(a) = &s.audio {
        let _ = std::fs::remove_file(a);
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("ffmpeg failed ({status}). {log}"))
    }
}

/// Abort an in-flight export (dialog cancelled, render error, …).
#[tauri::command]
fn export_cancel(state: State<Export>) {
    // an export can be abandoned before it ever reaches the encoder — while a
    // proxy is still transcoding — and that ffmpeg has to go too
    ffmpeg::cancel_proxy();
    if let Ok(mut slot) = state.0.lock() {
        if let Some(mut s) = slot.take() {
            // Stop feeding it and let it close the file properly rather than
            // killing it outright. A killed ffmpeg leaves an mp4 with no moov
            // atom, which no player will open — so a cancelled export used to
            // produce a file that existed but was useless. Finalising costs a
            // moment and makes the partial genuinely watchable, which is the
            // only way to check a long export without sitting through all of it.
            //
            // Order matters. Close the sender, wait on ffmpeg, and only join the
            // writer at the very end: joining first deadlocks whenever the
            // writer is parked in write_all on a pipe ffmpeg has stopped
            // draining, and nothing frees it there but killing the process.
            // This runs on the event-loop thread, so that hang is the whole UI.
            s.close_sender();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match s.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(25))
                    }
                    // wedged, or already gone — fall back to the blunt instrument
                    _ => {
                        let _ = s.child.kill();
                        let _ = s.child.wait();
                        break;
                    }
                }
            }
            s.join_writer();
            let _ = std::fs::remove_file(&s.log);
            if let Some(a) = &s.audio {
                let _ = std::fs::remove_file(a);
            }
        }
    }
    // Audio staged for an export that never ran must not survive it. Both slots
    // are consumed by the *next* `export_begin`, so leaving them populated mixes
    // one project's soundtrack into another's video.
    if let Ok(mut staged) = state.1.lock() {
        if let Some(p) = staged.take() {
            let _ = std::fs::remove_file(p);
        }
    }
    if let Ok(mut partial) = state.2.lock() {
        if let Some((_, p)) = partial.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Last few KB of the ffmpeg log — the useful part of its error output.
fn tail(path: &PathBuf) -> String {
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(2000);
    let _ = f.seek(SeekFrom::Start(from));
    let mut s = String::new();
    let _ = f.read_to_string(&mut s);
    // last few lines, still in the order ffmpeg printed them — reversing turns
    // a readable failure into a puzzle
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(6)..].join(" | ")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Export::default())
        .manage(ffmpeg::Ff::default())
        .invoke_handler(tauri::generate_handler![
            pick_save_path,
            pick_media_paths,
            pick_open_path,
            ffmpeg_available,
            ffmpeg_caps,
            ffmpeg_info,
            probe_encoders,
            extract_audio,
            extract_audio_span,
            audio_proxy,
            export_audio_begin,
            export_audio_chunk,
            export_audio_end,
            make_proxy,
            cancel_proxy,
            proxy_size,
            clear_proxies,
            default_export_dir,
            store::store_dir,
            store::store_read,
            store::store_write,
            store::store_remove,
            store::store_list,
            bundle::bundle_write,
            bundle::bundle_read,
            download_ffmpeg,
            export_begin,
            export_frame,
            export_end,
            export_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Viewport");
}
