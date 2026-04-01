use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Serialize, Deserialize, Default)]
struct WorkspaceSettings {
    root_path: Option<String>,
}

#[derive(Serialize)]
struct WorkspaceSettingsResponse {
    configured_root_path: Option<String>,
    effective_root_path: String,
    using_default_root: bool,
}

#[derive(Serialize)]
struct ContentHashValidationResult {
    valid: bool,
    content_hash: String,
    scout_type: Option<String>,
    message: String,
    field_mapping: Option<serde_json::Value>,
    payload: Option<serde_json::Value>,
    background_image: Option<String>,
    background_location: Option<String>,
}

#[derive(Serialize)]
struct DataShareSyncResult {
    share_code: String,
    match_count: usize,
    qual_count: usize,
    pit_count: usize,
}

fn project_config_file_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(resolve_project_folder(project_id)?.join("project.config.json"))
}

fn default_project_config() -> serde_json::Value {
    serde_json::json!({
        "matchContentHash": "",
        "qualitativeContentHash": "",
        "pitContentHash": "",
        "dataShareCode": "",
        "tagPointValues": {},
        "backgroundImage": null,
        "backgroundLocation": null,
        "fieldMapping": null,
        "updatedAt": 0
    })
}

fn project_data_file_path(project_id: &str, file_name: &str) -> Result<PathBuf, String> {
    let trimmed_name = file_name.trim();
    if trimmed_name.is_empty() {
        return Err("File name cannot be empty.".into());
    }
    if trimmed_name.contains("..") || trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("Invalid file name for project data file.".into());
    }

    Ok(resolve_project_folder(project_id)?.join(trimmed_name))
}

fn initialize_project_files(project_folder: &Path) -> Result<(), String> {
    let config_path = project_folder.join("project.config.json");
    if !config_path.exists() {
        let config_content = serde_json::to_string_pretty(&default_project_config())
            .map_err(|error| format!("Could not serialize default project config JSON: {}", error))?;
        fs::write(&config_path, format!("{}\n", config_content)).map_err(|error| {
            format!(
                "Could not initialize project config file '{}': {}",
                config_path.display(),
                error
            )
        })?;
    }

    let metrics_path = project_folder.join("metrics.json");
    if !metrics_path.exists() {
        fs::write(&metrics_path, "[]\n").map_err(|error| {
            format!(
                "Could not initialize metrics file '{}': {}",
                metrics_path.display(),
                error
            )
        })?;
    }

    let picklists_path = project_folder.join("picklists.json");
    if !picklists_path.exists() {
        let default_picklists = serde_json::json!([
            {
                "id": "default",
                "name": "Default Picklist",
                "metricWeights": {},
                "order": [],
                "struckTeams": []
            }
        ]);

        let picklists_content = serde_json::to_string_pretty(&default_picklists)
            .map_err(|error| format!("Could not serialize default picklists JSON: {}", error))?;

        fs::write(&picklists_path, format!("{}\n", picklists_content)).map_err(|error| {
            format!(
                "Could not initialize picklists file '{}': {}",
                picklists_path.display(),
                error
            )
        })?;
    }

    let data_path = project_folder.join("data.json");
    if !data_path.exists() {
        fs::write(&data_path, "[]\n").map_err(|error| {
            format!(
                "Could not initialize data file '{}': {}",
                data_path.display(),
                error
            )
        })?;
    }

    Ok(())
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

fn default_workspace_root() -> Result<PathBuf, String> {
    Ok(detect_home_dir()?.join("GoonHQMain"))
}

fn workspace_settings_file_path() -> Result<PathBuf, String> {
    Ok(detect_home_dir()?.join(".goonscout_hq_settings.json"))
}

fn read_workspace_settings() -> Result<WorkspaceSettings, String> {
    let settings_path = workspace_settings_file_path()?;

    if !settings_path.exists() {
        return Ok(WorkspaceSettings::default());
    }

    let content = fs::read_to_string(&settings_path).map_err(|error| {
        format!(
            "Could not read workspace settings '{}': {}",
            settings_path.display(),
            error
        )
    })?;

    let parsed: WorkspaceSettings = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Could not parse workspace settings '{}': {}",
            settings_path.display(),
            error
        )
    })?;

    Ok(parsed)
}

