// Real-mode ParsePRD wiring (T9): the bridge between the shared AgentKernel
// pipeline and the ParsePRD gRPC stream, mirroring run-execution.ts.
//
// One handler = one analyze run:
//   1. validate the request (project exists, content present, byte cap,
//      format inferred from the filename when unspecified),
//   2. persist the PRD: bytes land in the artifact store under
//      `artifacts/{project}/-/prd/{uuid}-{filename}` (NOT in the artifacts
//      index — that table is run-scoped and a PRD has no run), the key is
//      recorded as the PRD row's `content_ref` (empty when the upload fails:
//      the analysis proceeds, only traceability of the raw bytes is lost,
//      mirroring the mock/seed semantics),
//   3. run the registered analyze-agent through the kernel with a synthetic
//      env binding (the definition binds no env-bound browser/http/grpc
//      tools, so the empty base URL is never used) and the project's existing
//      case list, mapping kernel events to ParseEvents on the fly,
//   4. settle: a PASSED run persists the verdict's stamped drafts via
//      db.cases.create (they are proto Case shapes, kernel-stamped pending)
//      and closes the stream with drafts_created. A FAILED run — including
//      hard-limit breaches — persists nothing and closes with an error event;
//      drafts recorded before the failure stay in the stream as evidence but
//      never reach the cases table.
//
// Client disconnects do not abort the analysis: the kernel keeps executing
// (the definition's wall-clock limit bounds it); the stream simply stops
// writing. Analysis events are not persisted to the events table (it is
// run-scoped and an analyze run has no runs row) — the PRD row and the
// created drafts are the durable outcome, matching the mock handler.

import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import type { ServerWritableStream } from "@grpc/grpc-js";
import {
  AssetType,
  PrdFormat,
  RunStatus,
  type Case,
  type ParseEvent,
  type ParsePRDRequest,
  type Prd,
} from "@hpath/contract";
import type { StoredFileRef } from "../db/repositories/assets.js";
import { ANALYZE_AGENT_ID } from "../agents/analyze-agent.js";
import { MAX_PRD_BYTES, ingestPrd, prdFormatFromFilename, type PrdFormat as IngestFormat } from "../agents/prd.js";
import type { AgentRunEvent, EnvBinding } from "../agents/types.js";
import type { RunExecutionDeps } from "./run-execution.js";
import { grpcError, toGrpcError } from "./errors.js";

/** proto PrdFormat -> ingest format ("md" | "docx" | "pdf"). */
function ingestFormat(format: PrdFormat): IngestFormat | undefined {
  switch (format) {
    case PrdFormat.PRD_FORMAT_MD:
      return "md";
    case PrdFormat.PRD_FORMAT_DOCX:
      return "docx";
    case PrdFormat.PRD_FORMAT_PDF:
      return "pdf";
    default:
      return undefined;
  }
}

/** Ingest format -> proto PrdFormat (for the Prd row). */
function protoFormat(format: IngestFormat): PrdFormat {
  switch (format) {
    case "md":
      return PrdFormat.PRD_FORMAT_MD;
    case "docx":
      return PrdFormat.PRD_FORMAT_DOCX;
    case "pdf":
      return PrdFormat.PRD_FORMAT_PDF;
  }
}

/** Store key for the raw PRD bytes. PRDs have no run of their own; the env
 * segment carries a stable "-" placeholder so the shared key scheme
 * (artifacts/{project}/{env}/{run}/{name}) still validates. */
function prdKey(projectId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "prd";
  return `artifacts/${projectId}/-/prd/${randomUUID()}-${safeName}`;
}

/**
 * The real parsePrd handler: streams analyze-agent progress and finishes with
 * the created case drafts (the ParsePRD contract).
 */
