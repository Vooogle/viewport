// Finding — and if need be fetching — ffmpeg.
//
// The app ships without it: a bundled copy would add ~60MB to every download,
// and most of that is codecs a given user never touches. Instead we look for one
// the system already has, and only if there isn't one do we pull a private copy
// into the app's data directory, once, behind a progress bar. Nothing is
// installed system-wide and the user never touches a package manager.
//
// The Windows/Linux builds are LGPL (no libx264) so distribution stays clean;
// H.264 comes from libopenh264 plus the platform encoders (h264_mf, nvenc, qsv,
// amf, videotoolbox, vaapi).
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const EXE: &str = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

/// Resolved ffmpeg path and probed capabilities, remembered for the session.
/// A download clears the path so the next lookup picks up the new copy.
#[derive(Default)]
pub struct Ff {
    pub path: Mutex<Option<PathBuf>>,
    pub caps: Mutex<Option<Caps>>,
    /// encoder name → does it open on this machine (see `probe`)
    pub probes: Mutex<std::collections::HashMap<String, Probe>>,
}

/// Does this path run? (`-version` exits 0 for a real ffmpeg.)
fn runs(p: &Path) -> bool {
    let mut cmd = Command::new(p);
    cmd.arg("-version").stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Keep ffmpeg from flashing a console window on Windows.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Where a downloaded copy lives: <app data>/ffmpeg/.
fn store_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ffmpeg"))
}

/// Every place ffmpeg might be, best first. PATH is a *candidate*, not the
/// contract — winget's Gyan.FFmpeg, for one, installs without touching PATH, so
/// checking PATH alone reports "missing" on a machine that has it.
fn candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut v = Vec::new();

    // 1. our own downloaded copy
    if let Some(d) = store_dir(app) {
        v.push(d.join("bin").join(EXE));
        v.push(d.join(EXE));
    }
    // 2. a copy dropped next to the app
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join(EXE));
        }
    }
    // 3. PATH
    v.push(PathBuf::from("ffmpeg"));
    // 4. common installs that skip PATH
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let pkgs = PathBuf::from(&local).join("Microsoft\\WinGet\\Packages");
            // …\Gyan.FFmpeg_…\ffmpeg-<ver>-full_build\bin\ffmpeg.exe
            if let Ok(rd) = std::fs::read_dir(&pkgs) {
                for pkg in rd.flatten() {
                    if !pkg.file_name().to_string_lossy().contains("FFmpeg") {
                        continue;
                    }
                    if let Ok(inner) = std::fs::read_dir(pkg.path()) {
                        for b in inner.flatten() {
                            v.push(b.path().join("bin").join(EXE));
                        }
                    }
                }
            }
            v.push(PathBuf::from(&local).join("Microsoft\\WinGet\\Links").join(EXE));
        }
        for base in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(p) = std::env::var(base) {
                v.push(PathBuf::from(p).join("ffmpeg").join("bin").join(EXE));
            }
        }
    }
    #[cfg(not(windows))]
    {
        for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"] {
            v.push(PathBuf::from(p).join(EXE));
        }
    }
    v
}

/// First candidate that actually runs. Cached; re-probed if the cached one dies.
pub fn resolve(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<Ff>();
    let mut slot = state.path.lock().ok()?;
    if let Some(p) = slot.as_ref() {
        if runs(p) {
            return Some(p.clone());
        }
    }
    let found = candidates(app).into_iter().find(|p| runs(p));
    *slot = found.clone();
    found
}

// ---------- encoder choice ----------

/// H.264 encoders this ffmpeg actually has, since builds differ wildly: a distro
/// ffmpeg usually has libx264, while the LGPL build we download does not (that's
/// what keeps it LGPL) and encodes with libopenh264 instead.
fn encoder_list(ff: &Path) -> String {
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-encoders"]).stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Names out of an `ffmpeg -encoders`/-muxers table. Each row is
/// ` V....D name  description`, so the second token is the name.
fn table_names(text: &str) -> Vec<String> {
    text.lines()
        .skip_while(|l| !l.trim_start().starts_with("---"))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let flags = it.next()?;
            let name = it.next()?;
            // skip the header/separator rows and anything that isn't a real entry
            (!flags.contains("---") && !name.contains("=")).then(|| name.to_string())
        })
        .collect()
}

