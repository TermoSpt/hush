//! GPU info, the "data map" (every file Hush or Ollama keeps), file shredding,
//! and PDF text extraction.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------- shredding

/// Overwrites a file with random bytes, renames it to a random name, then
/// deletes it. On SSDs the drive may still keep old copies of the blocks
/// internally (wear levelling), which is why Hush relies on encryption for
/// anything it stores itself. This is best effort for files written by others.
pub fn shred_file(path: &Path) -> std::io::Result<()> {
    let len = fs::metadata(path)?.len();
    {
        let mut f = fs::OpenOptions::new().write(true).open(path)?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut left = len;
        while left > 0 {
            let n = left.min(buf.len() as u64) as usize;
            rand::rngs::OsRng.fill_bytes(&mut buf[..n]);
            f.write_all(&buf[..n])?;
            left -= n as u64;
        }
        f.sync_all()?;
    }
    let mut r = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut r);
    let anon = path.with_file_name(format!("{:016x}.del", u64::from_le_bytes(r)));
    let target = if fs::rename(path, &anon).is_ok() {
        anon
    } else {
        path.to_path_buf()
    };
    fs::remove_file(target)
}

// ---------------------------------------------------------------- GPU

#[derive(Serialize)]
pub struct GpuInfo {
    name: String,
    total_mb: u64,
    used_mb: u64,
}

#[tauri::command]
pub async fn gpu_info() -> Result<Vec<GpuInfo>, String> {
    tauri::async_runtime::spawn_blocking(query_nvidia)
        .await
        .map_err(|e| e.to_string())
}

fn query_nvidia() -> Vec<GpuInfo> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,memory.total,memory.used",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(out) = cmd.output() else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.rsplitn(3, ',');
            let used_mb = parts.next()?.trim().parse().ok()?;
            let total_mb = parts.next()?.trim().parse().ok()?;
            let name = parts.next()?.trim().to_string();
            Some(GpuInfo {
                name,
                total_mb,
                used_mb,
            })
        })
        .collect()
}

// ---------------------------------------------------------------- data map

#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    size: u64,
}

#[derive(Serialize)]
pub struct DataGroup {
    id: String,
    title: String,
    note: String,
    root: String,
    exists: bool,
    deletable: bool,
    summary_only: bool,
    total_bytes: u64,
    file_count: u64,
    truncated: bool,
    files: Vec<FileEntry>,
}

struct Root {
    id: &'static str,
    title: &'static str,
    note: &'static str,
    path: PathBuf,
    deletable: bool,
    summary_only: bool,
}

const MAX_LISTED: usize = 800;