fn write_workspace_settings(settings: &WorkspaceSettings) -> Result<(), String> {
    let settings_path = workspace_settings_file_path()?;
    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize workspace settings: {}", error))?;

    fs::write(&settings_path, format!("{}\n", content)).map_err(|error| {
        format!(
            "Could not write workspace settings '{}': {}",
            settings_path.display(),
            error
        )
    })
}

fn resolve_workspace_root() -> Result<PathBuf, String> {
    let settings = read_workspace_settings()?;

    if let Some(configured) = settings.root_path {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    default_workspace_root()
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

fn parse_dotenv_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let (raw_key, raw_value) = trimmed.split_once('=')?;
    let key = raw_key.trim().strip_prefix("export ").unwrap_or(raw_key.trim()).trim();
    if key.is_empty() {
        return None;
    }

    let mut value = raw_value.trim().to_string();
    if (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')) {
        value = value[1..value.len() - 1].to_string();
    }

    Some((key.to_string(), value))
}

fn dotenv_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join(".env.local"));
        candidates.push(cwd.join(".env"));

        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join(".env.local"));
            candidates.push(parent.join(".env"));

            if let Some(grandparent) = parent.parent() {
                candidates.push(grandparent.join(".env.local"));
                candidates.push(grandparent.join(".env"));
            }
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join(".env.local"));
            candidates.push(exe_dir.join(".env"));
        }
    }

    candidates
}

