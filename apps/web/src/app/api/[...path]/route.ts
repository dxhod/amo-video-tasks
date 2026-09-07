import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  handle,
  ApiError,
  unwrap,
  commandSchema,
  validateCommand,
  reportError,
} from "@/lib/api";
import { serviceClient } from "@/lib/supabase/service";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ path: string[] }> };
export async function POST(req: NextRequest, context: Params) {
  return handle(req, async (identity, requestId) => {
    const { db, userId } = identity;
    const { path } = await context.params;
    const raw = await req.text();
    if (raw.length > 100000) throw new ApiError("INVALID_INPUT", 413);
    const body = JSON.parse(raw);
    if (path.join("/") === "commands") {
      const { action, payload } = commandSchema.parse(body);
      // Attribute errors only to a task visible through this user's RLS session.
      const linked = payload.task_id
        ? await db
            .from("tasks")
            .select("id")
            .eq("id", String(payload.task_id))
            .maybeSingle()
        : payload.version_id
          ? await db
              .from("edit_versions")
              .select("task_id")
              .eq("id", String(payload.version_id))
              .maybeSingle()
          : payload.asset_id
            ? await db
                .from("media_assets")
                .select("task_id")
                .eq("id", String(payload.asset_id))
                .maybeSingle()
            : null;
      if (linked?.data)
        identity.taskId =
          "task_id" in linked.data
            ? String(linked.data.task_id)
            : String(linked.data.id);
      validateCommand(action, payload);
      return unwrap(
        await db.rpc("amo_command", { p_action: action, p: payload }),
      );
    }
    if (path.join("/") === "upload-errors") {
      const input = z
        .object({ task_id: z.uuid(), message: z.string().min(1).max(2000) })
        .parse(body);
      const task = unwrap(
        await db
          .from("tasks")
          .select("id,project_id")
          .eq("id", input.task_id)
          .maybeSingle(),
      );
      if (!task) throw new ApiError("NOT_FOUND", 404);
      if (!unwrap(await db.rpc("can_edit", { t: input.task_id })))
        throw new ApiError("FORBIDDEN", 403);
      const service = serviceClient();
      const { count, error } = await service
        .from("error_logs")
        .select("id", { head: true, count: "exact" })
        .eq("user_id", userId)
        .eq("stage", "upload")
        .gte("created_at", new Date(Date.now() - 60000).toISOString());
      if (error) throw error;
      if ((count ?? 0) >= 5) throw new ApiError("RATE_LIMIT", 429);
      await reportError({
        userId,
        taskId: input.task_id,
        stage: "upload",
        type: "UPLOAD_FAILED",
        message: input.message,
        critical: true,
        requestId,
      });
      return { ok: true };
    }
    throw new ApiError("NOT_FOUND", 404);
  });
}
export async function GET(req: NextRequest, context: Params) {
  return handle(req, async ({ db, userId }) => {
    const { path } = await context.params;
    const [resource, id] = path;
    if (id) z.uuid().parse(id);
    if (resource === "projects" && !id) {
      const projects = unwrap(
        await db
          .from("projects")
          .select("*")
          .order("created_at", { ascending: false }),
      );
      return {
        user_id: userId,
        projects: projects.filter((p) => !p.deleted_at),
        deleted_projects: projects.filter((p) => p.deleted_at),
      };
    }
    if (resource === "projects" && id) {
      const project = unwrap(
        await db.from("projects").select("*").eq("id", id).maybeSingle(),
      );
      if (!project || project.deleted_at) throw new ApiError("NOT_FOUND", 404);
      const [members, tasks, profiles, assets, versions] = await Promise.all([
        db.from("project_members").select("*").eq("project_id", id),
        db
          .from("tasks")
          .select("*")
          .eq("project_id", id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false }),
        db.from("profiles").select("*"),
        db
          .from("media_assets")
          .select("task_id,duration,status")
          .eq("project_id", id)
          .eq("status", "ready"),
        db
          .from("renders")
          .select(
            "version_id,duration,version_revision,edit_versions!inner(revision)",
          ),
      ]);
      return {
        project,
        user_id: userId,
        members: unwrap(members),
        tasks: unwrap(tasks),
        profiles: unwrap(profiles),
        assets: unwrap(assets),
        renders: unwrap(versions).filter(
          (r: any) => r.version_revision === r.edit_versions.revision,
        ),
      };
    }
    if (resource === "tasks" && id) {
      const task = unwrap(
        await db.from("tasks").select("*").eq("id", id).maybeSingle(),
      );
      if (!task || task.deleted_at) throw new ApiError("NOT_FOUND", 404);
      const [assets, versions, jobs, comments, events, members, profiles] =
        await Promise.all([
          db
            .from("media_assets")
            .select("*")
            .eq("task_id", id)
            .order("created_at", { ascending: false }),
          db
            .from("edit_versions")
            .select("*")
            .eq("task_id", id)
            .order("number"),
          db
            .from("processing_jobs")
            .select("*")
            .eq("task_id", id)
            .order("created_at"),
          db.from("comments").select("*").eq("task_id", id).order("created_at"),
          db
            .from("task_events")
            .select("*")
            .eq("task_id", id)
            .order("created_at"),
          db
            .from("project_members")
            .select("*")
            .eq("project_id", task.project_id),
          db.from("profiles").select("*"),
        ]);
      const assetRows = unwrap(assets),
        versionRows = unwrap(versions);
      const scenes = assetRows.length
        ? unwrap(
            await db
              .from("detected_scenes")
              .select("*")
              .in(
                "asset_id",
                assetRows.map((a) => a.id),
              ),
          )
        : [];
      const renders = versionRows.length
        ? unwrap(
            await db
              .from("renders")
              .select("*")
              .in(
                "version_id",
                versionRows.map((v) => v.id),
              ),
          )
        : [];
      const paths = [
        ...assetRows.map((a) => a.canonical_path),
        ...scenes.map((s) => s.thumbnail_path),
        ...renders.map((r) => r.path),
      ].filter(Boolean) as string[];
      const signed = paths.length
        ? unwrap(await db.storage.from("media").createSignedUrls(paths, 3600))
        : [];
      const urls = Object.fromEntries(
        signed
          .filter((s) => s.signedUrl)
          .map((s) => {
            const url = new URL(s.signedUrl!);
            return [
              s.path,
              new URL(
                url.pathname + url.search,
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
              ).toString(),
            ];
          }),
      );
      return {
        task,
        user_id: userId,
        assets: assetRows,
        versions: versionRows,
        jobs: unwrap(jobs),
        comments: unwrap(comments),
        events: unwrap(events),
        members: unwrap(members),
        profiles: unwrap(profiles),
        scenes,
        renders,
        urls,
      };
    }
    if (resource === "jobs" && id) {
      const job = unwrap(
        await db
          .from("processing_jobs")
          .select("id,status,stage,progress,error_code,attempt")
          .eq("id", id)
          .maybeSingle(),
      );
      if (!job) throw new ApiError("NOT_FOUND", 404);
      return job;
    }
    if (resource === "admin" && id) {
      if (!unwrap(await db.rpc("is_admin", { p: id })))
        throw new ApiError("FORBIDDEN", 403);
      const url = new URL(req.url);
      let query = db
        .from("error_logs")
        .select("*")
        .eq("project_id", id)
        .order("created_at", { ascending: false })
        .limit(100);
      for (const field of ["stage", "type", "task_id"]) {
        const v = url.searchParams.get(field);
        if (v) query = query.eq(field, v);
      }
      const after = url.searchParams.get("after");
      if (after) query = query.gte("created_at", z.iso.datetime().parse(after));
      const tasks = unwrap(
        await db
          .from("tasks")
          .select("id,completed_by,status")
          .eq("project_id", id)
          .is("deleted_at", null),
      );
      const jobs = tasks.length
        ? unwrap(
            await db
              .from("processing_jobs")
              .select("render_ms")
              .in(
                "task_id",
                tasks.map((t) => t.id),
              )
              .eq("status", "succeeded")
              .eq("kind", "render"),
          )
        : [];
      const completed: Record<string, number> = {};
      tasks
        .filter((t) => t.status === "done")
        .forEach((t) => {
          const key = t.completed_by ?? "unassigned";
          completed[key] = (completed[key] ?? 0) + 1;
        });
      const heartbeat = await serviceClient()
        .from("worker_heartbeats")
        .select("updated_at")
        .order("updated_at", { ascending: false })
        .limit(1);
      return {
        completed,
        deleted_tasks: unwrap(
          await db
            .from("tasks")
            .select("id,title,status,deleted_at,deleted_by")
            .eq("project_id", id)
            .not("deleted_at", "is", null)
            .order("deleted_at", { ascending: false }),
        ),
        average_render_ms: jobs.length
          ? jobs.reduce((s, j) => s + (j.render_ms ?? 0), 0) / jobs.length
          : null,
        errors: unwrap(await query),
        profiles: unwrap(await db.from("profiles").select("*")),
        worker_seen_at: heartbeat.data?.[0]?.updated_at ?? null,
      };
    }
    throw new ApiError("NOT_FOUND", 404);
  });
}
