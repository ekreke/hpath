// Shared artifact key scheme (T6), common to every ArtifactStore backend:
//
//   artifacts/{project}/{env}/{run}/{name}
//
// `name` may itself contain slashes (e.g. "steps/01-login.png"), so a key has
// at least five segments. Keys are used verbatim as filesystem paths (local)
// and S3 object names (s3), so they are validated strictly: forward slashes
// only, no empty/`.`/`..` segments, no control characters.

export const ARTIFACT_KEY_PREFIX = "artifacts";

export interface ArtifactKeyParts {
  projectId: string;
  envId: string;
  runId: string;
  /** Remainder under the run directory; may contain subdirectories. */
  name: string;
}

/**
 * Build a store key from its namespace parts. Throws on parts that would
 * produce an invalid or ambiguous key (see assertSafeSegment).
 */
export function artifactKey(parts: ArtifactKeyParts): string {
  const segments = [
    ARTIFACT_KEY_PREFIX,
    parts.projectId,
    parts.envId,
    parts.runId,
    ...parts.name.split("/"),
  ];
  for (const segment of segments) {
    assertSafeSegment(segment);
  }
  return segments.join("/");
}

/** Parse a store key back into its parts; undefined when malformed. */
export function parseArtifactKey(key: string): ArtifactKeyParts | undefined {
  if (!isValidArtifactKey(key)) {
    return undefined;
  }
  const [, projectId, envId, runId, ...name] = key.split("/");
  return { projectId, envId, runId, name: name.join("/") };
}

/** True when `key` follows the shared scheme and is safe for all backends. */
export function isValidArtifactKey(key: string): boolean {
  const segments = key.split("/");
  if (segments.length < 5) {
    return false; // artifacts/{project}/{env}/{run}/{name...}
  }
  if (segments[0] !== ARTIFACT_KEY_PREFIX) {
    return false;
  }
  return segments.every((segment) => isSafeSegment(segment));
}

function assertSafeSegment(segment: string): void {
  if (!isSafeSegment(segment)) {
    throw new Error(`invalid artifact key segment: ${JSON.stringify(segment)}`);
  }
}

function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") {
    return false;
  }
  // Backslashes would be path separators on Windows; control characters and
  // NUL have no business in keys.
  if (/[/\\]/.test(segment) || /[\x00-\x1f\x7f]/.test(segment)) {
    return false;
  }
  return true;
}