fn read_env_value_from_dotenv_files(key: &str) -> Option<String> {
    for candidate in dotenv_candidate_paths() {
        if !candidate.exists() {
            continue;
        }

        let content = fs::read_to_string(&candidate).ok()?;
        for line in content.lines() {
            let Some((line_key, line_value)) = parse_dotenv_line(line) else {
                continue;
            };

            if line_key == key {
                let trimmed = line_value.trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }

    None
}

fn read_env_value(key: &str) -> Option<String> {
    if let Ok(value) = env::var(key) {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    read_env_value_from_dotenv_files(key)
}

fn extract_scout_type_from_payload_value(payload_value: &serde_json::Value) -> Option<String> {
    if let Some(value) = payload_value.get("scoutType").and_then(|value| value.as_str()) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(value) = payload_value
        .get("editorState")
        .and_then(|editor| editor.get("scoutType"))
        .and_then(|value| value.as_str())
    {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn extract_scout_type_from_payload(payload_value: Option<&serde_json::Value>) -> Option<String> {
    let payload_value = payload_value?;

    if let Some(found) = extract_scout_type_from_payload_value(payload_value) {
        return Some(found);
    }

    if let Some(payload_as_text) = payload_value.as_str() {
        if let Ok(parsed_payload) = serde_json::from_str::<serde_json::Value>(payload_as_text) {
            return extract_scout_type_from_payload_value(&parsed_payload);
        }
    }

    None
}

fn get_supabase_credentials() -> Result<(String, String), String> {
    let url = read_env_value("NEXT_PUBLIC_SUPABASE_URL")
        .ok_or_else(|| "NEXT_PUBLIC_SUPABASE_URL is not set in environment or .env.local/.env.".to_string())?;
    let key = read_env_value("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        .ok_or_else(|| "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set in environment or .env.local/.env.".to_string())?;

    let trimmed_url = url.trim().trim_end_matches('/').to_string();
    let trimmed_key = key.trim().to_string();

    if trimmed_url.is_empty() || trimmed_key.is_empty() {
        return Err("Supabase URL/key values are empty.".into());
    }

    Ok((trimmed_url, trimmed_key))
}

fn normalize_share_code(share_code: &str) -> Result<String, String> {
    let digits = share_code
        .chars()
        .filter(|value| value.is_ascii_digit())
        .collect::<String>();

    if digits.len() != 6 {
        return Err("Share code must be exactly 6 digits.".into());
    }

    Ok(digits)
}

fn build_data_sharing_query_url(supabase_url: &str, share_code: &str, select: &str) -> String {
    format!(
        "{}/rest/v1/data_sharing?share_code=eq.{}&select={}&limit=1",
        supabase_url, share_code, select
    )
}

fn generate_share_code_candidate(attempt: u32) -> String {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mixed = seed
        ^ ((std::process::id() as u128) << 17)
        ^ ((attempt as u128 + 1) * 97_291u128);
    let code = (mixed % 1_000_000u128) as u32;
    format!("{:06}", code)
}

fn ensure_json_array(value: serde_json::Value, label: &str) -> Result<Vec<serde_json::Value>, String> {
    match value {
        serde_json::Value::Array(entries) => Ok(entries),
        serde_json::Value::Null => Ok(Vec::new()),
        _ => Err(format!("{} must be a JSON array.", label)),
    }
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

        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if file_name == "project.config.json"
            || file_name == "metrics.json"
            || file_name == "picklists.json"
            || file_name == "qual.json"
            || file_name == "pit.json"
        {
            continue;
        }

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

    initialize_project_files(folder)?;

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
fn get_workspace_settings() -> Result<WorkspaceSettingsResponse, String> {
    let settings = read_workspace_settings()?;
    let default_root = default_workspace_root()?;
    let effective_root = resolve_workspace_root()?;
    let configured = settings
        .root_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(WorkspaceSettingsResponse {
        configured_root_path: configured,
        effective_root_path: effective_root.to_string_lossy().to_string(),
        using_default_root: effective_root == default_root,
    })
}

#[tauri::command]
fn set_workspace_root(root_path: String) -> Result<WorkspaceOverview, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err("Root folder cannot be empty.".into());
    }

    let root = PathBuf::from(trimmed);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create workspace root '{}': {}", root.display(), error))?;

    let settings = WorkspaceSettings {
        root_path: Some(root.to_string_lossy().to_string()),
    };
    write_workspace_settings(&settings)?;

    get_goonhq_workspace_overview()
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

    initialize_project_files(&candidate)?;

    project_from_folder(&candidate)
}

#[tauri::command]
fn validate_field_config_content_hash(
    content_hash: String,
    expected_scout_type: Option<String>,
) -> Result<ContentHashValidationResult, String> {
    let hash = content_hash.trim().to_string();
    if hash.is_empty() {
        return Ok(ContentHashValidationResult {
            valid: false,
            content_hash: String::new(),
            scout_type: None,
            message: "Content hash cannot be empty.".into(),
            field_mapping: None,
            payload: None,
            background_image: None,
            background_location: None,
        });
    }

    let (supabase_url, supabase_key) = get_supabase_credentials()?;
    let expected_type = expected_scout_type
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    let request_url = format!(
        "{}/rest/v1/field_configs?content_hash=eq.{}&select=content_hash,payload,field_mapping,background_image,background_location&order=updated_at.desc&limit=1",
        supabase_url,
        hash
    );

    let client = Client::new();
    let response = client
        .get(request_url)
        .header("apikey", supabase_key.as_str())
        .header(AUTHORIZATION, format!("Bearer {}", supabase_key))
        .header(CONTENT_TYPE, "application/json")
        .send()
        .map_err(|error| format!("Supabase request failed: {}", error))?;

    if !response.status().is_success() {
        return Err(format!(
            "Supabase returned HTTP {} while validating content hash.",
            response.status().as_u16()
        ));
    }

    let rows: Vec<serde_json::Value> = response
        .json()
        .map_err(|error| format!("Could not parse Supabase response JSON: {}", error))?;

    let Some(row) = rows.first() else {
        return Ok(ContentHashValidationResult {
            valid: false,
            content_hash: hash,
            scout_type: None,
            message: "No field config found for this content hash.".into(),
            field_mapping: None,
            payload: None,
            background_image: None,
            background_location: None,
        });
    };

    let payload = row.get("payload");
    let scout_type = extract_scout_type_from_payload(payload);

    if let Some(expected) = expected_type {
        let current = scout_type
            .as_ref()
            .map(|value| value.to_lowercase())
            .unwrap_or_default();
        if current != expected {
            return Ok(ContentHashValidationResult {
                valid: false,
                content_hash: hash,
                scout_type,
                message: format!(
                    "Hash exists but scoutType mismatch. Expected '{}'.",
                    expected
                ),
                field_mapping: row.get("field_mapping").cloned(),
                payload: row.get("payload").cloned(),
                background_image: row
                    .get("background_image")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                background_location: row
                    .get("background_location")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
            });
        }
    }

    Ok(ContentHashValidationResult {
        valid: true,
        content_hash: hash,
        scout_type,
        message: "Content hash is valid.".into(),
        field_mapping: row.get("field_mapping").cloned(),
        payload: row.get("payload").cloned(),
        background_image: row
            .get("background_image")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        background_location: row
            .get("background_location")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
    })
}

#[tauri::command]
fn fetch_tba_event_teams(event_key: String) -> Result<serde_json::Value, String> {
    let key = read_env_value("X_TBA_AUTH_KEY")
        .ok_or_else(|| "X_TBA_AUTH_KEY is not set in environment or .env.local/.env.".to_string())?;

    let event = event_key.trim();
    if event.is_empty() {
        return Err("event_key cannot be empty.".into());
    }

    let url = format!(
        "https://www.thebluealliance.com/api/v3/event/{}/teams/simple",
        event
    );

    let client = Client::new();
    let response = client
        .get(url)
        .header("X-TBA-Auth-Key", key.trim())
        .send()
        .map_err(|error| format!("Blue Alliance request failed: {}", error))?;

    if !response.status().is_success() {
        return Err(format!(
            "Blue Alliance returned HTTP {} for event teams.",
            response.status().as_u16()
        ));
    }

    response
        .json()
        .map_err(|error| format!("Could not parse Blue Alliance response JSON: {}", error))
}

#[tauri::command]
fn fetch_tba_match(match_key: String) -> Result<serde_json::Value, String> {
    let key = read_env_value("X_TBA_AUTH_KEY")
        .ok_or_else(|| "X_TBA_AUTH_KEY is not set in environment or .env.local/.env.".to_string())?;

    let match_value = match_key.trim();
    if match_value.is_empty() {
        return Err("match_key cannot be empty.".into());
    }

    let url = format!(
        "https://www.thebluealliance.com/api/v3/match/{}/simple",
        match_value
    );

    let client = Client::new();
    let response = client
        .get(url)
        .header("X-TBA-Auth-Key", key.trim())
        .send()
        .map_err(|error| format!("Blue Alliance request failed: {}", error))?;

    if !response.status().is_success() {
        return Err(format!(
            "Blue Alliance returned HTTP {} for match lookup.",
            response.status().as_u16()
        ));
    }

    response
        .json()
        .map_err(|error| format!("Could not parse Blue Alliance response JSON: {}", error))
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
fn get_project_config(project_id: String) -> Result<serde_json::Value, String> {
    let config_path = project_config_file_path(project_id.trim())?;

    if !config_path.exists() {
        return Ok(default_project_config());
    }

    let content = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "Could not read project config '{}': {}",
            config_path.display(),
            error
        )
    })?;

    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Could not parse project config '{}': {}",
            config_path.display(),
            error
        )
    })
}