fn muxer_list(ff: &Path) -> String {
    let mut cmd = Command::new(ff);
    cmd.args(["-hide_banner", "-muxers"]).stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Everything this ffmpeg build supports — the whole list, unfiltered. Whether
/// a given encoder works on *this* machine is answered separately by `probe()`,
/// which annotates the dialog rather than hiding anything.
#[derive(serde::Serialize, Clone)]
pub struct Caps {
    pub encoders: Vec<String>,
    pub muxers: Vec<String>,
}

pub fn caps(app: &AppHandle) -> Result<Caps, String> {
    let state = app.state::<Ff>();
    if let Ok(c) = state.caps.lock() {
        if let Some(c) = c.as_ref() {
            return Ok(c.clone());
        }
    }
    let ff = resolve(app).ok_or("ffmpeg not found")?;
    let out = Caps {
        encoders: table_names(&encoder_list(&ff)),
        muxers: table_names(&muxer_list(&ff)),
    };
    if let Ok(mut c) = state.caps.lock() {
        *c = Some(out.clone());
    }
    Ok(out)
}

/// Which ffmpeg is in use. Worth showing: capability differs sharply between
/// builds (an 8.x build needs NVIDIA driver 610+ for NVENC, our pinned 7.1 does
/// not), so "which binary" is often the answer to "why is that encoder dead".
#[derive(serde::Serialize)]
pub struct Info {
    pub path: String,
    pub version: String,
    /// true when this is the copy we downloaded, not a system install
    pub ours: bool,
}

pub fn info(app: &AppHandle) -> Option<Info> {
    let ff = resolve(app)?;
    let mut cmd = Command::new(&ff);
    cmd.arg("-version").stderr(Stdio::null());
    hide_console(&mut cmd);
    // "ffmpeg version n7.1.5-10-g2aefd64d48-20260726 Copyright (c) …" → "7.1.5"
    let version = cmd
        .output()
        .ok()
        .and_then(|o| {
            let first = String::from_utf8_lossy(&o.stdout).lines().next()?.to_string();
            let raw = first.split_whitespace().nth(2)?;
            let short = raw.trim_start_matches('n').split('-').next()?.to_string();
            Some(if short.is_empty() { raw.to_string() } else { short })
        })
        .unwrap_or_default();
    let ours = store_dir(app).is_some_and(|d| ff.starts_with(d));
    Some(Info { path: ff.to_string_lossy().into_owned(), version, ours })
}

/// One encoder's live status on this machine.
#[derive(serde::Serialize, Clone)]
pub struct Probe {
    pub name: String,
    pub ok: bool,
    /// why it failed, in ffmpeg's own words — the difference between a dead end
    /// and "update your driver"
    pub reason: String,
}

/// Pick the line that actually explains a failure. ffmpeg prints the useful
/// cause first and generic "Error while opening encoder" noise after it.
fn why(stderr: &str) -> String {
    const SIGNALS: [&str; 7] = [
        "Driver does not support",
        "minimum required",
        "Cannot load",
        "No capable devices",
        "not supported",
        "No device available",
        "Failed to initialise",
    ];
    for l in stderr.lines() {
        let t = l.trim();
        if SIGNALS.iter().any(|s| t.contains(s)) {
            // strip the "[h264_nvenc @ 0x…] " prefix
            return t.rsplit_once("] ").map(|(_, m)| m).unwrap_or(t).to_string();
        }
    }
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("unavailable")
        .to_string()
}

/// Can this machine actually *open* the encoder right now? A hardware encoder is
/// listed whether or not the GPU (or a new enough driver) is there, so the only
/// honest test is running one throwaway frame through it. Labels the dialog —
/// never hides an option.
fn opens(ff: &Path, enc: &str) -> Probe {
    let mut cmd = Command::new(ff);
    cmd.args([
        "-hide_banner", "-loglevel", "warning",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25:d=0.1",
        "-frames:v", "1", "-c:v", enc, "-f", "null", "-",
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    hide_console(&mut cmd);
    match cmd.output() {
        Ok(o) if o.status.success() => Probe { name: enc.into(), ok: true, reason: String::new() },
        Ok(o) => Probe {
            name: enc.into(),
            ok: false,
            reason: why(&String::from_utf8_lossy(&o.stderr)),
        },
        Err(e) => Probe { name: enc.into(), ok: false, reason: e.to_string() },
    }
}

/// Live availability for the named encoders. Remembered for the session so
/// reopening the dialog is instant.
pub fn probe(app: &AppHandle, names: &[String]) -> Result<Vec<Probe>, String> {
    let ff = resolve(app).ok_or("ffmpeg not found")?;
    let state = app.state::<Ff>();
    let mut out = Vec::new();
    for n in names {
        let cached = state.probes.lock().ok().and_then(|m| m.get(n).cloned());
        let p = cached.unwrap_or_else(|| {
            let p = opens(&ff, n);
            if let Ok(mut m) = state.probes.lock() {
                m.insert(n.clone(), p.clone());
            }
            p
        });
        out.push(p);
    }
    Ok(out)
}

/// Everything the export dialog decides. The UI resolves concrete encoder names
/// against `caps()`, so this side only turns those choices into ffmpeg flags.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub container: String, // mp4 | mov | mkv | webm | gif
    pub fps: u32,
    // required now that frames arrive as rawvideo: unlike PNG, raw bytes carry
    // no dimensions, so the demuxer has to be told the frame size
    pub width: u32,
    pub height: u32,
    /// Wire format of the frames arriving on stdin. The renderer packs yuv420p
    /// on the GPU when it can — 1.5 bytes per pixel instead of 4, which is the
    /// difference that matters when the pipe, not the encoder, is the limit.
    /// Absent means the old RGBA path.
    pub raw_pix_fmt: Option<String>,
    /// What arrives on stdin: "rawvideo" (frames we encode here) or "h264" (an
    /// elementary stream the webview already encoded, which we only mux).
    pub wire: Option<String>,
    pub v_codec: String,
    /// constant-quality value; whichever of crf/vBitrate is set picks the mode
    pub crf: Option<f32>,
    pub v_bitrate: Option<u64>,
    /// the speed↔compression knob, plus the flag it belongs on. The dialog picks
    /// both together because the spelling is per-ENCODER, not per-codec: x264
    /// wants "veryslow" on -preset, NVENC wants p1–p7, AMF wants a word on
    /// -quality, VP9/AV1 want a number on -cpu-used. Guessing here is how you
    /// get `Unable to parse "preset" option value "veryslow"`.
    pub preset: Option<String>,
    pub preset_flag: Option<String>,
    pub pix_fmt: Option<String>,
    pub profile: Option<String>,
    pub a_codec: Option<String>,
    pub a_bitrate: Option<u64>,
    /// GIF only
    pub dither: Option<String>,
    /// raw ffmpeg flags appended last, so they win over everything above
    pub extra_args: Option<String>,
}

/// The output half of the command line (everything after the inputs).
pub fn output_args(s: &Settings) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();

    // Already encoded upstream — re-encoding it here would throw away the whole
    // point and cost quality twice over. Audio and container flags still apply.
    if s.wire.as_deref() == Some("h264") {
        // Map explicitly and *don't* pass -shortest. An H.264 elementary stream
        // arriving on a pipe carries no duration of its own, and -shortest then
        // finishes the file before the audio encoder has produced anything — the
        // output comes out video-only. Nothing is lost by dropping it: both
        // streams are generated to the timeline length, so there is no overhang
        // for it to trim.
        if s.a_codec.is_some() {
            a.push("-map".into());
            a.push("0:v:0".into());
            a.push("-map".into());
            a.push("1:a:0".into());
        }
        a.push("-c:v".into());
        a.push("copy".into());
        push_audio(&mut a, s, false);
        if matches!(s.container.as_str(), "mp4" | "mov") {
            a.push("-movflags".into());
            a.push("+faststart".into());
        }
        push_extra(&mut a, s);
        return a;
    }

    if s.container == "gif" {
        // GIF without a generated palette quantises to a muddy fixed 256 colours
        let d = s.dither.clone().unwrap_or_else(|| "bayer".into());
        a.push("-vf".into());
        a.push(format!(
            "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither={d}"
        ));
        a.push("-loop".into());
        a.push("0".into());
        push_extra(&mut a, s);
        return a;
    }

    a.push("-c:v".into());
    a.push(s.v_codec.clone());

    // constant quality where the encoder has it, otherwise a target bitrate
    let c = s.v_codec.as_str();
    match (s.crf, s.v_bitrate) {
        (Some(q), _) if c.starts_with("libx26") || c.starts_with("libsvtav1") || c.starts_with("libaom") => {
            a.push("-crf".into());
            a.push(format!("{q}"));
        }
        (Some(q), _) if c.starts_with("libvpx") => {
            // VP9 constant quality only engages with an explicit -b:v 0
            a.push("-crf".into());
            a.push(format!("{q}"));
            a.push("-b:v".into());
            a.push("0".into());
        }
        (Some(q), _) if c.contains("videotoolbox") || c.starts_with("prores") => {
            a.push("-q:v".into());
            a.push(format!("{q}"));
        }
        (_, Some(b)) => {
            a.push("-b:v".into());
            a.push(b.to_string());
        }
        _ => {}
    }

    // only emitted when the dialog supplied both the value and its flag
    if let (Some(p), Some(flag)) = (&s.preset, &s.preset_flag) {
        a.push(flag.clone());
        a.push(p.clone());
    }
    if let Some(p) = &s.profile {
        a.push("-profile:v".into());
        a.push(p.clone());
    }
    if let Some(p) = &s.pix_fmt {
        a.push("-pix_fmt".into());
        a.push(p.clone());
    }

    push_audio(&mut a, s, true);

    if matches!(s.container.as_str(), "mp4" | "mov") {
        a.push("-movflags".into());
        a.push("+faststart".into());
    }
    push_extra(&mut a, s);
    a
}

/// Audio codec flags, shared by every output path. `shortest` is off for wire
/// formats where it silently costs the audio track — see `output_args`.
fn push_audio(a: &mut Vec<String>, s: &Settings, shortest: bool) {
    match &s.a_codec {
        Some(ac) => {
            a.push("-c:a".into());
            a.push(ac.clone());
            // lossless/uncompressed codecs reject a bitrate
            if let Some(b) = s.a_bitrate {
                if !matches!(ac.as_str(), "flac" | "alac" | "pcm_s16le" | "pcm_s24le") {
                    a.push("-b:a".into());
                    a.push(b.to_string());
                }
            }
            if shortest {
                a.push("-shortest".into());
            }
        }
        None => a.push("-an".into()),
    }
}

/// User-supplied flags go on last: ffmpeg lets a later option override an
/// earlier one, so this is what makes the field genuinely useful.
fn push_extra(a: &mut Vec<String>, s: &Settings) {
    if let Some(extra) = &s.extra_args {
        a.extend(extra.split_whitespace().map(str::to_string));
    }
}

// ---------- download ----------

/// Release build for this OS/arch, and whether it's a zip or an xz'd tar.
/// Versions are pinned so a moving upstream build can't break exports.
fn source() -> Result<(&'static str, bool), String> {
    if cfg!(windows) {
        Ok((
            concat!(
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/",
                "ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip"
            ),
            true,
        ))
    } else if cfg!(target_os = "macos") {
        // BtbN has no macOS build; evermeet ships a static binary (~24MB)
        Ok(("https://evermeet.cx/ffmpeg/getrelease/zip", true))
    } else if cfg!(target_os = "linux") {
        Ok((
            if cfg!(target_arch = "aarch64") {
                concat!(
                    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/",
                    "ffmpeg-n7.1-latest-linuxarm64-lgpl-shared-7.1.tar.xz"
                )
            } else {
                concat!(
                    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/",
                    "ffmpeg-n7.1-latest-linux64-lgpl-shared-7.1.tar.xz"
                )
            },
            false,
        ))
    } else {
        Err("no ffmpeg build for this platform".into())
    }
}

/// The files we keep out of a release archive: ffmpeg itself plus, for shared
/// builds, the libraries it loads. ffplay/ffprobe and the headers are dropped.
fn wanted(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if base == EXE {
        return true;
    }
    let lower = base.to_ascii_lowercase();
    (lower.ends_with(".dll") || lower.contains(".so") || lower.ends_with(".dylib"))
        && ["avcodec", "avformat", "avutil", "avfilter", "avdevice", "swresample", "swscale"]
            .iter()
            .any(|l| lower.starts_with(l) || lower.starts_with(&format!("lib{l}")))
}

/// Where a member lands under our store. The archive's `bin/` and `lib/` split
/// is preserved: the Linux shared build finds its .so files through an RPATH of
/// `$ORIGIN/../lib`, so flattening the two together would break it. Anything
/// else (evermeet's bare `ffmpeg`) goes at the top, which `candidates()` checks.
fn dest_for(dir: &Path, name: &str) -> PathBuf {
    let parts: Vec<&str> = name.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let base = *parts.last().unwrap_or(&name);
    match parts.len() >= 2 && matches!(parts[parts.len() - 2], "bin" | "lib") {
        true => dir.join(parts[parts.len() - 2]).join(base),
        false => dir.join(base),
    }
}

fn place(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let dest = dest_for(dir, name);
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("could not create {p:?}: {e}"))?;
    }
    std::fs::write(&dest, bytes).map_err(|e| format!("could not write {dest:?}: {e}"))?;
    #[cfg(unix)]
    if dest.file_name().is_some_and(|f| f == EXE) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

