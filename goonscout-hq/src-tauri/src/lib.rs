use std::fs;
use std::path::Path;

#[tauri::command]
fn read_json_file(path: String) -> Result<String, String> {
    let trimmed_path = path.trim();

    if trimmed_path.is_empty() {
        return Err("Path cannot be empty.".into());
    }

    let file_path = Path::new(trimmed_path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", trimmed_path));
    }

    let raw_content = fs::read_to_string(file_path)
        .map_err(|error| format!("Could not read file '{}': {}", trimmed_path, error))?;

    let json_value: serde_json::Value = serde_json::from_str(&raw_content)
        .map_err(|error| format!("Could not parse JSON in '{}': {}", trimmed_path, error))?;

    serde_json::to_string_pretty(&json_value)
        .map_err(|error| format!("Could not format JSON from '{}': {}", trimmed_path, error))
}

#[tauri::command]
fn write_json_file(path: String, content: String) -> Result<(), String> {
    let trimmed_path = path.trim();

    if trimmed_path.is_empty() {
        return Err("Path cannot be empty.".into());
    }

    let file_path = Path::new(trimmed_path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", trimmed_path));
    }

    let json_value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Could not parse JSON to save: {}", error))?;

    let normalized = serde_json::to_string_pretty(&json_value)
        .map_err(|error| format!("Could not format JSON to save: {}", error))?;

    fs::write(file_path, format!("{}\n", normalized))
        .map_err(|error| format!("Could not write file '{}': {}", trimmed_path, error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_json_file, write_json_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