#[tauri::command]
fn save_project_config(project_id: String, config: serde_json::Value) -> Result<(), String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty for config save.".into());
    }

    let mut config_object = config
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);

    let updated_at = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    config_object.insert("updatedAt".to_string(), serde_json::json!(updated_at));

    let config_path = project_config_file_path(project_id_trimmed)?;
    let normalized = serde_json::to_string_pretty(&serde_json::Value::Object(config_object))
        .map_err(|error| format!("Could not serialize project config JSON: {}", error))?;

    fs::write(&config_path, format!("{}\n", normalized)).map_err(|error| {
        format!(
            "Could not write project config '{}': {}",
            config_path.display(),
            error
        )
    })
}

#[tauri::command]
fn read_or_init_project_data_file(
    project_id: String,
    file_name: String,
    default_content: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty.".into());
    }

    let file_path = project_data_file_path(project_id_trimmed, file_name.trim())?;

    if !file_path.exists() {
        let normalized_default = serde_json::to_string_pretty(&default_content)
            .map_err(|error| format!("Could not serialize default JSON content: {}", error))?;
        fs::write(&file_path, format!("{}\n", normalized_default)).map_err(|error| {
            format!(
                "Could not initialize project data file '{}': {}",
                file_path.display(),
                error
            )
        })?;
        return Ok(default_content);
    }

    let content = fs::read_to_string(&file_path).map_err(|error| {
        format!(
            "Could not read project data file '{}': {}",
            file_path.display(),
            error
        )
    })?;

    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Could not parse project data file '{}': {}",
            file_path.display(),
            error
        )
    })
}