fn roots(app: &AppHandle) -> Vec<Root> {
    let p = app.path();
    let mut out = Vec::new();
    let home = p.home_dir().ok();

    if let Ok(dir) = p.app_data_dir() {
        out.push(Root {
            id: "hush-data",
            title: "Hush: your vault",
            note: "Only vault.hush lives here, encrypted with your passphrase. Ephemeral chats are never written anywhere. Use 'Destroy vault' to remove it.",
            path: dir,
            deletable: false,
            summary_only: false,
        });
    }
    if let Ok(dir) = p.app_local_data_dir() {
        if Some(&dir) != out.first().map(|r| &r.path) {
            out.push(Root {
                id: "hush-webview",
                title: "Hush: web engine housekeeping",
                note: "Files the system web engine (WebView2) creates for itself. Hush runs it in private mode, so pages, caches and storage are not kept, but the engine still writes some settings here. The uninstaller can remove this folder.",
                path: dir,
                deletable: false,
                summary_only: false,
            });
        }
    }

    // Ollama app data and logs (Windows: %LOCALAPPDATA%\Ollama, macOS: ~/Library/Application Support/Ollama)
    #[cfg(windows)]
    let ollama_app = p.local_data_dir().ok().map(|d| d.join("Ollama"));
    #[cfg(target_os = "macos")]
    let ollama_app = p.data_dir().ok().map(|d| d.join("Ollama"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let ollama_app: Option<PathBuf> = None;
    if let Some(dir) = ollama_app {
        out.push(Root {
            id: "ollama-app",
            title: "Ollama: app data and logs",
            note: "Ollama's server and app logs, plus the Ollama desktop app's own data (including its chat history if you used its chat window). Files Ollama has open can't be removed until you quit Ollama from the tray.",
            path: dir,
            deletable: true,
            summary_only: false,
        });
    }

    if let Some(home) = home {
        let dot = home.join(".ollama");
        out.push(Root {
            id: "ollama-logs",
            title: "Ollama: logs folder",
            note: "Server logs on macOS and Linux.",
            path: dot.join("logs"),
            deletable: true,
            summary_only: false,
        });
        out.push(Root {
            id: "ollama-history",
            title: "Ollama: terminal prompt history",
            note: "Every line you typed into `ollama run` in a terminal, in plain text. Set the environment variable OLLAMA_NOHISTORY=1 to stop Ollama writing it.",
            path: dot.join("history"),
            deletable: true,
            summary_only: false,
        });
        let models = std::env::var_os("OLLAMA_MODELS")
            .map(PathBuf::from)
            .unwrap_or_else(|| dot.join("models"));
        out.push(Root {
            id: "ollama-models",
            title: "Ollama: model weights",
            note: "Downloaded models. Not personal data. Remove models from the Models screen instead.",
            path: models,
            deletable: false,
            summary_only: true,
        });
    }
    out
}

fn walk(path: &Path, files: &mut Vec<FileEntry>, total: &mut u64, count: &mut u64, list: bool) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if meta.is_file() {
        *total += meta.len();
        *count += 1;
        if list && files.len() < MAX_LISTED {
            files.push(FileEntry {
                path: path.display().to_string(),
                size: meta.len(),
            });
        }
    } else if meta.is_dir() {
        if let Ok(rd) = fs::read_dir(path) {
            for entry in rd.flatten() {
                walk(&entry.path(), files, total, count, list);
            }
        }
    }
}

#[tauri::command]
pub async fn data_map(app: AppHandle) -> Result<Vec<DataGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        roots(&app)
            .into_iter()
            .map(|r| {
                let mut files = Vec::new();
                let (mut total, mut count) = (0u64, 0u64);
                let exists = r.path.exists();
                if exists {
                    walk(&r.path, &mut files, &mut total, &mut count, !r.summary_only);
                }
                DataGroup {
                    id: r.id.into(),
                    title: r.title.into(),
                    note: r.note.into(),
                    root: r.path.display().to_string(),
                    exists,
                    deletable: r.deletable,
                    summary_only: r.summary_only,
                    total_bytes: total,
                    file_count: count,
                    truncated: count as usize > files.len() && !r.summary_only,
                    files,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ShredResult {
    path: String,
    ok: bool,
    error: Option<String>,
}

/// Shreds files, but only inside the folders the data map marks as deletable.
#[tauri::command]
pub async fn shred_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<ShredResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Vec<PathBuf> = roots(&app)
            .into_iter()
            .filter(|r| r.deletable)
            .filter_map(|r| fs::canonicalize(&r.path).ok())
            .collect();
        paths
            .into_iter()
            .map(|p| {
                let result = (|| -> Result<(), String> {
                    let canon = fs::canonicalize(&p).map_err(|e| e.to_string())?;
                    if !allowed.iter().any(|root| canon.starts_with(root)) {
                        return Err("Outside the folders Hush is allowed to clean".into());
                    }
                    if !canon.is_file() {
                        return Err("Not a file".into());
                    }
                    shred_file(&canon).map_err(|e| e.to_string())
                })();
                ShredResult {
                    path: p,
                    ok: result.is_ok(),
                    error: result.err(),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- PDF

#[tauri::command]
pub async fn extract_pdf_text(data_b64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes))
            .map_err(|_| "This PDF couldn't be read.".to_string())?
            .map_err(|e| format!("Couldn't read this PDF: {e:?}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