fn unpack_zip(data: &[u8], dir: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if f.is_dir() || !wanted(&name) {
            continue;
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        place(dir, &name, &buf)?;
    }
    Ok(())
}

fn unpack_tar_xz(data: &[u8], dir: &Path) -> Result<(), String> {
    let mut tar_bytes = Vec::new();
    lzma_rs::xz_decompress(&mut std::io::Cursor::new(data), &mut tar_bytes)
        .map_err(|e| format!("could not decompress: {e:?}"))?;
    let mut ar = tar::Archive::new(std::io::Cursor::new(tar_bytes));
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let mut e = entry.map_err(|e| e.to_string())?;
        let name = e.path().map_err(|e| e.to_string())?.display().to_string();
        if !wanted(&name) {
            continue;
        }
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        place(dir, &name, &buf)?;
    }
    Ok(())
}

/// Fetch ffmpeg into the app data directory, reporting progress as it goes.
/// Emits `ffmpeg-download` with `{ received, total }` in bytes.
pub fn download(app: &AppHandle) -> Result<PathBuf, String> {
    let (url, is_zip) = source()?;
    let dir = store_dir(app).ok_or("no app data directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;

    let res = ureq::get(url)
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total: u64 = res
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut body = res.into_reader();
    let mut data: Vec<u8> = Vec::with_capacity(total.max(1) as usize);
    let mut chunk = vec![0u8; 1 << 16];
    let mut last = 0u64;
    loop {
        let n = body.read(&mut chunk).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        // don't spam the UI — one event per ~1MB
        if data.len() as u64 - last > 1 << 20 {
            last = data.len() as u64;
            let _ = app.emit("ffmpeg-download", (last, total));
        }
    }
    let _ = app.emit("ffmpeg-download", (data.len() as u64, total));

    if is_zip {
        unpack_zip(&data, &dir)?;
    } else {
        unpack_tar_xz(&data, &dir)?;
    }

    // shared builds keep ffmpeg in bin/, static ones sit at the top
    let exe = [dir.join("bin").join(EXE), dir.join(EXE)]
        .into_iter()
        .find(|p| runs(p))
        .ok_or("the downloaded ffmpeg would not run")?;
    // let the next resolve() find it
    if let Ok(mut slot) = app.state::<Ff>().path.lock() {
        *slot = Some(exe.clone());
    }
    // a new binary means new capabilities and new encoder availability
    if let Ok(mut c) = app.state::<Ff>().caps.lock() {
        *c = None;
    }
    if let Ok(mut p) = app.state::<Ff>().probes.lock() {
        p.clear();
    }
    Ok(exe)
}

// ---------- all-intra export proxies ----------

/// Encoder + flags for an all-intra proxy, fastest usable first.
///
/// `-g 1` makes every frame a keyframe. That's the whole point: seeking a normal
/// video means decoding forward from the previous keyframe, which is what makes
/// frame-by-frame export crawl. With no inter-frame dependencies a seek is a
/// direct read, so the existing <video> path becomes fast without a JS demuxer.
///
/// Availability is decided by `probe`, not by the `-encoders` listing. A listed
/// encoder is one the build was compiled with — it says nothing about whether it
/// opens on this machine. An ffmpeg 8.x build lists h264_nvenc on a box whose
/// NVIDIA driver is too old for it, and picking it off the list meant every
/// proxy failed, every export silently fell back to the original inter-frame
/// sources, and frame-by-frame seeking crawled. Opening a throwaway encoder
/// costs one ffmpeg spawn, is cached for the session, and is the only honest
/// answer. `opens()` tests bare `-c:v <name>`; every flag below is a speed or
/// quality knob, so nothing here can turn a working encoder into a broken one.
/// `threads` caps ffmpeg's worker count; 0 leaves it to take what it likes.
///
/// An export's proxy is on the critical path and should have the machine. A
/// preview's is built in the background while someone is working, and a
/// transcode that takes every core starves the audio decoders along with
/// everything else — heard as the preview cutting out.
fn proxy_args(app: &AppHandle, ff: &Path, threads: u32) -> Vec<String> {
    let list = encoder_list(ff);
    let s = |v: &str| v.to_string();
    // GPU first — proxying is pure transcode, exactly what these are good at
    let ladder: [(&str, Vec<String>); 4] = [
        ("h264_nvenc", vec![s("-preset"), s("p1"), s("-g"), s("1"), s("-cq"), s("18")]),
        ("h264_qsv", vec![s("-preset"), s("veryfast"), s("-g"), s("1")]),
        ("h264_amf", vec![s("-quality"), s("speed"), s("-g"), s("1")]),
        ("libx264", vec![s("-preset"), s("ultrafast"), s("-g"), s("1"), s("-crf"), s("16")]),
    ];
    for (name, flags) in ladder {
        if !list.contains(name) {
            continue;
        }
        let ok = probe(app, &[name.to_string()])
            .map(|p| p.first().is_some_and(|p| p.ok))
            .unwrap_or(false);
        if ok {
            let mut a = vec![s("-c:v"), s(name)];
            a.extend(flags);
            if threads > 0 {
                a.push(s("-threads"));
                a.push(threads.to_string());
            }
            return a;
        }
    }
    // last resort: the LGPL build's software H.264, always present in our copy
    let mut a = vec![s("-c:v"), s("libopenh264"), s("-g"), s("1"), s("-b:v"), s("20000000")];
    if threads > 0 {
        a.push(s("-threads"));
        a.push(threads.to_string());
    }
    a
}

/// What `proxy` returns: where the proxy is, plus the source's frame rate as
/// ffmpeg reported it (0.0 when it couldn't be parsed). The renderer uses the
/// rate to skip seeks that land on the frame a decoder is already showing — at
/// 60fps out of a 24fps source that is well over half of them.
#[derive(serde::Serialize, Clone)]
pub struct ProxyOut {
    pub path: String,
    pub fps: f64,
}

/// Pull the input stream's frame rate out of a transcode's stderr.
///
/// The input line reads "…, 1939 kb/s, 23.98 fps, 23.98 tbr, …" — progress
/// lines spell it "fps=" so matching " fps," can't land on one of those.
/// ffmpeg prints NTSC rates rounded (23.98); snapped back to the exact value,
/// or frame indices computed from it drift across a long timeline.
fn parse_fps(log: &str) -> f64 {
    let Some(idx) = log.find(" fps,").or_else(|| log.find(" fps ")) else {
        return 0.0;
    };
    let num: String = log[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let v: f64 = num.parse().unwrap_or(0.0);
    for base in [24.0, 25.0, 30.0, 50.0, 60.0, 120.0] {
        let ntsc = base * 1000.0 / 1001.0;
        if (v - ntsc).abs() < 0.01 {
            return ntsc;
        }
        if (v - base).abs() < 0.005 {
            return base;
        }
    }
    v
}

/// Sidecar holding the parsed frame rate, so a cached proxy keeps it too.
fn fps_path(out: &Path) -> PathBuf {
    out.with_extension("fps")
}

fn read_fps(out: &Path) -> f64 {
    std::fs::read_to_string(fps_path(out))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0.0)
}

/// Stable identity for a source: path + size + mtime, so an edited file is
/// re-made but an unchanged one is reused across runs. Every cached stand-in
/// starts with this and adds whatever else distinguishes it.
fn ident(input: &Path) -> String {
    let meta = std::fs::metadata(input).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // cheap FNV-1a over the identity — no crypto needed, just a stable filename
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in input.to_string_lossy().as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}-{len}-{mtime}")
}