#[tauri::command]
fn write_project_data_file(
    project_id: String,
    file_name: String,
    content: serde_json::Value,
) -> Result<(), String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty.".into());
    }

    let file_path = project_data_file_path(project_id_trimmed, file_name.trim())?;
    let normalized_content = serde_json::to_string_pretty(&content)
        .map_err(|error| format!("Could not serialize JSON content for save: {}", error))?;

    fs::write(&file_path, format!("{}\n", normalized_content)).map_err(|error| {
        format!(
            "Could not write project data file '{}': {}",
            file_path.display(),
            error
        )
    })
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

fn project_config_has_nonempty_hash(project_id: &str, hash_key: &str) -> Result<bool, String> {
    let config_path = project_config_file_path(project_id)?;
    if !config_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "Could not read project config '{}': {}",
            config_path.display(),
            error
        )
    })?;

    let parsed: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Could not parse project config '{}': {}",
            config_path.display(),
            error
        )
    })?;

    Ok(parsed
        .get(hash_key)
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false))
}

fn ensure_scan_file_for_scout_type(project_id: &str, scout_type: &str) -> Result<PathBuf, String> {
    let file_name = match scout_type {
        "match" => "data.json",
        "qualitative" => {
            let has_hash = project_config_has_nonempty_hash(project_id, "qualitativeContentHash")?;
            if !has_hash {
                return Err(
                    "Qualitative content hash is not configured. Add it in Config before scanning qualitative QR codes.".into(),
                );
            }
            "qual.json"
        }
        "pit" => {
            let has_hash = project_config_has_nonempty_hash(project_id, "pitContentHash")?;
            if !has_hash {
                return Err("Pit content hash is not configured. Add it in Config before scanning pit QR codes.".into());
            }
            "pit.json"
        }
        _ => return Err(format!("Unsupported scout type '{}'.", scout_type)),
    };

    let file_path = project_data_file_path(project_id, file_name)?;
    if !file_path.exists() {
        fs::write(&file_path, "[]\n").map_err(|error| {
            format!(
                "Could not create scan data file '{}': {}",
                file_path.display(),
                error
            )
        })?;
    }

    Ok(file_path)
}

#[tauri::command]
fn append_project_scan_entries(
    project_id: String,
    scout_type: String,
    entries: Vec<serde_json::Value>,
) -> Result<String, String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty.".into());
    }

    if entries.is_empty() {
        return Err("No scan entries were provided to append.".into());
    }

    let scout_type_trimmed = scout_type.trim().to_lowercase();
    if scout_type_trimmed.is_empty() {
        return Err("Scout type cannot be empty.".into());
    }

    let file_path = ensure_scan_file_for_scout_type(project_id_trimmed, scout_type_trimmed.as_str())?;

    let raw_content = fs::read_to_string(&file_path).map_err(|error| {
        format!(
            "Could not read scan data file '{}': {}",
            file_path.display(),
            error
        )
    })?;

    let mut root_value: serde_json::Value = serde_json::from_str(&raw_content)
        .map_err(|error| format!("Could not parse scan data file '{}': {}", file_path.display(), error))?;

    let array = root_value
        .as_array_mut()
        .ok_or("Scan data file root must be a JSON array.")?;

    // Insert newest entries at top while preserving caller-provided order.
    for entry in entries.into_iter().rev() {
        array.insert(0, entry);
    }

    let normalized = serde_json::to_string_pretty(&root_value)
        .map_err(|error| format!("Could not format updated scan JSON: {}", error))?;

    fs::write(&file_path, format!("{}\n", normalized)).map_err(|error| {
        format!(
            "Could not write scan data file '{}': {}",
            file_path.display(),
            error
        )
    })?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn validate_data_share_code(share_code: String) -> Result<bool, String> {
    let normalized_code = normalize_share_code(&share_code)?;
    let (supabase_url, supabase_key) = get_supabase_credentials()?;
    let request_url = build_data_sharing_query_url(&supabase_url, &normalized_code, "share_code");

    let response = Client::new()
        .get(request_url)
        .header("apikey", supabase_key.as_str())
        .header(AUTHORIZATION, format!("Bearer {}", supabase_key))
        .header(CONTENT_TYPE, "application/json")
        .send()
        .map_err(|error| format!("Supabase request failed: {}", error))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let details = response.text().unwrap_or_default();
        return Err(format!(
            "Supabase returned HTTP {} while validating share code. {}",
            status, details
        ));
    }

    let rows: Vec<serde_json::Value> = response
        .json()
        .map_err(|error| format!("Could not parse Supabase response JSON: {}", error))?;

    Ok(!rows.is_empty())
}

