import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { cmd, localDb, testUser } from "./helpers";

it("preserves original and rendered edits, forks changes, and enforces deletion guards", async () => {
  const admin = await testUser("Version history");
  const outsider = await testUser("Unrelated user");
  const db = localDb();
  const project = await cmd(admin.db, "project.create", { name: "History" });
  const task = await cmd(admin.db, "task.create", {
    project_id: project.id,
    title: "History",
    assignee_id: admin.id,
    reviewer_id: admin.id,
  });
  await cmd(admin.db, "task.status", {
    task_id: task.id,
    status: "in_progress",
  });
  const aid = randomUUID();
  const original = [{ id: randomUUID(), asset_id: aid, start: 0, end: 60 }];
  // DB-only fixture; no actual file or FFmpeg result is claimed here.
  expect(
    (
      await db
        .from("media_assets")
        .insert({
          id: aid,
          task_id: task.id,
          project_id: project.id,
          user_id: admin.id,
          source_path: `fixture/${aid}`,
          status: "ready",
          mime: "video/mp4",
          bytes: 1,
          frames: 60,
          duration: 2,
        })
    ).error,
  ).toBeNull();
  const { data: source, error } = await db
    .from("edit_versions")
    .insert({
      task_id: task.id,
      asset_id: aid,
      number: 0,
      timeline: original,
      created_by: admin.id,
    })
    .select()
    .single();
  expect(error).toBeNull();
  const cut = [{ ...original[0], end: 30 }];
  const draft = await cmd(admin.db, "version.save", {
    version_id: source.id,
    revision: 1,
    timeline: cut,
  });
  expect(draft.id).not.toBe(source.id);
  expect(
    (
      await db
        .from("edit_versions")
        .select("timeline")
        .eq("id", source.id)
        .single()
    ).data?.timeline,
  ).toEqual(original);
  const edited = await cmd(admin.db, "version.save", {
    version_id: draft.id,
    revision: draft.revision,
    timeline: [{ ...cut[0], end: 20 }],
  });
  await expect(
    cmd(admin.db, "version.save", {
      version_id: draft.id,
      revision: draft.revision,
      timeline: cut,
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  const job = await cmd(admin.db, "render.start", {
    version_id: draft.id,
    revision: edited.revision,
    key: randomUUID(),
  });
  expect(
    (
      await cmd(admin.db, "render.start", {
        version_id: draft.id,
        revision: edited.revision,
        key: randomUUID(),
      })
    ).id,
  ).toBe(job.id);
  await expect(
    cmd(admin.db, "version.delete", { version_id: draft.id }),
  ).rejects.toThrow("VERSION_LOCKED");
  expect(
    (
      await db
        .from("processing_jobs")
        .update({ status: "succeeded" })
        .eq("id", job.id)
    ).error,
  ).toBeNull();
  expect(
    (
      await db
        .from("renders")
        .insert({
          version_id: draft.id,
          version_revision: edited.revision,
          job_id: job.id,
          path: `fixture/${job.id}.mp4`,
          duration: 20 / 30,
        })
    ).error,
  ).toBeNull();
  const next = await cmd(admin.db, "version.save", {
    version_id: draft.id,
    revision: edited.revision,
    timeline: cut,
  });
  expect(next.id).not.toBe(draft.id);
  expect(
    (
      await db
        .from("edit_versions")
        .select("timeline")
        .eq("id", draft.id)
        .single()
    ).data?.timeline,
  ).toEqual(edited.timeline);
  const copy = await cmd(admin.db, "version.copy", { version_id: draft.id });
  await expect(
    cmd(outsider.db, "version.delete", { version_id: copy.id }),
  ).rejects.toThrow();
  await expect(
    cmd(admin.db, "version.delete", { version_id: source.id }),
  ).rejects.toThrow("VERSION_LOCKED");
  const removed = await cmd(admin.db, "version.delete", {
    version_id: copy.id,
  });
  expect(removed.selected_version_id).toBe(next.id);
  await expect(
    cmd(admin.db, "version.copy", { version_id: copy.id }),
  ).rejects.toThrow("NOT_FOUND");
  expect(
    (await db.from("renders").select("id").eq("job_id", job.id)).data,
  ).toHaveLength(1);
  expect(
    (await db.from("tasks").update({ status: "review" }).eq("id", task.id))
      .error,
  ).toBeNull();
  await expect(
    cmd(admin.db, "version.delete", { version_id: next.id }),
  ).rejects.toThrow("VERSION_LOCKED");
});
