use base64::Engine as _;
use tauri::{AppHandle, Emitter};
use tonic::Request;

pub mod dto;
pub mod hpath {
    tonic::include_proto!("hpath.v1");
}

pub mod grpc;

use dto::{
    CaseDto, EnvDto, ParseEventDto, ParsePrdResultDto, ProjectDto, RunResultDto, VerdictDto,
};

#[tauri::command]
async fn list_projects(addr: String) -> Result<Vec<ProjectDto>, String> {
    let mut client = crate::grpc::client::build_client(addr)
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
async fn list_envs(addr: String, project_id: String) -> Result<Vec<EnvDto>, String> {
    let mut client = crate::grpc::client::build_client(addr)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_envs(Request::new(hpath::ListEnvsRequest { project_id }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.into_inner().envs.iter().map(EnvDto::from).collect())
}

#[tauri::command]
async fn upsert_env(addr: String, env: EnvDto) -> Result<EnvDto, String> {
    let mut client = crate::grpc::client::build_client(addr)
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
async fn delete_env(addr: String, env_id: String) -> Result<(), String> {
    let mut client = crate::grpc::client::build_client(addr)
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
    addr: String,
    project_id: String,
    status: i32,
) -> Result<Vec<CaseDto>, String> {
    let mut client = crate::grpc::client::build_client(addr)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_cases(Request::new(hpath::ListCasesRequest { project_id, status }))
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.into_inner().cases.iter().map(CaseDto::from).collect())
}

#[tauri::command]
async fn get_case(addr: String, case_id: String) -> Result<CaseDto, String> {
    let mut client = crate::grpc::client::build_client(addr)
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
    addr: String,
    case_id: String,
    action: i32,
    comment: String,
) -> Result<CaseDto, String> {
    let mut client = crate::grpc::client::build_client(addr)
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
    addr: String,
    project_id: String,
    env_id: String,
    case_id: String,
    status: i32,
    from: String,
    to: String,
) -> Result<Vec<crate::dto::RunDto>, String> {
    let mut client = crate::grpc::client::build_client(addr)
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
    addr: String,
    project_id: String,
    filename: String,
    format: i32,
    content_base64: String,
) -> Result<ParsePrdResultDto, String> {
    let content = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|e| e.to_string())?;

    let mut client = crate::grpc::client::build_client(addr)
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

/// Minimal run trigger (T11): collects the event stream to the end and
/// reduces it to the final outcome. The live event feed arrives in T12.
#[tauri::command]
async fn run_case(
    addr: String,
    project_id: String,
    env_id: String,
    case_id: String,
) -> Result<RunResultDto, String> {
    let mut client = crate::grpc::client::build_client(addr)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