#[tauri::command]
fn create_data_share_code(project_id: String) -> Result<String, String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty.".into());
    }

    resolve_project_folder(project_id_trimmed)?;

    let (supabase_url, supabase_key) = get_supabase_credentials()?;
    let client = Client::new();

    for attempt in 0..40u32 {
        let candidate = generate_share_code_candidate(attempt);
        let check_url = build_data_sharing_query_url(&supabase_url, &candidate, "share_code");

        let check_response = client
            .get(check_url)
            .header("apikey", supabase_key.as_str())
            .header(AUTHORIZATION, format!("Bearer {}", supabase_key))
            .header(CONTENT_TYPE, "application/json")
            .send()
            .map_err(|error| format!("Supabase request failed: {}", error))?;

        if !check_response.status().is_success() {
            let status = check_response.status().as_u16();
            let details = check_response.text().unwrap_or_default();
            return Err(format!(
                "Supabase returned HTTP {} while checking share code availability. {}",
                status, details
            ));
        }

        let existing_rows: Vec<serde_json::Value> = check_response
            .json()
            .map_err(|error| format!("Could not parse Supabase response JSON: {}", error))?;

        if !existing_rows.is_empty() {
            continue;
        }

        let insert_response = client
            .post(format!("{}/rest/v1/data_sharing", supabase_url))
            .header("apikey", supabase_key.as_str())
            .header(AUTHORIZATION, format!("Bearer {}", supabase_key))
            .header(CONTENT_TYPE, "application/json")
            .header("Prefer", "return=minimal")
            .json(&serde_json::json!([
                {
                    "share_code": candidate,
                    "match_data": [],
                    "qual_data": [],
                    "pit_data": []
                }
            ]))
            .send()
            .map_err(|error| format!("Supabase request failed: {}", error))?;

        if insert_response.status().is_success() {
            return Ok(candidate);
        }

        let status = insert_response.status();
        let details = insert_response.text().unwrap_or_default();
        let lowered = details.to_lowercase();

        if status.as_u16() == 409 || lowered.contains("duplicate") || lowered.contains("unique") {
            continue;
        }

        return Err(format!(
            "Supabase returned HTTP {} while creating share code. {}",
            status.as_u16(),
            details
        ));
    }

    Err("Could not create a unique share code after multiple attempts. Please try again.".into())
}

