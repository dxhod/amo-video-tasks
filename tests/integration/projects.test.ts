import { it, expect } from "vitest";
import { cmd, testUser } from "./helpers";

it("archives the whole project, restricts restoration to admins and preserves task deletion independently", async () => {
  const admin = await testUser("Project admin");
  const member = await testUser("Project member");
  const outsider = await testUser("Project outsider");
  const p = await cmd(admin.db, "project.create", {
    name: "Recoverable project",
  });
  await cmd(admin.db, "member.add", { project_id: p.id, email: member.email });
  const task = await cmd(admin.db, "task.create", {
    project_id: p.id,
    title: "Keep me",
    assignee_id: member.id,
  });
  const deleted = await cmd(admin.db, "task.create", {
    project_id: p.id,
    title: "Already deleted",
  });
  await cmd(member.db, "comment.add", {
    task_id: task.id,
    body: "Preserve history",
  });
  await cmd(admin.db, "task.delete", { task_id: deleted.id });
  await expect(
    cmd(member.db, "project.delete", { project_id: p.id }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    cmd(outsider.db, "project.delete", { project_id: p.id }),
  ).rejects.toThrow("NOT_FOUND");
  await cmd(admin.db, "project.delete", { project_id: p.id });
  await cmd(admin.db, "project.delete", { project_id: p.id });
  expect(
    (await member.db.from("projects").select("id").eq("id", p.id)).data,
  ).toEqual([]);
  expect(
    (
      await admin.db
        .from("projects")
        .select("deleted_at")
        .eq("id", p.id)
        .single()
    ).data?.deleted_at,
  ).toBeTruthy();
  for (const user of [admin, member, outsider]) {
    expect(
      (await user.db.from("tasks").select("id").eq("project_id", p.id)).data,
    ).toEqual([]);
    expect(
      (await user.db.from("comments").select("id").eq("task_id", task.id)).data,
    ).toEqual([]);
  }
  await expect(
    cmd(admin.db, "task.create", { project_id: p.id, title: "Blocked" }),
  ).rejects.toThrow("PROJECT_DELETED");
  await expect(
    cmd(admin.db, "comment.add", { task_id: task.id, body: "Blocked" }),
  ).rejects.toThrow("PROJECT_DELETED");
  await expect(
    cmd(member.db, "project.restore", { project_id: p.id }),
  ).rejects.toThrow();
  await cmd(admin.db, "project.restore", { project_id: p.id });
  await cmd(admin.db, "project.restore", { project_id: p.id });
  expect(
    (await member.db.from("tasks").select("id").eq("project_id", p.id)).data,
  ).toEqual([{ id: task.id }]);
  expect(
    (await member.db.from("comments").select("body").eq("task_id", task.id))
      .data,
  ).toEqual([{ body: "Preserve history" }]);
  expect(
    (
      await admin.db
        .from("tasks")
        .select("deleted_at")
        .eq("id", deleted.id)
        .single()
    ).data?.deleted_at,
  ).toBeTruthy();
});
