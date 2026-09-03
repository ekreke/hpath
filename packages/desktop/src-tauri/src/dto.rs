// Serializable DTOs crossing the Tauri IPC boundary. Field names are
// camelCase to match the generated protobuf TS types in @hpath/contract, so
// the webview can use the contract types directly.

use serde::Serialize;

use crate::hpath as pb;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorDto {
    pub r#type: i32,
    pub name: String,
    pub run_ref: String,
}

impl From<&pb::Creator> for CreatorDto {
    fn from(c: &pb::Creator) -> Self {
        CreatorDto {
            r#type: c.r#type,
            name: c.name.clone(),
            run_ref: c.run_ref.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentDto {
    pub api_path: String,
    pub ui_anchor: String,
    pub rule: String,
}

impl From<&pb::Alignment> for AlignmentDto {
    fn from(a: &pb::Alignment) -> Self {
        AlignmentDto {
            api_path: a.api_path.clone(),
            ui_anchor: a.ui_anchor.clone(),
            rule: a.rule.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeLogEntryDto {
    pub version: i32,
    pub author: String,
    pub comment: String,
    pub changed_at: String,
}

impl From<&pb::ChangeLogEntry> for ChangeLogEntryDto {
    fn from(e: &pb::ChangeLogEntry) -> Self {
        ChangeLogEntryDto {
            version: e.version,
            author: e.author.clone(),
            comment: e.comment.clone(),
            changed_at: e.changed_at.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseDto {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub goal: String,
    pub alignments: Vec<AlignmentDto>,
    pub creator: Option<CreatorDto>,
    pub status: i32,
    pub source_prd_ref: String,
    pub version: i32,
    pub changelog: Vec<ChangeLogEntryDto>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&pb::Case> for CaseDto {
    fn from(c: &pb::Case) -> Self {
        CaseDto {
            id: c.id.clone(),
            project_id: c.project_id.clone(),
            title: c.title.clone(),
            goal: c.goal.clone(),
            alignments: c.alignments.iter().map(AlignmentDto::from).collect(),
            creator: c.creator.as_ref().map(CreatorDto::from),
            status: c.status,
            source_prd_ref: c.source_prd_ref.clone(),
            version: c.version,
            changelog: c.changelog.iter().map(ChangeLogEntryDto::from).collect(),
            created_at: c.created_at.clone(),
            updated_at: c.updated_at.clone(),
        }
    }
}

impl From<pb::Case> for CaseDto {
    fn from(c: pb::Case) -> Self {
        CaseDto::from(&c)
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDto {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub web_base_url: String,
    pub grpc_address: String,
    pub vars: std::collections::HashMap<String, String>,
    pub credentials: std::collections::HashMap<String, String>,
}

impl From<&pb::Env> for EnvDto {
    fn from(e: &pb::Env) -> Self {
        EnvDto {
            id: e.id.clone(),
            project_id: e.project_id.clone(),
            name: e.name.clone(),
            web_base_url: e.web_base_url.clone(),
            grpc_address: e.grpc_address.clone(),
            vars: e.vars.clone(),
            credentials: e.credentials.clone(),
        }
    }
}

impl From<EnvDto> for pb::Env {
    fn from(e: EnvDto) -> Self {
        pb::Env {
            id: e.id,
            project_id: e.project_id,
            name: e.name,
            web_base_url: e.web_base_url,
            grpc_address: e.grpc_address,
            vars: e.vars,
            credentials: e.credentials,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentEvidenceDto {
    pub api_path: String,
    pub ui_anchor: String,
    pub rule: String,
    pub api_observed: String,
    pub ui_observed: String,
    pub r#match: bool,
    pub notes: String,
}

impl From<&pb::AlignmentEvidence> for AlignmentEvidenceDto {
    fn from(e: &pb::AlignmentEvidence) -> Self {
        AlignmentEvidenceDto {
            api_path: e.api_path.clone(),
            ui_anchor: e.ui_anchor.clone(),
            rule: e.rule.clone(),
            api_observed: e.api_observed.clone(),
            ui_observed: e.ui_observed.clone(),
            r#match: e.r#match,
            notes: e.notes.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictDto {
    pub status: i32,
    pub summary: String,
    pub evidence: Vec<AlignmentEvidenceDto>,
}

impl From<&pb::Verdict> for VerdictDto {
    fn from(v: &pb::Verdict) -> Self {
        VerdictDto {
            status: v.status,
            summary: v.summary.clone(),
            evidence: v.evidence.iter().map(AlignmentEvidenceDto::from).collect(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDto {
    pub id: String,
    pub project_id: String,
    pub env_id: String,
    pub case_id: String,
    pub status: i32,
    pub trigger: i32,
    pub verdict: Option<VerdictDto>,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: i32,
    pub token_cost: i32,
    pub fail_reason: String,
}

impl From<&pb::Run> for RunDto {
    fn from(r: &pb::Run) -> Self {
        RunDto {
            id: r.id.clone(),
            project_id: r.project_id.clone(),
            env_id: r.env_id.clone(),
            case_id: r.case_id.clone(),
            status: r.status,
            trigger: r.trigger,
            verdict: r.verdict.as_ref().map(VerdictDto::from),
            started_at: r.started_at.clone(),
            finished_at: r.finished_at.clone(),
            duration_ms: r.duration_ms,
            token_cost: r.token_cost,
            fail_reason: r.fail_reason.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    pub repo_url: String,
    pub created_at: String,
}

impl From<&pb::Project> for ProjectDto {
    fn from(p: &pb::Project) -> Self {
        ProjectDto {
            id: p.id.clone(),
            name: p.name.clone(),
            repo_url: p.repo_url.clone(),
            created_at: p.created_at.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrdDto {
    pub id: String,
    pub project_id: String,
    pub filename: String,
    pub format: i32,
    pub size_bytes: i32,
    pub created_at: String,
    pub content_ref: String,
}

impl From<&pb::Prd> for PrdDto {
    fn from(p: &pb::Prd) -> Self {
        PrdDto {
            id: p.id.clone(),
            project_id: p.project_id.clone(),
            filename: p.filename.clone(),
            format: p.format,
            size_bytes: p.size_bytes,
            created_at: p.created_at.clone(),
            content_ref: p.content_ref.clone(),
        }
    }
}

/// Tagged ParseEvent for the webview: `kind` selects which optional fields
/// carry data (mirrors the proto oneof).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseEventDto {
    pub kind: String, // prdRegistered | thinking | progress | draftsCreated | error
    pub prd: Option<PrdDto>,
    pub text: Option<String>,
    pub pct: Option<i32>,
    pub message: Option<String>,
    pub case_ids: Option<Vec<String>>,
    pub cases: Option<Vec<CaseDto>>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

impl From<&pb::ParseEvent> for ParseEventDto {
    fn from(e: &pb::ParseEvent) -> Self {
        use pb::parse_event::Payload;
        match &e.payload {
            Some(Payload::PrdRegistered(p)) => ParseEventDto {
                kind: "prdRegistered".into(),
                prd: p.prd.as_ref().map(PrdDto::from),
                text: None,
                pct: None,
                message: None,
                case_ids: None,
                cases: None,
                error_kind: None,
                error_message: None,
            },
            Some(Payload::Thinking(t)) => ParseEventDto {
                kind: "thinking".into(),
                prd: None,
                text: Some(t.text.clone()),
                pct: None,
                message: None,
                case_ids: None,
                cases: None,
                error_kind: None,
                error_message: None,
            },
            Some(Payload::Progress(p)) => ParseEventDto {
                kind: "progress".into(),
                prd: None,
                text: None,
                pct: Some(p.pct),
                message: Some(p.message.clone()),
                case_ids: None,
                cases: None,
                error_kind: None,
                error_message: None,
            },
            Some(Payload::DraftsCreated(d)) => ParseEventDto {
                kind: "draftsCreated".into(),
                prd: None,
                text: None,
                pct: None,
                message: None,
                case_ids: Some(d.case_ids.clone()),
                cases: Some(d.cases.iter().map(CaseDto::from).collect()),
                error_kind: None,
                error_message: None,
            },
            Some(Payload::Error(err)) => ParseEventDto {
                kind: "error".into(),
                prd: None,
                text: None,
                pct: None,
                message: None,
                case_ids: None,
                cases: None,
                error_kind: Some(err.kind.clone()),
                error_message: Some(err.message.clone()),
            },
            None => ParseEventDto {
                kind: "progress".into(),
                prd: None,
                text: None,
                pct: None,
                message: None,
                case_ids: None,
                cases: None,
                error_kind: None,
                error_message: None,
            },
        }
    }
}

/// Aggregated result of a PRD parse (T11: stream forwarded as events, final
/// result returned from the command).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsePrdResultDto {
    pub prd: Option<PrdDto>,
    pub drafts: Vec<CaseDto>,
}

/// Aggregated result of a minimal run trigger (T11): events are collected to
/// stream end and reduced to the final run outcome. The live event feed is T12.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResultDto {
    pub run_id: String,
    pub status: i32,
    pub fail_reason: String,
    pub verdict: Option<VerdictDto>,
}

/// Artifact index entry crossing the IPC boundary (T13 replay view).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDto {
    pub id: String,
    pub run_id: String,
    pub kind: i32,
    pub key: String,
    pub size_bytes: i32,
    pub sha256: String,
    pub created_at: String,
}

impl From<&pb::Artifact> for ArtifactDto {
    fn from(a: &pb::Artifact) -> Self {
        ArtifactDto {
            id: a.id.clone(),
            run_id: a.run_id.clone(),
            kind: a.kind,
            key: a.key.clone(),
            size_bytes: a.size_bytes,
            sha256: a.sha256.clone(),
            created_at: a.created_at.clone(),
        }
    }
}

/// Full run payload for the replay view (T13): the run entity, its recorded
/// event stream (same tagged shape the live `run-event` channel emits) and
/// the artifact index.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetailDto {
    pub run: RunDto,
    pub events: Vec<RunEventDto>,
    pub artifacts: Vec<ArtifactDto>,
}

/// Progress tick for artifact downloads (T13): emitted per streamed chunk on
/// the optional `download_artifact` progress channel.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactProgressDto {
    pub bytes_received: i64,
}

/// Tagged run event for the webview (T12): `kind` selects which optional
/// fields carry data (mirrors the proto Event oneof). Streamed to the webview
/// on the `run-event` channel while `run_case` is in flight.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventDto {
    pub run_id: String,
    pub seq: i32,
    pub timestamp: String,
    pub kind: String, // agentText | agentThinking | toolStarted | toolFinished | screenshot | requestRecord | verdict | error | runStatus
    pub text: Option<String>,
    pub tool: Option<String>,
    pub args_json: Option<String>,
    pub ok: Option<bool>,
    pub result_summary: Option<String>,
    pub artifact_id: Option<String>,
    pub caption: Option<String>,
    pub direction: Option<String>,
    pub method: Option<String>,
    pub target: Option<String>,
    pub request_json: Option<String>,
    pub response_json: Option<String>,
    pub verdict: Option<VerdictDto>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub status: Option<i32>,
    pub reason: Option<String>,
}

impl From<&pb::Event> for RunEventDto {
    fn from(e: &pb::Event) -> Self {
        use pb::event::Payload;

        let mut dto = RunEventDto {
            run_id: e.run_id.clone(),
            seq: e.seq,
            timestamp: e.timestamp.clone(),
            ..Default::default()
        };
        match &e.payload {
            Some(Payload::AgentText(t)) => {
                dto.kind = "agentText".into();
                dto.text = Some(t.text.clone());
            }
            Some(Payload::AgentThinking(t)) => {
                dto.kind = "agentThinking".into();
                dto.text = Some(t.text.clone());
            }
            Some(Payload::ToolStarted(t)) => {
                dto.kind = "toolStarted".into();
                dto.tool = Some(t.tool.clone());
                dto.args_json = Some(t.args_json.clone());
            }
            Some(Payload::ToolFinished(t)) => {
                dto.kind = "toolFinished".into();
                dto.tool = Some(t.tool.clone());
                dto.ok = Some(t.ok);
                dto.result_summary = Some(t.result_summary.clone());
                dto.artifact_id = Some(t.artifact_id.clone());
            }
            Some(Payload::Screenshot(s)) => {
                dto.kind = "screenshot".into();
                dto.artifact_id = Some(s.artifact_id.clone());
                dto.caption = Some(s.caption.clone());
            }
            Some(Payload::RequestRecord(r)) => {
                dto.kind = "requestRecord".into();
                dto.direction = Some(r.direction.clone());
                dto.method = Some(r.method.clone());
                dto.target = Some(r.target.clone());
                dto.request_json = Some(r.request_json.clone());
                dto.response_json = Some(r.response_json.clone());
            }
            Some(Payload::Verdict(v)) => {
                dto.kind = "verdict".into();
                dto.verdict = Some(VerdictDto::from(v));
            }
            Some(Payload::Error(err)) => {
                dto.kind = "error".into();
                dto.error_kind = Some(err.kind.clone());
                dto.error_message = Some(err.message.clone());
            }
            Some(Payload::RunStatus(s)) => {
                dto.kind = "runStatus".into();
                dto.status = Some(s.status);
                dto.reason = Some(s.reason.clone());
            }
            None => dto.kind = "runStatus".into(),
        }
        dto
    }
}