#[tauri::command]
fn upload_project_share_data(project_id: String, share_code: String) -> Result<DataShareSyncResult, String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty.".into());
    }

    resolve_project_folder(project_id_trimmed)?;

    let normalized_code = normalize_share_code(&share_code)?;

    let match_entries = ensure_json_array(
        read_or_init_project_data_file(project_id_trimmed.to_string(), "data.json".into(), serde_json::json!([]))?,
        "data.json",
    )?;
    let qual_entries = ensure_json_array(
        read_or_init_project_data_file(project_id_trimmed.to_string(), "qual.json".into(), serde_json::json!([]))?,
        "qual.json",
    )?;
    let pit_entries = ensure_json_array(
        read_or_init_project_data_file(project_id_trimmed.to_string(), "pit.json".into(), serde_json::json!([]))?,
        "pit.json",
    )?;

    let match_count = match_entries.len();
    let qual_count = qual_entries.len();
    let pit_count = pit_entries.len();

    let (supabase_url, supabase_key) = get_supabase_credentials()?;
    let request_url = format!(
        "{}/rest/v1/data_sharing?share_code=eq.{}",
        supabase_url, normalized_code
    );

    let response = Client::new()
        .patch(request_url)
        .header("apikey", supabase_key.as_str())
        .header(AUTHORIZATION, format!("Bearer {}", supabase_key))
        .header(CONTENT_TYPE, "application/json")
        .header("Prefer", "return=representation")
        .json(&serde_json::json!({
            "match_data": match_entries,
            "qual_data": qual_entries,
            "pit_data": pit_entries
        }))
        .send()
        .map_err(|error| format!("Supabase request failed: {}", error))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let details = response.text().unwrap_or_default();
        return Err(format!(
            "Supabase returned HTTP {} while uploading shared data. {}",
            status, details
        ));
    }

    let rows: Vec<serde_json::Value> = response
        .json()
        .map_err(|error| format!("Could not parse Supabase response JSON: {}", error))?;

    if rows.is_empty() {
        return Err(format!(
            "Share code '{}' was not found. Enter a valid code or create one first.",
            normalized_code
        ));
    }

    Ok(DataShareSyncResult {
        share_code: normalized_code,
        match_count,
        qual_count,
        pit_count,
    })
}

#[tauri::command]
fn download_project_share_data(project_id: String, share_code: String) -> Result<DataShareSyncResult, String> {
    let project_id_trimmed = project_id.trim();
    if project_id_trimmed.is_empty() {
        return Err("Project ID cannot be empty.".into());
    }

    resolve_project_folder(project_id_trimmed)?;

    let normalized_code = normalize_share_code(&share_code)?;
    let (supabase_url, supabase_key) = get_supabase_credentials()?;
    let request_url = build_data_sharing_query_url(&supabase_url, &normalized_code, "match_data,qual_data,pit_data");

    let response = Client::new()
        .get(request_url)
        .header("apikey", supabase_key.as_str())
        .header(AUTHORIZATION, format!("Bearer {}", supabase_key))
        .header(CONTENT_TYPE, "application/json")
        .send()
        .map_err(|error| format!("Supabase request failed: {}", error))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let details = response.text().unwrap_or_default();
        return Err(format!(
            "Supabase returned HTTP {} while downloading shared data. {}",
            status, details
        ));
    }

    let rows: Vec<serde_json::Value> = response
        .json()
        .map_err(|error| format!("Could not parse Supabase response JSON: {}", error))?;

    let Some(row) = rows.first() else {
        return Err(format!(
            "Share code '{}' was not found. Enter a valid code first.",
            normalized_code
        ));
    };

    let match_entries = ensure_json_array(
        row.get("match_data")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
        "match_data",
    )?;
    let qual_entries = ensure_json_array(
        row.get("qual_data")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
        "qual_data",
    )?;
    let pit_entries = ensure_json_array(
        row.get("pit_data")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new())),
        "pit_data",
    )?;

    let match_count = match_entries.len();
    let qual_count = qual_entries.len();
    let pit_count = pit_entries.len();

    write_project_data_file(
        project_id_trimmed.to_string(),
        "data.json".into(),
        serde_json::Value::Array(match_entries),
    )?;
    write_project_data_file(
        project_id_trimmed.to_string(),
        "qual.json".into(),
        serde_json::Value::Array(qual_entries),
    )?;
    write_project_data_file(
        project_id_trimmed.to_string(),
        "pit.json".into(),
        serde_json::Value::Array(pit_entries),
    )?;

    Ok(DataShareSyncResult {
        share_code: normalized_code,
        match_count,
        qual_count,
        pit_count,
    })
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
            append_project_scan_entries,
            validate_data_share_code,
            create_data_share_code,
            upload_project_share_data,
            download_project_share_data,
            get_goonhq_workspace_overview,
            get_workspace_settings,
            set_workspace_root,
            create_goonhq_project,
            upload_project_json,
            ensure_project_json_for_scan,
            get_project_config,
            save_project_config,
            read_or_init_project_data_file,
            write_project_data_file,
            validate_field_config_content_hash,
            fetch_tba_event_teams,
            fetch_tba_match
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