/// Name for a video proxy. The export box is part of it — a proxy scaled for a
/// 1080p export is the wrong source for a 4K one, and reusing it would quietly
/// cap the output's detail.
fn proxy_name(input: &Path, w: u32, h: u32) -> String {
    format!("{}-{w}x{h}.mp4", ident(input))
}

/// Transcode `input` to an all-intra proxy, reusing a cached one when possible.
///
/// `w`×`h` is the export frame size. Everything is drawn into a canvas that
/// size, so decoding anything larger is detail that gets thrown away on every
/// single frame — and at export we decode one frame per output frame. A 4K
/// source feeding a 1080p export costs 4x the decode for pixels nobody sees.
pub fn proxy(app: &AppHandle, input: &str, w: u32, h: u32, threads: u32) -> Result<ProxyOut, String> {
    let src = Path::new(input);
    let dir = store_dir(app).ok_or("no app data directory")?.join("proxies");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    let out = dir.join(proxy_name(src, w, h));
    if out.exists() {
        // Already proxied. A cache from before the fps sidecar existed has no
        // rate on file — read it off the proxy's own header (one ffmpeg spawn,
        // no decode; it errors out after printing the stream info, which is all
        // we want) and backfill the sidecar so this happens once.
        let mut fps = read_fps(&out);
        if fps == 0.0 {
            if let Some(ff) = resolve(app) {
                let mut cmd = Command::new(&ff);
                cmd.arg("-hide_banner").arg("-i").arg(&out).stdout(Stdio::null()).stderr(Stdio::piped());
                hide_console(&mut cmd);
                if let Ok(o) = cmd.output() {
                    fps = parse_fps(&String::from_utf8_lossy(&o.stderr));
                    if fps > 0.0 {
                        let _ = std::fs::write(fps_path(&out), format!("{fps}"));
                    }
                }
            }
        }
        return Ok(ProxyOut { path: out.to_string_lossy().into_owned(), fps });
    }

    let ff = resolve(app).ok_or("ffmpeg not found")?;
    let mut cmd = Command::new(&ff);
    cmd.arg("-y").arg("-i").arg(src);
    // video only: audio is mixed separately and would just bloat the proxy
    cmd.arg("-an");
    cmd.args(proxy_args(app, &ff, threads));
    // Fit inside the export box without ever upscaling (min(iw,w) clamps the
    // box to the source first) and with the aspect ratio held exactly — the
    // renderer sizes clips from videoWidth/videoHeight, so a changed aspect
    // would move things on screen. force_divisible_by keeps dims even for
    // yuv420p. Commas are escaped: this is one filtergraph argument.
    cmd.arg("-vf").arg(format!(
        "scale=w='min(iw\\,{w})':h='min(ih\\,{h})':force_original_aspect_ratio=decrease:force_divisible_by=2"
    ));
    cmd.args(["-pix_fmt", "yuv420p"]);
    // stderr to a file rather than a pipe: the process is waited on by polling
    // (so a cancel can kill it), and nothing is draining a pipe in the meantime —
    // a chatty ffmpeg would fill it and block forever.
    let err_path = out.with_extension("log");
    let errf = File::create(&err_path).map_err(|e| format!("could not create log: {e}"))?;
    cmd.arg(&out).stdout(Stdio::null()).stderr(Stdio::from(errf));
    hide_console(&mut cmd);

    let child = cmd.spawn().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let status = track_and_wait(child)?;
    let finish = |e: String| -> String {
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&err_path);
        e
    };
    // killed by `cancel_proxy` — the export it belonged to is gone
    let Some(status) = status else {
        return Err(finish("cancelled".into()));
    };
    // An encoder that fails to open still creates the output file and can still
    // exit 0, leaving an empty proxy that would be "cached" and reused forever.
    let empty = std::fs::metadata(&out).map(|m| m.len() == 0).unwrap_or(true);
    if !status.success() || empty {
        let err = std::fs::read_to_string(&err_path).unwrap_or_default();
        let last: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        let msg = if last.is_empty() {
            "ffmpeg wrote an empty proxy".to_string()
        } else {
            last[last.len().saturating_sub(3)..].join(" | ")
        };
        return Err(finish(msg));
    }
    // the transcode's own stderr already names the input's frame rate — read it
    // before the log goes away, and keep it beside the proxy for cache hits
    let fps = parse_fps(&std::fs::read_to_string(&err_path).unwrap_or_default());
    let _ = std::fs::write(fps_path(&out), format!("{fps}"));
    let _ = std::fs::remove_file(&err_path);
    Ok(ProxyOut { path: out.to_string_lossy().into_owned(), fps })
}

