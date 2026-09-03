// Artifact storage module (T6): the public surface for the run pipeline
// (T8). One ArtifactStore interface with a local (filesystem) and an s3
// (SeaweedFS) backend, the shared artifacts/{project}/{env}/{run}/... key
// scheme, streaming helpers, and the artifact index accounting over the T5
// artifacts table.

export * from "./store.js";
export * from "./artifact-index.js";
