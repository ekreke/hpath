use serde::Serialize;
use std::collections::HashMap;
use tonic::Request;

pub mod hpath {
    tonic::include_proto!("hpath.v1");
}

pub mod grpc;

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub repo_url: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct EnvInfo {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub web_base_url: String,
    pub grpc_address: String,
    pub vars: HashMap<String, String>,
    pub credentials: HashMap<String, String>,
}

#[tauri::command]
async fn list_projects(addr: String) -> Result<Vec<ProjectInfo>, String> {
    let mut client = crate::grpc::client::build_client(addr)
        .await
        .map_err(|e| e.to_string())?;

    let response = client
        .list_projects(Request::new(hpath::Empty {}))
        .await
        .map_err(|e| e.to_string())?;

    let projects = response
        .into_inner()
        .projects
        .into_iter()
        .map(|p| ProjectInfo {
            id: p.id,
            name: p.name,
            repo_url: p.repo_url,
            created_at: p.created_at,
        })
        .collect();

    Ok(projects)
}

#[tauri::command]
async fn list_envs(addr: String, project_id: String) -> Result<Vec<EnvInfo>, String> {
    let mut client = crate::grpc::client::build_client(addr)
        .await
        .map_err(|e| e.to_string())?;

    let request = hpath::ListEnvsRequest {
        project_id,
    };

    let response = client
        .list_envs(Request::new(request))
        .await
        .map_err(|e| e.to_string())?;

    let envs = response
        .into_inner()
        .envs
        .into_iter()
        .map(|e| EnvInfo {
            id: e.id,
            project_id: e.project_id,
            name: e.name,
            web_base_url: e.web_base_url,
            grpc_address: e.grpc_address,
            vars: e.vars.into_iter().collect(),
            credentials: e.credentials.into_iter().collect(),
        })
        .collect();

    Ok(envs)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_projects,
            list_envs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