/// Name for one span of one source's audio. The span is in the name, in
/// milliseconds — a re-cut clip needs a different span of the same file, and
/// the two must not collide.
fn span_name(input: &Path, start: f64, dur: f64) -> String {
    let ms = |v: f64| (v * 1000.0).round().max(0.0) as u64;
    format!("{}-a{}-{}.wav", ident(input), ms(start), ms(dur))
}

/// Decode just the span of a source the timeline actually uses to 48 kHz 16-bit
/// PCM WAV, and return its path. Cached beside the proxies, on the same identity.
///
/// The mixdown used to fetch whole sources into the webview and hand them to
/// `decodeAudioData`, which needs the entire file in RAM and decodes the entire
/// audio track. A twenty-second cut out of an hour of 4K footage therefore read
/// gigabytes and decoded an hour of sound to produce twenty seconds of it —
/// which is what "freezes on Mixing N audio sources" was.
///
/// It also fixes the silences. The webview's demuxer refuses containers and
/// codecs ffmpeg reads without blinking (.mov, AC-3, multi-track), and every
/// refusal was a clip that simply had no sound in the export while the ones
/// either side of it were fine.
///
/// Seeks in two stages: coarsely before `-i` (a keyframe-accurate jump that
/// costs nothing) and the remainder after it (decoded and discarded, exact).
/// Input-only seeking can land on the preceding keyframe, which would shift a
/// clip's audio earlier by up to a GOP.
pub fn extract_span(app: &AppHandle, input: &str, start: f64, dur: f64) -> Result<String, String> {
    if !(dur > 0.0) {
        return Err("empty span".into());
    }
    let src = Path::new(input);
    let dir = store_dir(app).ok_or("no app data directory")?.join("proxies");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    let out = dir.join(span_name(src, start, dur));
    // a cached extract is bytes on disk and nothing else — no header to backfill
    if std::fs::metadata(&out).map(|m| m.len() > 44).unwrap_or(false) {
        return Ok(out.to_string_lossy().into_owned());
    }

    let ff = resolve(app).ok_or("ffmpeg not found")?;
    let pre = (start - 2.0).max(0.0);
    let post = start - pre;
    let mut cmd = Command::new(&ff);
    cmd.arg("-y");
    if pre > 0.0 {
        cmd.arg("-ss").arg(format!("{pre}"));
    }
    cmd.arg("-i").arg(src);
    if post > 0.0 {
        cmd.arg("-ss").arg(format!("{post}"));
    }
    // -vn: the video is nothing but decode cost here. 48 kHz matches the
    // mixdown's render rate, so nothing resamples it a second time.
    cmd.args(["-t", &format!("{dur}"), "-vn", "-acodec", "pcm_s16le", "-ar", "48000"]);
    let err_path = out.with_extension("log");
    let errf = File::create(&err_path).map_err(|e| format!("could not create log: {e}"))?;
    cmd.arg(&out).stdout(Stdio::null()).stderr(Stdio::from(errf));
    hide_console(&mut cmd);

    let child = cmd.spawn().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let status = track_and_wait(child)?;
    let finish = |e: String| -> String {
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&err_path);
        e
    };
    // killed by `cancel_proxy` — the export it belonged to is gone
    let Some(status) = status else {
        return Err(finish("cancelled".into()));
    };
    // a header and no samples means the source had no audio in that span
    let empty = std::fs::metadata(&out).map(|m| m.len() <= 44).unwrap_or(true);
    if !status.success() || empty {
        let err = std::fs::read_to_string(&err_path).unwrap_or_default();
        let last: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        let msg = if empty && status.success() {
            "no audio in that part of the source".to_string()
        } else if last.is_empty() {
            "ffmpeg wrote nothing".to_string()
        } else {
            last[last.len().saturating_sub(3)..].join(" | ")
        };
        return Err(finish(msg));
    }
    let _ = std::fs::remove_file(&err_path);
    Ok(out.to_string_lossy().into_owned())
}

