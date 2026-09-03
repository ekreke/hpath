use base64::Engine as _;
use std::io::Read;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tonic::Request;

pub mod dto;
pub mod hpath {
    tonic::include_proto!("hpath.v1");
}

pub mod grpc;

use dto::{
    ArtifactDto, ArtifactProgressDto, CaseDto, EnvDto, ParseEventDto, ParsePrdResultDto,
    ProjectDto, RunDetailDto, RunEventDto, RunResultDto, VerdictDto,
};

/// Server address held Rust-side. The UI sets it once per apply via
/// `set_server_addr`; every gRPC command reads it from here.
#[derive(Default)]
pub struct AppState {
    server_addr: Mutex<Option<String>>,
}

fn current_addr(state: &State<'_, AppState>) -> Result<String, String> {
    state
        .server_addr
        .lock()
        .expect("server_addr mutex poisoned")
        .clone()
        .ok_or_else(|| "server address is not set".to_string())
}

#[tauri::command]
fn set_server_addr(state: State<'_, AppState>, addr: String) -> Result<(), String> {
    let normalized = crate::grpc::client::normalize_addr(&addr)?;
    *state
        .server_addr
        .lock()
        .expect("server_addr mutex poisoned") = Some(normalized);
    Ok(())
}

#[tauri::command]
async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectDto>, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_projects(Request::new(hpath::Empty {}))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response
        .into_inner()
        .projects
        .iter()
        .map(ProjectDto::from)
        .collect())
}

#[tauri::command]
async fn list_envs(state: State<'_, AppState>, project_id: String) -> Result<Vec<EnvDto>, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_envs(Request::new(hpath::ListEnvsRequest { project_id }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.into_inner().envs.iter().map(EnvDto::from).collect())
}

#[tauri::command]
async fn upsert_env(state: State<'_, AppState>, env: EnvDto) -> Result<EnvDto, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .upsert_env(Request::new(hpath::UpsertEnvRequest {
            env: Some(env.into()),
        }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(EnvDto::from(&response.into_inner()))
}

