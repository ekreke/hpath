use base64::Engine as _;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tonic::Request;

pub mod dto;
pub mod hpath {
    tonic::include_proto!("hpath.v1");
}

pub mod grpc;

use dto::{
    CaseDto, EnvDto, ParseEventDto, ParsePrdResultDto, ProjectDto, RunEventDto, RunResultDto,
    VerdictDto,
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

/// Collect an artifact's bytes and return them base64-encoded (T12: inline
/// screenshot thumbnails in the run panel; progress events arrive with the
/// replay view in T13).
#[tauri::command]
async fn download_artifact(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<String, String> {
    let mut client = crate::grpc::client::build_client(current_addr(&state)?)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = client
        .download_artifact(Request::new(hpath::DownloadArtifactRequest { artifact_id }))
        .await
        .map_err(|e| e.to_string())?
        .into_inner();

    let mut bytes = Vec::new();
    while let Some(chunk) = stream.message().await.map_err(|e| e.to_string())? {
        bytes.extend_from_slice(&chunk.data);
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
