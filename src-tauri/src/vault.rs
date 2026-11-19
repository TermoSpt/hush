//! Encrypted vault: the only file Hush writes on purpose.
//!
//! Format: "HUSHV1" | salt (16) | nonce (24) | XChaCha20-Poly1305 ciphertext
//! Key:    Argon2id(passphrase, salt, 64 MiB, 3 passes) -> 32 bytes
//!
//! The key only lives in memory while the vault is unlocked and is zeroed
//! when it is locked or the app exits.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::system::shred_file;

const MAGIC: &[u8] = b"HUSHV1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
pub const FILE_NAME: &str = "vault.hush";

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; SALT_LEN],
}

#[derive(Default)]
pub struct VaultState {
    slot: Mutex<Option<Unlocked>>,
}

#[derive(Serialize)]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
    path: String,
}

pub fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE_NAME))
}

fn derive_key(pass: &[u8], salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pass, salt, &mut key[..])
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn seal(key: &[u8; 32], salt: &[u8; SALT_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| "Bad key length")?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: MAGIC,
            },
        )
        .map_err(|_| "Encryption failed")?;
    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(bytes: &[u8], pass: &[u8]) -> Result<(Unlocked, Zeroizing<Vec<u8>>), String> {
    let header = MAGIC.len() + SALT_LEN + NONCE_LEN;
    if bytes.len() < header + TAG_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err("This file is not a Hush vault.".into());
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[MAGIC.len()..MAGIC.len() + SALT_LEN]);
    let nonce = &bytes[MAGIC.len() + SALT_LEN..header];
    let key = derive_key(pass, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..]).map_err(|_| "Bad key length")?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: &bytes[header..],
                aad: MAGIC,
            },
        )
        .map_err(|_| "Wrong passphrase (or the vault file is damaged).")?;
    Ok((Unlocked { key, salt }, Zeroizing::new(plaintext)))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Result<VaultStatus, String> {
    let path = vault_path(&app)?;
    Ok(VaultStatus {
        exists: path.exists(),
        unlocked: state.slot.lock().unwrap().is_some(),
        path: path.display().to_string(),
    })
}

#[tauri::command]
pub async fn vault_create(
    app: AppHandle,
    state: State<'_, VaultState>,
    passphrase: String,
    data: String,
) -> Result<(), String> {
    let path = vault_path(&app)?;
    if path.exists() {
        return Err("A vault already exists. Destroy it first to make a new one.".into());
    }
    if passphrase.chars().count() < 8 {
        return Err("Use a passphrase of at least 8 characters.".into());
    }
    let pass = Zeroizing::new(passphrase);
    let data = Zeroizing::new(data);
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = tauri::async_runtime::spawn_blocking(move || derive_key(pass.as_bytes(), &salt))
        .await
        .map_err(|e| e.to_string())??;
    let sealed = seal(&key, &salt, data.as_bytes())?;
    write_atomic(&path, &sealed)?;
    *state.slot.lock().unwrap() = Some(Unlocked { key, salt });
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
    passphrase: String,
) -> Result<String, String> {
    let path = vault_path(&app)?;
    let bytes = fs::read(&path).map_err(|_| "No vault found.".to_string())?;
    let pass = Zeroizing::new(passphrase);
    let (unlocked, plaintext) =
        tauri::async_runtime::spawn_blocking(move || open(&bytes, pass.as_bytes()))
            .await
            .map_err(|e| e.to_string())??;
    let text = String::from_utf8(plaintext.to_vec()).map_err(|_| "Vault contents are damaged.")?;
    *state.slot.lock().unwrap() = Some(unlocked);
    Ok(text)
}

#[tauri::command]
pub async fn vault_save(
    app: AppHandle,
    state: State<'_, VaultState>,
    data: String,
) -> Result<(), String> {
    let path = vault_path(&app)?;
    let data = Zeroizing::new(data);
    let sealed = {
        let guard = state.slot.lock().unwrap();
        let u = guard.as_ref().ok_or("The vault is locked.")?;
        seal(&u.key, &u.salt, data.as_bytes())?
    };
    write_atomic(&path, &sealed)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) {
    // Dropping `Unlocked` zeroes the key.
    *state.slot.lock().unwrap() = None;
}

#[tauri::command]
pub fn vault_destroy(app: AppHandle, state: State<'_, VaultState>) -> Result<(), String> {
    *state.slot.lock().unwrap() = None;
    let path = vault_path(&app)?;
    for p in [path.with_extension("tmp"), path] {
        if p.exists() {
            shred_file(&p).map_err(|e| format!("Couldn't remove {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_passphrase() {
        let salt = [7u8; SALT_LEN];
        let key = derive_key(b"correct horse battery", &salt).unwrap();
        let sealed = seal(&key, &salt, b"{\"chats\":[]}").unwrap();
        let (_, pt) = open(&sealed, b"correct horse battery").unwrap();
        assert_eq!(&pt[..], b"{\"chats\":[]}");
        assert!(open(&sealed, b"wrong passphrase").is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(open(&tampered, b"correct horse battery").is_err());
    }
}