/// An audio-only stand-in for a source, for the preview mixer. Cached on the
/// same identity as the video proxy, beside it.
///
/// Two reasons the preview can't just point an `<audio>` element at the file.
///
/// It may not be able to read it at all — the webview's demuxer refuses
/// containers and codecs ffmpeg handles without blinking, and when it does the
/// clip is simply silent while the picture keeps playing, because the picture
/// comes from the video proxy. That asymmetry is why "some objects have no
/// sound" and the export (which decodes through ffmpeg) does not have it.
///
/// And even when it can, a multi-GB source is a bad thing to seek in for sound:
/// the element demuxes the whole container, and the mixer re-seeks it every
/// time the transport moves. A few MB of AAC seeks instantly. Lossy is fine
/// here — nothing is exported from this, the mixdown reads PCM from the
/// original.
pub fn audio_proxy(app: &AppHandle, input: &str) -> Result<String, String> {
    let src = Path::new(input);
    let dir = store_dir(app).ok_or("no app data directory")?.join("proxies");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    let out = dir.join(format!("{}-preview.m4a", ident(src)));
    if std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(out.to_string_lossy().into_owned());
    }

    let ff = resolve(app).ok_or("ffmpeg not found")?;
    let mut cmd = Command::new(&ff);
    cmd.arg("-y").arg("-i").arg(src);
    // 48 kHz stereo AAC: what the mixer wants, at a size that streams from disk
    cmd.args(["-vn", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]);
    let err_path = out.with_extension("log");
    let errf = File::create(&err_path).map_err(|e| format!("could not create log: {e}"))?;
    cmd.arg(&out).stdout(Stdio::null()).stderr(Stdio::from(errf));
    hide_console(&mut cmd);

    let child = cmd.spawn().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let status = track_and_wait(child)?;
    let finish = |e: String| -> String {
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&err_path);
        e
    };
    let Some(status) = status else {
        return Err(finish("cancelled".into()));
    };
    let empty = std::fs::metadata(&out).map(|m| m.len() == 0).unwrap_or(true);
    if !status.success() || empty {
        let err = std::fs::read_to_string(&err_path).unwrap_or_default();
        let last: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        let msg = if last.is_empty() {
            "ffmpeg wrote nothing".to_string()
        } else {
            last[last.len().saturating_sub(3)..].join(" | ")
        };
        return Err(finish(msg));
    }
    let _ = std::fs::remove_file(&err_path);
    Ok(out.to_string_lossy().into_owned())
}