export function createParsePrdHandler(deps: RunExecutionDeps) {
  return (call: ServerWritableStream<ParsePRDRequest, ParseEvent>): void => {
    void (async () => {
      try {
        const req = call.request;

        // --- validation (mock parity) --------------------------------
        if (!req.projectId) {
          throw grpcError(status.INVALID_ARGUMENT, "project_id is required");
        }
        deps.db.projects.getRequired(req.projectId); // NOT_FOUND otherwise
        if (req.content.byteLength === 0) {
          throw grpcError(status.INVALID_ARGUMENT, "content is required");
        }
        if (req.content.byteLength > MAX_PRD_BYTES) {
          throw grpcError(
            status.INVALID_ARGUMENT,
            `PRD exceeds the ${MAX_PRD_BYTES}-byte upload cap`,
          );
        }
        if (!req.filename) {
          throw grpcError(status.INVALID_ARGUMENT, "filename is required");
        }
        const format = ingestFormat(req.format) ?? prdFormatFromFilename(req.filename);
        if (!format) {
          throw grpcError(
            status.INVALID_ARGUMENT,
            `unsupported PRD format for "${req.filename}" (expected md, docx or pdf)`,
          );
        }

        // --- persist the asset (bytes -> store, metadata -> SQLite) ----
        // Since T22 the asset library is the single storage shape (type prd);
        // the stream still carries the Prd message shape (contract parity).
        const now = new Date().toISOString();
        let contentRef = "";
        const storedFiles: StoredFileRef[] = [];
        const body = Buffer.from(req.content);
        try {
          const key = prdKey(req.projectId, req.filename);
          await deps.artifactStore.putObject(key, body);
          contentRef = key;
          storedFiles.push({ filename: req.filename, key });
        } catch (err) {
          // Best-effort upload: the analysis still proceeds, only the raw
          // bytes lose their storage reference.
          console.error("[hpath-server] PRD upload failed, content_ref left empty:", err);
        }
        // Extract the preview text for the asset detail view (same ingest the
        // analyze flow uses). Best-effort: a parse failure only forfeits the
        // preview, never the analysis.
        let textContent = "";
        try {
          textContent = (await ingestPrd(body, format)).text;
        } catch (err) {
          console.error(`[hpath-server] PRD text extraction failed for "${req.filename}":`, err);
        }
        // The asset row and the streamed Prd message share one id, so
        // clients can go straight from "prd registered" to the asset detail.
        const assetId = randomUUID();
        deps.db.assets.insert({
          id: assetId,
          projectId: req.projectId,
          type: AssetType.ASSET_TYPE_PRD,
          filename: req.filename,
          sizeBytes: body.byteLength,
          createdAt: now,
          contentRef,
          apiDoc: "",
          methods: [],
          fileCount: 0,
          textContent,
          storedFiles,
        });
        const prd: Prd = {
          id: assetId,
          projectId: req.projectId,
          filename: req.filename,
          format: protoFormat(format),
          sizeBytes: body.byteLength,
          createdAt: now,
          contentRef,
        };
        if (!call.cancelled) {
          call.write({ prdRegistered: { prd } });
        }

        // --- run the analyze-agent through the shared kernel ---------
        const existingCases = deps.db.cases
          .listByProject(req.projectId)
          .map((kase) => ({ title: kase.title, goal: kase.goal }));
        // Synthetic env binding: the analyze-agent binds no env-bound tools,
        // so an empty base URL is never touched; no env agentLimits are set,
        // so the definition's defaults apply.
        const env: EnvBinding = {
          projectId: req.projectId,
          envId: "",
          name: "prd-analysis",
          baseUrl: "",
          variables: {},
        };
        const result = await deps.kernel.run({
          agentId: ANALYZE_AGENT_ID,
          input: {
            projectId: req.projectId,
            filename: req.filename,
            format,
            contentBase64: body.toString("base64"),
            existingCases,
          },
          env,
        });

        // --- map kernel events -> ParseEvents (live, unpersisted) ----
        for (const event of result.events) {
          const proto = toParseEvent(event);
          if (proto && !call.cancelled) {
            call.write(proto);
          }
        }

        // --- settle ---------------------------------------------------
        if (result.status === RunStatus.RUN_STATUS_PASSED && result.verdict) {
          const drafts = (Array.isArray(result.verdict.drafts) ? result.verdict.drafts : []) as Case[];
          const created: Case[] = [];
          for (const draft of drafts) {
            try {
              created.push(deps.db.cases.create(draft));
            } catch (err) {
              // One broken draft must not drop the others; the failure is
              // reported on the stream so the user sees the partial result.
              call.write({
                error: {
                  kind: "case_create",
                  message: `draft "${draft.title}" could not be persisted: ${(err as Error).message}`,
                },
              });
            }
          }
          if (!call.cancelled) {
            call.write({
              draftsCreated: { caseIds: created.map((kase) => kase.id), cases: created },
            });
          }
          call.end();
        } else {
          // FAILED (no verdict, invalid verdict, agent error, hard-limit
          // breach, cancellation): nothing lands in the cases table; the
          // stream closes with a structured error naming the reason.
          call.write({
            error: {
              kind: result.failReason || "agent_error",
              message: `analyze-agent run did not produce drafts (${result.failReason || "no verdict"})`,
            },
          });
          call.end();
        }
      } catch (err) {
        call.emit("error", toGrpcError(err));
      }
    })();
  };
}

/** kernel payload -> proto ParseEvent; undefined for kernel-internal kinds
 * the ParsePRD contract has no branch for (drafts surface through the final
 * drafts_created, evidence entries through the verdict). */
function toParseEvent(event: AgentRunEvent): ParseEvent | undefined {
  const payload = event.payload;
  switch (payload.kind) {
    case "agent_text":
    case "agent_thinking":
      // The ParsePRD contract has a single "thinking" text channel; both
      // assistant text and thinking stream into it (mock parity).
      return { thinking: { text: payload.text } };
    case "tool_started":
      return toolProgress(payload.tool, "started");
    case "tool_finished":
      return payload.ok
        ? toolProgress(payload.tool, "finished")
        : { error: { kind: "tool_error", message: `${payload.tool} failed: ${payload.resultSummary}` } };
    case "error":
      return { error: { kind: payload.errorKind, message: payload.message } };
    case "run_status":
    case "request_record":
    case "verdict":
    case "evidence_recorded":
    case "case_draft_recorded":
    case "screenshot":
      return undefined;
  }
}

/** Rough progress mapping for the UI's progress bar (mock parity: the mock
 * streams 30% "Extracting requirements" / 70% "Drafting cases"). */
function toolProgress(tool: string, phase: "started" | "finished"): ParseEvent {
  switch (tool) {
    case "read_prd":
      return {
        progress: {
          pct: phase === "finished" ? 30 : 10,
          message: phase === "finished" ? "PRD text extracted" : "Reading the PRD",
        },
      };
    case "list_existing_cases":
      return { progress: { pct: 40, message: "Checking existing coverage" } };
    case "write_case_draft":
      return {
        progress: {
          pct: phase === "finished" ? 70 : 60,
          message: phase === "finished" ? "Case draft recorded" : "Drafting cases",
        },
      };
    case "finish_verdict":
      return { progress: { pct: 90, message: "Finalizing analysis" } };
    default:
      return { progress: { pct: 50, message: `${tool} ${phase}` } };
  }
}
