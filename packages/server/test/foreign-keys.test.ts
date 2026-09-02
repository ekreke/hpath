// Foreign-key namespace tests (T5 acceptance): the database itself must
// reject cross-namespace writes. Runs are the critical case: an env or case
// from a *different* project must be refused even though the id exists.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactKind } from "@hpath/contract";
import { HpathDb } from "../src/db/index.js";
import { ConflictError, ForeignKeyError } from "../src/db/errors.js";
import { makeCase, makeEnv, makeProject, makeRun } from "./helpers.js";

/** One project with an env and a case, plus a second project with its own. */
function seedTwoProjects(db: HpathDb): {
  projectA: ReturnType<typeof makeProject>;
  projectB: ReturnType<typeof makeProject>;
  envA: ReturnType<typeof makeEnv>;
  envB: ReturnType<typeof makeEnv>;
  caseA: ReturnType<typeof makeCase>;
  caseB: ReturnType<typeof makeCase>;
} {
  const projectA = makeProject({ name: "project-a" });
  const projectB = makeProject({ name: "project-b" });
  db.projects.create(projectA);
  db.projects.create(projectB);
  const envA = makeEnv(projectA, { name: "dev" });
  const envB = makeEnv(projectB, { name: "dev" });
  db.envs.create(envA);
  db.envs.create(envB);
  const caseA = makeCase(projectA, { title: "case in A" });
  const caseB = makeCase(projectB, { title: "case in B" });
  db.cases.create(caseA);
  db.cases.create(caseB);
  return { projectA, projectB, envA, envB, caseA, caseB };
}

describe("foreign-key namespace checks", () => {
  it("reject an env pointing at an unknown project", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () => db.envs.create(makeEnv(makeProject())),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("reject a case pointing at an unknown project", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () => db.cases.create(makeCase(makeProject())),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("reject a run pointing at an unknown project", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, envA, caseA } = seedTwoProjects(db);
      // Run claims project A's env and case but a nonexistent project id.
      assert.throws(
        () => db.runs.create({ ...makeRun(projectA, envA, caseA), projectId: "no-such-project" }),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("reject a run with an unknown env id", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, caseA } = seedTwoProjects(db);
      assert.throws(
        () => db.runs.create(makeRun(projectA, { ...makeEnv(projectA), id: "no-such-env" }, caseA)),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("reject a run with an unknown case id", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, envA } = seedTwoProjects(db);
      assert.throws(
        () => db.runs.create(makeRun(projectA, envA, { ...makeCase(projectA), id: "no-such-case" })),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("reject a run whose env belongs to another project", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, envB, caseA } = seedTwoProjects(db);
      // envB exists, but in project B — the composite FK must refuse it.
      assert.throws(
        () => db.runs.create(makeRun(projectA, envB, caseA)),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("reject a run whose case belongs to another project", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, envA, caseB } = seedTwoProjects(db);
      assert.throws(
        () => db.runs.create(makeRun(projectA, envA, caseB)),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("accept a run only inside a consistent project/env/case namespace", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, envA, caseA } = seedTwoProjects(db);
      const run = makeRun(projectA, envA, caseA);
      db.runs.create(run);
      assert.equal(db.runs.getRequired(run.id).projectId, projectA.id);
    } finally {
      db.close();
    }
  });

  it("reject events and artifacts pointing at an unknown run", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () => db.events.append({
          runId: "no-such-run",
          seq: 1,
          timestamp: new Date().toISOString(),
          agentText: { text: "orphan" },
        }),
        ForeignKeyError,
      );
      assert.throws(
        () => db.artifacts.insert({
          id: "art-orphan",
          runId: "no-such-run",
          kind: ArtifactKind.ARTIFACT_KIND_SCREENSHOT,
          key: "artifacts/p/e/r/shot.png",
          sizeBytes: 1,
          sha256: "",
          createdAt: new Date().toISOString(),
        }),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });

  it("cascade-delete a case's alignments and changelog without touching runs", () => {
    const db = HpathDb.inMemory();
    try {
      const { projectA, envA, caseA } = seedTwoProjects(db);
      db.runs.create(makeRun(projectA, envA, caseA));

      // With a run referencing the case, deletion must be refused.
      assert.throws(() => db.cases.delete(caseA.id), ConflictError);
      assert.equal(db.cases.get(caseA.id)?.title, "case in A");

      // Without the run, the case and its children go together.
      db.database.prepare("DELETE FROM runs").run();
      db.cases.delete(caseA.id);
      assert.equal(db.cases.get(caseA.id), undefined);
      assert.equal(
        db.database.prepare("SELECT COUNT(*) AS n FROM case_alignments WHERE case_id = ?").get(caseA.id)?.n,
        0,
      );
      assert.equal(
        db.database.prepare("SELECT COUNT(*) AS n FROM case_changelog WHERE case_id = ?").get(caseA.id)?.n,
        0,
      );
    } finally {
      db.close();
    }
  });
});
