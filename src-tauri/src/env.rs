//! Reads and (on Windows) changes the environment variables Ollama uses for
//! its server settings. Only a fixed list of variables can be changed, and
//! every value is validated first. Changes apply after Ollama is restarted.

use std::collections::BTreeMap;
use std::process::Command;

const ALLOWED: &[&str] = &[
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_NOHISTORY",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_MODELS",
    "OLLAMA_CONTEXT_LENGTH",
    "OLLAMA_KEEP_ALIVE",
];

/// Returns Ok(()) if `value` is acceptable for `name`. An empty value means "remove".
pub fn validate(name: &str, value: &str) -> Result<(), String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("Hush doesn't change {name}."));
    }
    if value.is_empty() {
        return Ok(());
    }
    if value.len() > 400 || value.chars().any(|c| c.is_control() || c == '"') {
        return Err("That value contains characters that aren't allowed.".into());
    }
    let num = |lo: u64, hi: u64| -> Result<(), String> {
        match value.parse::<u64>() {
            Ok(n) if n >= lo && n <= hi => Ok(()),
            _ => Err(format!("{name} must be a number from {lo} to {hi}.")),
        }
    };
    match name {
        "OLLAMA_FLASH_ATTENTION" | "OLLAMA_NOHISTORY" => match value {
            "0" | "1" | "true" | "false" => Ok(()),
            _ => Err(format!("{name} must be 1 or 0.")),
        },
        "OLLAMA_KV_CACHE_TYPE" => match value {
            "f16" | "q8_0" | "q4_0" => Ok(()),
            _ => Err("The cache type must be f16, q8_0 or q4_0.".into()),
        },
        "OLLAMA_NUM_PARALLEL" => num(1, 8),
        "OLLAMA_MAX_LOADED_MODELS" => num(1, 8),
        "OLLAMA_CONTEXT_LENGTH" => num(512, 1_048_576),
        "OLLAMA_KEEP_ALIVE" => {
            let body = value.trim_start_matches('-');
            let digits = body.trim_end_matches(['s', 'm', 'h']);
            if !digits.is_empty()
                && digits.chars().all(|c| c.is_ascii_digit())
                && body.len() - digits.len() <= 1
            {
                Ok(())
            } else {
                Err("Use a duration like 5m, 1h, 0 or -1.".into())
            }
        }
        "OLLAMA_MODELS" => {
            let b = value.as_bytes();
            let windows_abs = b.len() > 2 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
            let unc = value.starts_with("\\\\");
            let unix_abs = value.starts_with('/');
            if windows_abs || unc || unix_abs {
                Ok(())
            } else {
                Err("Use a full folder path, for example D:\\Ollama\\models".into())
            }
        }
        _ => Err(format!("Hush doesn't change {name}.")),
    }
}

#[cfg(windows)]
fn registry_vars(key: &str) -> Vec<(String, String)> {
    use std::os::windows::process::CommandExt;
    let Ok(out) = Command::new("reg")
        .args(["query", key])
        .creation_flags(0x0800_0000)
        .output()
    else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut vars = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if !t.to_ascii_uppercase().starts_with("OLLAMA_") {
            continue;
        }
        let mut parts = t.split_whitespace();
        let (Some(name), Some(kind)) = (parts.next(), parts.next()) else {
            continue;
        };
        if !kind.starts_with("REG_") {
            continue;
        }
        let Some(pos) = t.find(kind) else { continue };
        let value = t[pos + kind.len()..].trim().to_string();
        vars.push((name.to_ascii_uppercase(), value));
    }
    vars
}

/// Ollama-related environment variables as Ollama will see them after its next start.
#[tauri::command]
pub async fn ollama_env() -> Result<BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut map = BTreeMap::new();
        for (k, v) in std::env::vars() {
            if k.to_ascii_uppercase().starts_with("OLLAMA_") {
                map.insert(k.to_ascii_uppercase(), v);
            }
        }
        #[cfg(windows)]
        {
            // The registry is newer than this process's environment (setx only
            // affects programs started afterwards). User settings override system ones.
            for (k, v) in registry_vars(
                "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            ) {
                map.insert(k, v);
            }
            for (k, v) in registry_vars("HKCU\\Environment") {
                map.insert(k, v);
            }
        }
        map
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sets (or, with an empty value, removes) one of the allowed variables for the current user.
#[tauri::command]
pub async fn set_ollama_env(name: String, value: String) -> Result<(), String> {
    let name = name.trim().to_ascii_uppercase();
    let value = value.trim().to_string();
    validate(&name, &value)?;
    tauri::async_runtime::spawn_blocking(move || apply(&name, &value))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn apply(name: &str, value: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let out = if value.is_empty() {
        Command::new("reg")
            .args(["delete", "HKCU\\Environment", "/v", name, "/f"])
            .creation_flags(0x0800_0000)
            .output()
    } else {
        // Arguments are passed directly (no shell), so the value can't inject commands.
        Command::new("setx")
            .args([name, value])
            .creation_flags(0x0800_0000)
            .output()
    }
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Windows refused the change: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(not(windows))]
fn apply(name: &str, value: &str) -> Result<(), String> {
    Err(format!(
        "On this system, add `export {name}={value}` to your shell profile (or the Ollama service config), then restart Ollama."
    ))
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn validates_values() {
        assert!(validate("OLLAMA_FLASH_ATTENTION", "1").is_ok());
        assert!(validate("OLLAMA_FLASH_ATTENTION", "yes").is_err());
        assert!(validate("OLLAMA_KV_CACHE_TYPE", "q8_0").is_ok());
        assert!(validate("OLLAMA_KV_CACHE_TYPE", "q2").is_err());
        assert!(validate("OLLAMA_NUM_PARALLEL", "1").is_ok());
        assert!(validate("OLLAMA_NUM_PARALLEL", "99").is_err());
        assert!(validate("OLLAMA_MODELS", "D:\\Ollama\\models").is_ok());
        assert!(validate("OLLAMA_MODELS", "models").is_err());
        assert!(validate("OLLAMA_MODELS", "D:\\x\" & calc").is_err());
        assert!(validate("OLLAMA_KEEP_ALIVE", "10m").is_ok());
        assert!(validate("OLLAMA_KEEP_ALIVE", "-1").is_ok());
        assert!(validate("OLLAMA_KEEP_ALIVE", "10mm").is_err());
        assert!(validate("PATH", "C:\\").is_err());
        assert!(validate("OLLAMA_NOHISTORY", "").is_ok());
    }
}