#[tauri::command]
async fn delete_env(state: State<'_, AppState>, env_id: String) -> Result<(), String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    client
        .delete_env(Request::new(hpath::DeleteEnvRequest { env_id }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn list_cases(
    state: State<'_, AppState>,
    project_id: String,
    status: i32,
) -> Result<Vec<CaseDto>, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_cases(Request::new(hpath::ListCasesRequest { project_id, status }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.into_inner().cases.iter().map(CaseDto::from).collect())
}

#[tauri::command]
async fn get_case(state: State<'_, AppState>, case_id: String) -> Result<CaseDto, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .get_case(Request::new(hpath::GetCaseRequest { case_id }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(CaseDto::from(&response.into_inner()))
}

#[tauri::command]
async fn review_case(
    state: State<'_, AppState>,
    case_id: String,
    action: i32,
    comment: String,
) -> Result<CaseDto, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .review_case(Request::new(hpath::ReviewCaseRequest {
            case_id,
            action,
            comment,
        }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(CaseDto::from(&response.into_inner()))
}

#[tauri::command]
async fn list_runs(
    state: State<'_, AppState>,
    project_id: String,
    env_id: String,
    case_id: String,
    status: i32,
    from: String,
    to: String,
) -> Result<Vec<crate::dto::RunDto>, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_runs(Request::new(hpath::ListRunsRequest {
            project_id,
            env_id,
            case_id,
            status,
            from,
            to,
        }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response
        .into_inner()
        .runs
        .iter()
        .map(crate::dto::RunDto::from)
        .collect())
}

/// PRD upload + parse trigger. Streams ParseEvents to the webview via the
/// `parse-prd-event` channel and returns the aggregated result when done.
#[tauri::command]
async fn parse_prd(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    filename: String,
    format: i32,
    content_base64: String,
) -> Result<ParsePrdResultDto, String> {
    let content = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|e| e.to_string())?;

    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = client
        .parse_prd(Request::new(hpath::ParsePrdRequest {
            project_id,
            filename,
            format,
            content,
        }))
        .await
        .map_err(|e| e.to_string())?
        .into_inner();

    let mut result = ParsePrdResultDto {
        prd: None,
        drafts: Vec::new(),
    };

    while let Some(event) = stream.message().await.map_err(|e| e.to_string())? {
        let dto = ParseEventDto::from(&event);
        match &event.payload {
            Some(hpath::parse_event::Payload::PrdRegistered(p)) => {
                result.prd = p.prd.as_ref().map(crate::dto::PrdDto::from);
            }
            Some(hpath::parse_event::Payload::DraftsCreated(d)) => {
                result.drafts = d.cases.iter().map(CaseDto::from).collect();
            }
            _ => {}
        }
        let _ = app.emit("parse-prd-event", &dto);
    }

    Ok(result)
}

/// Run trigger (T12): forwards every stream event to the webview on the
/// `run-event` channel while reducing the stream to the final outcome, which
/// is returned when the command resolves (invoke end = run end).
#[tauri::command]
async fn run_case(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    env_id: String,
    case_id: String,
) -> Result<RunResultDto, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = client
        .run_case(Request::new(hpath::RunCaseRequest {
            project_id,
            env_id,
            case_id,
            trigger: hpath::RunTrigger::Manual as i32,
        }))
        .await
        .map_err(|e| e.to_string())?
        .into_inner();

    let mut result = RunResultDto {
        run_id: String::new(),
        status: hpath::RunStatus::Pending as i32,
        fail_reason: String::new(),
        verdict: None,
    };

    while let Some(event) = stream.message().await.map_err(|e| e.to_string())? {
        result.run_id = event.run_id.clone();
        let dto = RunEventDto::from(&event);
        let _ = app.emit("run-event", &dto);
        match &event.payload {
            Some(hpath::event::Payload::RunStatus(s)) => {
                result.status = s.status;
                result.fail_reason = s.reason.clone();
            }
            Some(hpath::event::Payload::Verdict(v)) => {
                result.verdict = Some(VerdictDto::from(v));
            }
            _ => {}
        }
    }

    Ok(result)
}

/// Collect an artifact's bytes over the gRPC byte stream, emitting a progress
/// tick per chunk when a channel is supplied (T13: the replay view fetches
/// video / trace bytes and surfaces download progress).
async fn fetch_artifact_bytes(
    state: &State<'_, AppState>,
    artifact_id: &str,
    on_progress: Option<tauri::ipc::Channel<ArtifactProgressDto>>,
) -> Result<Vec<u8>, String> {
    let mut client = crate::grpc::client::build_client(current_addr(state)?)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = client
        .download_artifact(Request::new(hpath::DownloadArtifactRequest {
            artifact_id: artifact_id.to_string(),
        }))
        .await
        .map_err(|e| e.to_string())?
        .into_inner();

    let mut bytes = Vec::new();
    let mut received: i64 = 0;
    while let Some(chunk) = stream.message().await.map_err(|e| e.to_string())? {
        received += chunk.data.len() as i64;
        bytes.extend_from_slice(&chunk.data);
        if let Some(channel) = &on_progress {
            let _ = channel.send(ArtifactProgressDto {
                bytes_received: received,
            });
        }
    }

    Ok(bytes)
}

/// Collect an artifact's bytes and return them base64-encoded (T12: inline
/// screenshot thumbnails in the run panel; T13: the replay view also fetches
/// video / trace bytes here and receives a progress tick per streamed chunk
/// on the `onProgress` channel).
#[tauri::command]
async fn download_artifact(
    state: State<'_, AppState>,
    artifact_id: String,
    on_progress: tauri::ipc::Channel<ArtifactProgressDto>,
) -> Result<String, String> {
    let bytes = fetch_artifact_bytes(&state, &artifact_id, Some(on_progress)).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Full run payload for the replay view (T13): run entity + recorded events +
/// artifact index, exactly what GetRun returns on the wire.
#[tauri::command]
async fn get_run(state: State<'_, AppState>, run_id: String) -> Result<RunDetailDto, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .get_run(Request::new(hpath::GetRunRequest { run_id }))
        .await
        .map_err(|e| e.to_string())?
        .into_inner();

    let run = response
        .run
        .ok_or_else(|| "run detail is missing the run entity".to_string())?;
    Ok(RunDetailDto {
        run: crate::dto::RunDto::from(&run),
        events: response.events.iter().map(RunEventDto::from).collect(),
        artifacts: response.artifacts.iter().map(ArtifactDto::from).collect(),
    })
}

/// Artifact bytes written into the user's download directory (T13: trace.zip
/// download). Returns the absolute path of the written file.
#[tauri::command]
async fn save_artifact(
    state: State<'_, AppState>,
    artifact_id: String,
    filename: String,
) -> Result<String, String> {
    let bytes = fetch_artifact_bytes(&state, &artifact_id, None).await?;

    // Only ever write into our own download dir, under a plain file name.
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid filename: {filename}"))?
        .to_string();

    let dir = download_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// One-click trace inspection (T13): caches the trace.zip under the system
/// temp dir and launches `playwright show-trace` on it. A global `playwright`
/// binary is tried first, then `npx playwright` (which resolves or
/// auto-installs the package). A launch only counts as success if the child
/// survives a short probe window — a viewer that exits immediately (bad zip,
/// broken install) surfaces as an error instead of a success toast. Returns
/// the cached trace path; the viewer opens in the default browser.
#[tauri::command]
async fn show_trace(
    state: State<'_, AppState>,
    artifact_id: String,
    run_id: String,
) -> Result<String, String> {
    let bytes = fetch_artifact_bytes(&state, &artifact_id, None).await?;

    let dir = std::env::temp_dir().join("hpath-traces");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    prune_stale_traces(&dir);
    let safe_run: String = run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    let path = dir.join(format!(
        "{}-trace.zip",
        if safe_run.is_empty() { "run".to_string() } else { safe_run }
    ));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    let mut child = std::process::Command::new("playwright")
        .args(["show-trace"])
        .arg(&path)
        .stderr(Stdio::piped())
        .spawn()
        .or_else(|_| {
            std::process::Command::new("npx")
                .args(["--yes", "playwright", "show-trace"])
                .arg(&path)
                .stderr(Stdio::piped())
                .spawn()
        })
        .map_err(|e| format!("could not launch `playwright show-trace` (is Playwright installed?): {e}"))?;

    // Probe briefly: the viewer stays alive while it serves the trace, so a
    // child that is gone within the window has already failed.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if !status.success() => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                let tail = stderr.trim();
                return Err(format!(
                    "`playwright show-trace` exited with {status}{}",
                    if tail.is_empty() { String::new() } else { format!(": {tail}") }
                ));
            }
            Some(_) => break,
            None if std::time::Instant::now() >= deadline => break,
            None => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Drop cached trace zips older than a day; the cache dir would otherwise
/// grow by one zip per show_trace call for the life of the machine.
fn prune_stale_traces(dir: &std::path::Path) {
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| modified <= cutoff)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// ~/Downloads/hpath when a home dir is set, otherwise the system temp dir.
fn download_dir() -> std::path::PathBuf {
    match std::env::var("HOME") {
        Ok(home) => std::path::PathBuf::from(home).join("Downloads").join("hpath"),
        Err(_) => std::env::temp_dir().join("hpath"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            set_server_addr,
            list_projects,
            list_envs,
            upsert_env,
            delete_env,
            list_cases,
            get_case,
            review_case,
            list_runs,
            parse_prd,
            run_case,
            download_artifact,
            get_run,
            save_artifact,
            show_trace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
