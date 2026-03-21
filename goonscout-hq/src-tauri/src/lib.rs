use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
struct ProjectFolder {
    id: String,
    name: String,
    folder_path: String,
    json_file_path: Option<String>,
    updated_at: u64,
}

#[derive(Serialize)]
struct WorkspaceOverview {
    root_path: String,
    projects_path: String,
    projects: Vec<ProjectFolder>,
}

fn sanitize_folder_name(input: &str) -> String {
    let mut value = input
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' || character == ' ' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();

    value = value.split_whitespace().collect::<Vec<_>>().join(" ");

    if value.is_empty() {
        "Untitled Project".into()
    } else {
        value
    }
}

fn detect_home_dir() -> Result<PathBuf, String> {
    if let Ok(user_profile) = env::var("USERPROFILE") {
        let trimmed = user_profile.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    if let Ok(home) = env::var("HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    Err("Could not determine a home directory for workspace creation.".into())
}

fn resolve_workspace_root() -> Result<PathBuf, String> {
    Ok(detect_home_dir()?.join("GoonHQMain"))
}

fn ensure_workspace_layout() -> Result<(PathBuf, PathBuf), String> {
    let root = resolve_workspace_root()?;
    let projects = root.join("projects");

    fs::create_dir_all(&projects).map_err(|error| {
        format!(
            "Could not create workspace folders '{}': {}",
            projects.display(),
            error
        )
    })?;

    Ok((root, projects))
}

fn list_json_files_in_folder(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();

    let entries = fs::read_dir(folder)
        .map_err(|error| format!("Could not list folder '{}': {}", folder.display(), error))?;

    for entry in entries {
        let path = entry
            .map_err(|error| format!("Could not read folder entry: {}", error))?
            .path();

        if !path.is_file() {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();

        if extension.eq_ignore_ascii_case("json") {
            files.push(path);
        }
    }

    Ok(files)
}

fn enforce_single_json_file(folder: &Path) -> Result<Option<PathBuf>, String> {
    let mut json_files = list_json_files_in_folder(folder)?;

    if json_files.is_empty() {
        return Ok(None);
    }

    json_files.sort_by(|left, right| {
        let left_name = left
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_name = right
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let left_priority = if left_name == "data.json" {
            3
        } else if left_name == "scans.json" {
            2
        } else {
            1
        };

        let right_priority = if right_name == "data.json" {
            3
        } else if right_name == "scans.json" {
            2
        } else {
            1
        };

        if left_priority != right_priority {
            return right_priority.cmp(&left_priority);
        }

        let left_time = fs::metadata(left)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);

        let right_time = fs::metadata(right)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);

        right_time.cmp(&left_time)
    });

    let kept_file = json_files[0].clone();

    for file in json_files.iter().skip(1) {
        fs::remove_file(file).map_err(|error| {
            format!(
                "Could not remove extra JSON file '{}': {}",
                file.display(),
                error
            )
        })?;
    }

    Ok(Some(kept_file))
}

fn resolve_project_folder(project_id: &str) -> Result<PathBuf, String> {
    let (_, projects_path) = ensure_workspace_layout()?;
    let folder = projects_path.join(project_id);

    if !folder.exists() || !folder.is_dir() {
        return Err(format!("Project folder not found: {}", project_id));
    }

    Ok(folder)
}

fn project_from_folder(folder: &Path) -> Result<ProjectFolder, String> {
    let folder_name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid project folder name.")?
        .to_string();

    let display_name = folder_name.replace('_', " ");

    let json_file_path = enforce_single_json_file(folder)?;

    let updated_at = fs::metadata(folder)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    Ok(ProjectFolder {
        id: folder_name,
        name: display_name,
        folder_path: folder.to_string_lossy().to_string(),
        json_file_path: json_file_path.map(|value| value.to_string_lossy().to_string()),
        updated_at,
    })
}

#[tauri::command]
fn get_goonhq_workspace_overview() -> Result<WorkspaceOverview, String> {
    let (root, projects_path) = ensure_workspace_layout()?;

    let mut projects = Vec::new();

    let entries = fs::read_dir(&projects_path).map_err(|error| {
        format!(
            "Could not list projects folder '{}': {}",
            projects_path.display(),
            error
        )
    })?;

    for entry in entries {
        let project_dir = entry
            .map_err(|error| format!("Could not read projects folder entry: {}", error))?
            .path();

        if !project_dir.is_dir() {
            continue;
        }

        projects.push(project_from_folder(&project_dir)?);
    }

    projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));

    Ok(WorkspaceOverview {
        root_path: root.to_string_lossy().to_string(),
        projects_path: projects_path.to_string_lossy().to_string(),
        projects,
    })
}

