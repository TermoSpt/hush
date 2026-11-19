mod env;
mod ollama;
mod system;
mod vault;

pub fn run() {
    tauri::Builder::default()
        .manage(ollama::OllamaState::new())
        .manage(vault::VaultState::default())
        .invoke_handler(tauri::generate_handler![
            ollama::ollama_get_url,
            ollama::ollama_set_url,
            ollama::ollama_get,
            ollama::ollama_post,
            ollama::ollama_delete_model,
            ollama::ollama_stream,
            ollama::ollama_cancel,
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_save,
            vault::vault_lock,
            vault::vault_destroy,
            env::ollama_env,
            env::set_ollama_env,
            system::gpu_info,
            system::gpu_shared,
            system::data_map,
            system::shred_files,
            system::extract_pdf_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hush");
}