/// The proxy transcode currently running, so a cancelled export can stop it.
///
/// Only ever one: the frontend walks the timeline's sources in order. Without
/// this, hitting Cancel during "Preparing …" only stopped the *frontend* loop —
/// the ffmpeg already transcoding a multi-GB source ran to completion in the
/// background, at full CPU/GPU, and everything afterwards (the next project's
/// export included) competed with it for minutes.
static PROXY: Mutex<Option<Child>> = Mutex::new(None);

/// Publish `child` as the cancellable proxy job and wait for it, polling so the
/// handle stays reachable. `Ok(None)` means it was killed rather than finished.
fn track_and_wait(child: Child) -> Result<Option<std::process::ExitStatus>, String> {
    match PROXY.lock() {
        Ok(mut g) => *g = Some(child),
        Err(_) => return Err("proxy state poisoned".into()),
    }
    loop {
        {
            let mut g = PROXY.lock().map_err(|_| "proxy state poisoned".to_string())?;
            // taken by cancel_proxy, which has already killed and reaped it
            let Some(c) = g.as_mut() else { return Ok(None) };
            match c.try_wait() {
                Ok(Some(s)) => {
                    g.take();
                    return Ok(Some(s));
                }
                Ok(None) => {}
                Err(e) => {
                    g.take();
                    return Err(format!("ffmpeg wait failed: {e}"));
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Kill the proxy transcode in flight, if any. Safe to call at any time.
pub fn cancel_proxy() {
    if let Ok(mut g) = PROXY.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait(); // reap it here; nothing else holds the handle now
        }
    }
}

/// Total bytes currently held by proxies, so the UI can offer to clear them.
pub fn proxy_size(app: &AppHandle) -> u64 {
    let Some(dir) = store_dir(app).map(|d| d.join("proxies")) else {
        return 0;
    };
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

pub fn clear_proxies(app: &AppHandle) -> Result<(), String> {
    let Some(dir) = store_dir(app).map(|d| d.join("proxies")) else {
        return Ok(());
    };
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not clear proxies: {e}"))?;
    }
    Ok(())
}