#[tauri::command]
fn create_goonhq_project(name: String) -> Result<ProjectFolder, String> {
    let (_, projects_path) = ensure_workspace_layout()?;
    let safe_name = sanitize_folder_name(&name);

    let base_slug = safe_name.replace(' ', "_");
    let mut folder_name = base_slug.clone();
    let mut candidate = projects_path.join(&folder_name);
    let mut counter = 2usize;

    while candidate.exists() {
        folder_name = format!("{}_{}", base_slug, counter);
        candidate = projects_path.join(&folder_name);
        counter += 1;
    }

    fs::create_dir_all(&candidate)
        .map_err(|error| format!("Could not create project folder '{}': {}", candidate.display(), error))?;

    project_from_folder(&candidate)
}

#[tauri::command]
fn upload_project_json(project_id: String, source_path: String) -> Result<String, String> {
    let source_trimmed = source_path.trim();
    if source_trimmed.is_empty() {
        return Err("Source JSON path cannot be empty.".into());
    }

    let source_file = Path::new(source_trimmed);
    if !source_file.exists() || !source_file.is_file() {
        return Err(format!("Source JSON file not found: {}", source_trimmed));
    }

    let raw_content = fs::read_to_string(source_file)
        .map_err(|error| format!("Could not read source JSON file '{}': {}", source_trimmed, error))?;

    let json_value: serde_json::Value = serde_json::from_str(&raw_content)
        .map_err(|error| format!("Could not parse source JSON file '{}': {}", source_trimmed, error))?;

    let normalized = serde_json::to_string_pretty(&json_value)
        .map_err(|error| format!("Could not format source JSON file '{}': {}", source_trimmed, error))?;

    let folder = resolve_project_folder(&project_id)?;

    if let Some(existing) = enforce_single_json_file(&folder)? {
        fs::remove_file(&existing).map_err(|error| {
            format!(
                "Could not remove existing project JSON '{}': {}",
                existing.display(),
                error
            )
        })?;
    }

    let target_path = folder.join("data.json");
    fs::write(&target_path, format!("{}\n", normalized)).map_err(|error| {
        format!(
            "Could not write project JSON file '{}': {}",
            target_path.display(),
            error
        )
    })?;

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn ensure_project_json_for_scan(project_id: String) -> Result<String, String> {
    let folder = resolve_project_folder(&project_id)?;

    if let Some(path) = enforce_single_json_file(&folder)? {
        return Ok(path.to_string_lossy().to_string());
    }

    let target_path = folder.join("data.json");
    fs::write(&target_path, "[]\n").map_err(|error| {
        format!(
            "Could not create project JSON file '{}': {}",
            target_path.display(),
            error
        )
    })?;

    Ok(target_path.to_string_lossy().to_string())
}

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

#[tauri::command]
fn append_json_entry(path: String, entry_json: String) -> Result<(), String> {
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

    let mut root_value: serde_json::Value = serde_json::from_str(&raw_content)
        .map_err(|error| format!("Could not parse JSON file '{}': {}", trimmed_path, error))?;

    let entry_value: serde_json::Value = serde_json::from_str(&entry_json)
        .map_err(|error| format!("QR payload is not valid JSON: {}", error))?;

    let array = root_value
        .as_array_mut()
        .ok_or("JSON file root must be an array to append entries.")?;

    array.insert(0, entry_value);

    let normalized = serde_json::to_string_pretty(&root_value)
        .map_err(|error| format!("Could not format updated JSON: {}", error))?;

    fs::write(file_path, format!("{}\n", normalized))
        .map_err(|error| format!("Could not write file '{}': {}", trimmed_path, error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_json_file,
            write_json_file,
            append_json_entry,
            get_goonhq_workspace_overview,
            create_goonhq_project,
            upload_project_json,
            ensure_project_json_for_scan
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
