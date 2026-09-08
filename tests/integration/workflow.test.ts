import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { localDb, testUser, cmd } from "./helpers";
import { rpc } from "../../apps/worker/src/service";
import { ffmpeg } from "../../apps/worker/src/media";
import { processJob } from "../../apps/worker/src/process-job";
let admin: Awaited<ReturnType<typeof testUser>>,
  editor: typeof admin,
  reviewer: typeof admin,
  outsider: typeof admin;
let project: string, task: string, asset: any, v1: any, job: any;
beforeAll(async () => {
  [admin, editor, reviewer, outsider] = await Promise.all(
    ["Адміністратор", "Монтажер", "Рев’юер", "Сторонній"].map(testUser),
  );
  project = (
    await cmd(admin.db, "project.create", {
      name: "Integration video workflow",
    })
  ).id;
  await cmd(admin.db, "member.add", {
    project_id: project,
    email: editor.email,
  });
  await cmd(admin.db, "member.add", {
    project_id: project,
    email: reviewer.email,
  });
  task = (
    await cmd(admin.db, "task.create", {
      project_id: project,
      title: "Two versions",
      assignee_id: editor.id,
      reviewer_id: reviewer.id,
    })
  ).id;
});

describe("Supabase workflow", () => {
  it("isolates project data and disallows direct writes and worker calls", async () => {
    expect(
      (await outsider.db.from("tasks").select("*").eq("id", task)).data,
    ).toEqual([]);
    expect(
      (await editor.db.from("tasks").update({ status: "done" }).eq("id", task))
        .error,
    ).toBeTruthy();
    await expect(
      cmd(outsider.db, "comment.add", { task_id: task, body: "No access" }),
    ).rejects.toThrow();
    expect(
      (await editor.db.rpc("worker_claim", { p_worker: "unauthorized" })).error,
    ).toBeTruthy();
    await expect(
      cmd(editor.db, "task.status", { task_id: task, status: "done" }),
    ).rejects.toThrow();
  });
  it("uploads, queues atomically, detects scenes and creates v1 with real FFmpeg", async () => {
    const dir = await mkdtemp(join(tmpdir(), "amo-db-test-"));
    try {
      const input = join(dir, "input.mp4");
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x90:r=30:d=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        input,
      ]);
      const bytes = await readFile(input);
      asset = await cmd(editor.db, "upload.create", {
        task_id: task,
        mime: "video/mp4",
        bytes: bytes.length,
      });
      const uploaded = await editor.db.storage
        .from("sources")
        .upload(asset.source_path, bytes, { contentType: "video/mp4" });
      expect(uploaded.error).toBeNull();
      const key = randomUUID();
      job = await cmd(editor.db, "upload.complete", {
        asset_id: asset.id,
        key,
      });
      expect(
        (await cmd(editor.db, "upload.complete", { asset_id: asset.id, key }))
          .id,
      ).toBe(job.id);
      const claimed = await rpc(localDb(), "worker_claim", {
        p_worker: "integration",
      });
      expect(claimed.id).toBe(job.id);
      await processJob(localDb(), claimed);
      const finished = await localDb()
        .from("processing_jobs")
        .select("*")
        .eq("id", job.id)
        .single();
      expect(finished.data?.status, JSON.stringify(finished.data)).toBe(
        "succeeded",
      );
      v1 = (
        await editor.db
          .from("edit_versions")
          .select("*")
          .eq("task_id", task)
          .eq("number", 1)
          .single()
      ).data;
      expect(v1.timeline.length).toBe(2);
      const foreign = await outsider.db.storage
        .from("sources")
        .download(asset.source_path);
      expect(foreign.error).toBeTruthy();
    } finally {
      const target = resolve(dir),
        root = resolve(tmpdir()) + sep;
      if (
        target.startsWith(root) &&
        target.slice(root.length).startsWith("amo-db-test-")
      )
        await rm(target, { recursive: true, force: true });
    }
  });
  it("rejects revision conflicts, freezes render, preserves old completion and renders v2", async () => {
    const reversed = [...v1.timeline].reverse();
    const saved = await cmd(editor.db, "version.save", {
      version_id: v1.id,
      revision: 1,
      timeline: reversed,
    });
    expect(saved.revision).toBe(2);
    await expect(
      cmd(editor.db, "version.save", {
        version_id: v1.id,
        revision: 1,
        timeline: v1.timeline,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const render = await cmd(editor.db, "render.start", {
      version_id: v1.id,
      revision: 2,
      key: randomUUID(),
    });
    expect(
      (
        await cmd(editor.db, "render.start", {
          version_id: v1.id,
          revision: 2,
          key: randomUUID(),
        })
      ).id,
    ).toBe(render.id);
    await expect(
      cmd(editor.db, "version.save", {
        version_id: v1.id,
        revision: 2,
        timeline: reversed,
      }),
    ).rejects.toThrow("VERSION_LOCKED");
    const v2 = await cmd(editor.db, "version.copy", { version_id: v1.id });
    await processJob(
      localDb(),
      await rpc(localDb(), "worker_claim", { p_worker: "integration" }),
    );
    expect(
      (await editor.db.from("tasks").select("status").eq("id", task).single())
        .data?.status,
    ).toBe("in_progress");
    const v2data = (
      await editor.db.from("edit_versions").select("*").eq("id", v2.id).single()
    ).data!;
    await cmd(editor.db, "version.save", {
      version_id: v2.id,
      revision: 1,
      timeline: [{ ...v2data.timeline[0], end: v2data.timeline[0].start + 15 }],
    });
    await cmd(editor.db, "render.start", {
      version_id: v2.id,
      revision: 2,
      key: randomUUID(),
    });
    await processJob(
      localDb(),
      await rpc(localDb(), "worker_claim", { p_worker: "integration" }),
    );
    const renders = (
      await editor.db
        .from("renders")
        .select("*")
        .in("version_id", [v1.id, v2.id])
    ).data!;
    expect(renders).toHaveLength(2);
    expect(new Set(renders.map((r) => r.path)).size).toBe(2);
    expect(renders.map((r) => r.duration).sort()).toEqual([0.5, 2]);
    expect(
      (await editor.db.from("tasks").select("status").eq("id", task).single())
        .data?.status,
    ).toBe("in_progress");
    await cmd(editor.db, "task.status", {
      task_id: task,
      status: "review",
      version_id: v1.id,
    });
    expect(
      (
        await editor.db
          .from("tasks")
          .select("status,current_version_id,review_version_id")
          .eq("id", task)
          .single()
      ).data,
    ).toMatchObject({
      status: "review",
      current_version_id: v1.id,
      review_version_id: v1.id,
    });
    expect(
      (
        await reviewer.db
          .from("edit_versions")
          .select("number")
          .eq("task_id", task)
          .order("number")
      ).data,
    ).toEqual([{ number: 0 }, { number: v1.number }]);
    await expect(
      cmd(editor.db, "task.status", { task_id: task, status: "done" }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      cmd(reviewer.db, "task.status", {
        task_id: task,
        status: "in_progress",
        comment: "",
      }),
    ).rejects.toThrow();
    await cmd(reviewer.db, "task.status", { task_id: task, status: "done" });
    const done = (
      await editor.db.from("tasks").select("*").eq("id", task).single()
    ).data!;
    expect(done.status).toBe("done");
    expect(done.completed_by).toBe(editor.id);
    expect(
      (
        await reviewer.db
          .from("edit_versions")
          .select("number")
          .eq("task_id", task)
      ).data,
    ).toEqual([{ number: v1.number }]);
    await expect(
      cmd(editor.db, "version.copy", { version_id: v1.id }),
    ).rejects.toThrow("VERSION_LOCKED");
  });
  it("retries a failed result upload and records the error plus notification atomically", async () => {
    await cmd(admin.db, "task.status", {
      task_id: task,
      status: "in_progress",
    });
    const v = await cmd(editor.db, "version.copy", { version_id: v1.id });
    await cmd(editor.db, "render.start", {
      version_id: v.id,
      revision: 1,
      key: randomUUID(),
    });
    const db = localDb(),
      claimed = await rpc(db, "worker_claim", { p_worker: "upload-failure" });
    const original = db.storage.from.bind(db.storage);
    const mocked = vi
      .spyOn(db.storage, "from")
      .mockImplementation((bucket: string) => {
        const storage = original(bucket);
        if (bucket === "media")
          storage.upload = async () =>
            ({
              data: null,
              error: {
                name: "StorageError",
                message: "Injected temporary upload failure",
              },
            }) as any;
        return storage;
      });
    try {
      await processJob(db, claimed);
    } finally {
      mocked.mockRestore();
    }
    const failed = (
      await db.from("processing_jobs").select("*").eq("id", claimed.id).single()
    ).data!;
    expect(failed.status).toBe("queued");
    expect(failed.attempt).toBe(1);
    expect(
      (await editor.db.from("renders").select("*").eq("version_id", v.id)).data,
    ).toEqual([]);
    const errors = (
      await db.from("error_logs").select("*").eq("job_id", claimed.id)
    ).data!;
    expect(errors).toHaveLength(1);
    expect(errors[0].critical).toBe(true);
    expect(
      (
        await db
          .from("notification_outbox")
          .select("*")
          .eq("error_id", errors[0].id)
      ).data,
    ).toHaveLength(1);
    expect(
      (
        await reviewer.db
          .from("error_logs")
          .select("*")
          .eq("job_id", claimed.id)
      ).data,
    ).toEqual([]);
    const sql = new pg.Client({
      connectionString:
        process.env.DB_URL ??
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    await sql.connect();
    try {
      await sql.query("select pgmq.set_vt('video',$1,0)", [claimed.msg_id]);
    } finally {
      await sql.end();
    }
    const retry = await rpc(db, "worker_claim", { p_worker: "upload-retry" });
    expect(retry.attempt).toBe(2);
    await processJob(db, retry);
    expect(
      (
        await db
          .from("processing_jobs")
          .select("status")
          .eq("id", claimed.id)
          .single()
      ).data?.status,
    ).toBe("succeeded");
  });
  it("fences a stale worker and safely redelivers after lease expiration", async () => {
    const v = await cmd(editor.db, "version.copy", { version_id: v1.id });
    await cmd(editor.db, "render.start", {
      version_id: v.id,
      revision: 1,
      key: randomUUID(),
    });
    const first = await rpc(localDb(), "worker_claim", { p_worker: "first" });
    await localDb()
      .from("processing_jobs")
      .update({ lease_until: new Date(0).toISOString() })
      .eq("id", first.id);
    expect(
      await rpc(localDb(), "worker_complete", {
        p_job: first.id,
        p_attempt: first.attempt,
        p_msg: first.msg_id,
        p_result: { path: "stale.mp4", duration: 2, render_ms: 10 },
      }),
    ).toBe(false);
    // Expire visibility directly in the disposable local DB; no test-only production RPC.
    const sql = new pg.Client({
      connectionString:
        process.env.DB_URL ??
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    await sql.connect();
    try {
      await sql.query("select pgmq.set_vt('video',$1,0)", [first.msg_id]);
    } finally {
      await sql.end();
    }
    const second = await rpc(localDb(), "worker_claim", { p_worker: "second" });
    expect(second.attempt).toBe(2);
    expect(
      await rpc(localDb(), "worker_beat", {
        p_job: first.id,
        p_attempt: first.attempt,
        p_msg: first.msg_id,
        p_progress: 99,
        p_stage: "stale",
      }),
    ).toBe(false);
    await processJob(localDb(), second);
    expect(
      (
        await localDb()
          .from("processing_jobs")
          .select("status")
          .eq("id", first.id)
          .single()
      ).data?.status,
    ).toBe("succeeded");
  });
});

it("re-edits a rendered version in progress, retains both MP4s and requires a fresh review result", async () => {
  const db = localDb();
  const taskRow = (await db.from("tasks").select("*").eq("id", task).single())
    .data!;
  const v = (
    await db
      .from("edit_versions")
      .select("*")
      .eq("id", taskRow.current_version_id)
      .single()
  ).data!;
  const old = (
    await db.from("renders").select("*").eq("version_id", v.id).single()
  ).data!;
  const allVersionCount = (
    await db
      .from("edit_versions")
      .select("id")
      .eq("task_id", task)
      .is("deleted_at", null)
  ).data!.length;
  await cmd(editor.db, "task.status", {
    task_id: task,
    status: "review",
    version_id: v.id,
  });
  await expect(
    cmd(editor.db, "version.save", {
      version_id: v.id,
      revision: v.revision,
      timeline: v.timeline,
    }),
  ).rejects.toThrow("VERSION_LOCKED");
  await cmd(reviewer.db, "task.status", {
    task_id: task,
    status: "in_progress",
    comment: "Edit same version",
  });
  expect(
    (await reviewer.db.from("edit_versions").select("id").eq("task_id", task))
      .data,
  ).toHaveLength(allVersionCount);
  const changed = [{ ...v.timeline[0], end: v.timeline[0].start + 8 }];
  const saved = await cmd(editor.db, "version.save", {
    version_id: v.id,
    revision: v.revision,
    timeline: changed,
  });
  expect(saved.number).toBeGreaterThan(v.number);
  expect(saved.id).not.toBe(v.id);
  expect(saved.revision).toBe(1);
  await expect(
    cmd(editor.db, "task.status", {
      task_id: task,
      status: "review",
      version_id: saved.id,
    }),
  ).rejects.toThrow("RENDER_REQUIRED");
  expect(
    (await db.from("edit_versions").select("timeline").eq("id", v.id).single())
      .data?.timeline,
  ).toEqual(v.timeline);
  const key = `render:${v.id}`;
  const j = await cmd(editor.db, "render.start", {
    version_id: saved.id,
    revision: saved.revision,
    key,
  });
  expect(j.version_revision).toBe(saved.revision);
  expect(
    (
      await cmd(editor.db, "render.start", {
        version_id: saved.id,
        revision: saved.revision,
        key,
      })
    ).id,
  ).toBe(j.id);
  await expect(
    cmd(editor.db, "version.save", {
      version_id: saved.id,
      revision: saved.revision,
      timeline: changed,
    }),
  ).rejects.toThrow("VERSION_LOCKED");
  await processJob(
    db,
    await rpc(db, "worker_claim", { p_worker: "revision-render" }),
  );
  expect(
    (await db.from("tasks").select("status").eq("id", task).single()).data
      ?.status,
  ).toBe("in_progress");
  await cmd(editor.db, "task.status", {
    task_id: task,
    status: "review",
    version_id: saved.id,
  });
  const results = (
    await db.from("renders").select("*").in("version_id", [v.id, saved.id])
  ).data!;
  expect(results).toHaveLength(2);
  expect(results.find((r) => r.id === old.id)?.path).toBe(old.path);
  expect(results.find((r) => r.version_id === saved.id)?.duration).toBeCloseTo(
    8 / 30,
    2,
  );
  for (const r of results)
    expect((await db.storage.from("media").download(r.path)).error).toBeNull();
  expect(
    (await editor.db.storage.from("media").download(old.path)).error,
  ).toBeTruthy();
  expect(
    (
      await editor.db.storage
        .from("media")
        .download(results.find((r) => r.version_id === saved.id)!.path)
    ).error,
  ).toBeNull();
  expect(
    (await db.from("tasks").select("status").eq("id", task).single()).data
      ?.status,
  ).toBe("review");
  await cmd(reviewer.db, "task.status", { task_id: task, status: "done" });
  await expect(
    cmd(admin.db, "version.save", {
      version_id: v.id,
      revision: saved.revision,
      timeline: changed,
    }),
  ).rejects.toThrow("VERSION_LOCKED");
});
