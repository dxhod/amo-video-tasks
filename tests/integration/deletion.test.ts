import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { cmd, localDb, testUser } from "./helpers";
import { rpc } from "../../apps/worker/src/service";

it("worker completion preserves the deletion marker and keeps the result for restoration", async () => {
  const admin = await testUser("Archived render");
  const db = localDb();
  const project = await cmd(admin.db, "project.create", {
    name: "Archived processing",
  });
  const task = await cmd(admin.db, "task.create", {
    project_id: project.id,
    title: "Background result",
    assignee_id: admin.id,
    reviewer_id: admin.id,
  });
  await cmd(admin.db, "task.status", {
    task_id: task.id,
    status: "in_progress",
  });
  // Database-contract fixture: no media processing or actual object is claimed by this test.
  const aid = randomUUID(),
    vid = randomUUID(),
    jid = randomUUID();
  const timeline = [{ id: randomUUID(), asset_id: aid, start: 0, end: 30 }];
  const a = await db.from("media_assets").insert({
    id: aid,
    task_id: task.id,
    project_id: project.id,
    user_id: admin.id,
    source_path: `fixture/${aid}`,
    status: "ready",
    mime: "video/mp4",
    bytes: 1,
    frames: 30,
    duration: 1,
  });
  expect(a.error).toBeNull();
  const v = await db.from("edit_versions").insert({
    id: vid,
    task_id: task.id,
    asset_id: aid,
    number: 1,
    timeline,
    created_by: admin.id,
    locked_at: new Date().toISOString(),
  });
  expect(v.error).toBeNull();
  expect(
    (
      await db
        .from("tasks")
        .update({ current_version_id: vid })
        .eq("id", task.id)
    ).error,
  ).toBeNull();
  const j = await db.from("processing_jobs").insert({
    id: jid,
    task_id: task.id,
    asset_id: aid,
    version_id: vid,
    version_revision: 1,
    user_id: admin.id,
    kind: "render",
    snapshot: timeline,
    status: "running",
    attempt: 1,
    msg_id: -1,
    lease_until: new Date(Date.now() + 120000).toISOString(),
  });
  expect(j.error).toBeNull();
  await cmd(admin.db, "task.delete", { task_id: task.id });
  expect(
    await rpc(db, "worker_complete", {
      p_job: jid,
      p_attempt: 1,
      p_msg: -1,
      p_result: { path: `fixture/${jid}.mp4`, duration: 1, render_ms: 50 },
    }),
  ).toBe(true);
  const archived = await db
    .from("tasks")
    .select("deleted_at,status")
    .eq("id", task.id)
    .single();
  expect(archived.data?.deleted_at).toBeTruthy();
  expect(archived.data?.status).toBe("review");
  await cmd(admin.db, "task.restore", { task_id: task.id });
  expect(
    (await admin.db.from("renders").select("version_id").eq("version_id", vid))
      .data,
  ).toEqual([{ version_id: vid }]);
});

it("only the project admin can delete and restore; archived tasks reject writes and preserve history", async () => {
  const admin = await testUser("Delete admin");
  const member = await testUser("Delete member");
  const outsider = await testUser("Delete outsider");
  const project = await cmd(admin.db, "project.create", {
    name: "Deletion checks",
  });
  await cmd(admin.db, "member.add", {
    project_id: project.id,
    email: member.email,
  });
  const task = await cmd(admin.db, "task.create", {
    project_id: project.id,
    title: "Retain task",
    assignee_id: member.id,
    reviewer_id: admin.id,
  });
  await cmd(member.db, "comment.add", {
    task_id: task.id,
    body: "Keep this comment",
  });
  for (const user of [member, outsider])
    await expect(
      cmd(user.db, "task.delete", { task_id: task.id }),
    ).rejects.toThrow();
  await cmd(admin.db, "task.delete", { task_id: task.id });
  await cmd(admin.db, "task.delete", { task_id: task.id });
  expect(
    (await member.db.from("tasks").select("id").eq("id", task.id)).data,
  ).toEqual([]);
  expect(
    (await member.db.from("comments").select("id").eq("task_id", task.id)).data,
  ).toEqual([]);
  expect(
    (
      await admin.db
        .from("tasks")
        .select("deleted_by")
        .eq("id", task.id)
        .single()
    ).data?.deleted_by,
  ).toBe(admin.id);
  await expect(
    cmd(admin.db, "task.update", { task_id: task.id, title: "Changed" }),
  ).rejects.toThrow("TASK_DELETED");
  await expect(
    cmd(member.db, "comment.add", { task_id: task.id, body: "Changed" }),
  ).rejects.toThrow();
  await expect(
    cmd(member.db, "task.restore", { task_id: task.id }),
  ).rejects.toThrow("FORBIDDEN");
  expect(
    (
      await member.db.rpc("amo_command_base", {
        p_action: "task.restore",
        p: { task_id: task.id },
      })
    ).error,
  ).toBeTruthy();
  await cmd(admin.db, "task.restore", { task_id: task.id });
  await cmd(admin.db, "task.restore", { task_id: task.id });
  expect(
    (
      await member.db
        .from("tasks")
        .select("title,deleted_at,status")
        .eq("id", task.id)
        .single()
    ).data,
  ).toEqual({ title: "Retain task", deleted_at: null, status: "todo" });
  expect(
    (await member.db.from("comments").select("body").eq("task_id", task.id))
      .data,
  ).toEqual([{ body: "Keep this comment" }]);
  const events = await localDb()
    .from("task_events")
    .select("event_type")
    .eq("task_id", task.id)
    .order("created_at");
  expect(events.data?.map((e) => e.event_type)).toEqual([
    "deleted",
    "restored",
  ]);
});
