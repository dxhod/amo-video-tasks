import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  redact,
  safeMessage,
  durationFrames,
  FPS,
  type Job,
  type Asset,
} from "@amo/shared";
import { rpc, type ServiceClient } from "./service";
import { normalize, detect, thumbnail, render, MediaError } from "./media";

export async function processJob(db: ServiceClient, job: Job) {
  const dir = await mkdtemp(join(tmpdir(), "amo-video-"));
  const controller = new AbortController();
  let stage = "download",
    progress = 0,
    beating = false;
  const deadline = setTimeout(() => controller.abort(), 600000);
  const beat = async () => {
    if (beating) return;
    beating = true;
    try {
      const owns = await rpc<boolean>(db, "worker_beat", {
        p_job: job.id,
        p_attempt: job.attempt,
        p_msg: job.msg_id,
        p_progress: progress,
        p_stage: stage,
      });
      if (!owns) controller.abort();
    } catch {
      controller.abort();
    } finally {
      beating = false;
    }
  };
  const heartbeat = setInterval(() => void beat(), 20000);
  let lastProgress = 0;
  const report = (seconds: number, total: number) => {
    progress = Math.min(
      94,
      Math.round(10 + (seconds / Math.max(1, total)) * 80),
    );
    if (Date.now() - lastProgress > 1000) {
      lastProgress = Date.now();
      void beat();
    }
  };
  try {
    const { data: asset, error } = await db
      .from("media_assets")
      .select("*")
      .eq("id", job.asset_id)
      .single();
    if (error) throw error;
    const a = asset as Asset;
    const object = job.kind === "analyze" ? a.source_path : a.canonical_path;
    if (!object) throw new MediaError("Вихідне відео не готове");
    const { data: file, error: downloadError } = await db.storage
      .from(job.kind === "analyze" ? "sources" : "media")
      .download(object);
    if (downloadError || !file)
      throw downloadError ?? new Error("Download failed");
    if (controller.signal.aborted)
      throw new MediaError("Втрачено резервування", "ABORTED");
    const input = join(dir, "input"),
      output = join(dir, "output.mp4");
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    if (job.kind === "analyze" && (await stat(input)).size !== a.bytes)
      throw new MediaError("Розмір файлу змінився");
    const prefix = `${a.project_id}/${a.task_id}/${job.id}/${job.attempt}-${randomUUID()}`;
    const upload = async (local: string, path: string, mime: string) => {
      if (controller.signal.aborted)
        throw new MediaError("Втрачено резервування", "ABORTED");
      const bytes = await readFile(local);
      const { error } = await db.storage
        .from("media")
        .upload(path, bytes, { contentType: mime, upsert: false });
      if (error) throw error;
      const { data: info, error: infoError } = await db.storage
        .from("media")
        .info(path);
      if (infoError || !info || Number(info.size) !== bytes.length)
        throw new Error("Не вдалося перевірити збережений файл");
    };
    let result: Record<string, unknown>;
    if (job.kind === "analyze") {
      stage = "normalize";
      await beat();
      const normalized = await normalize(input, output, {
        signal: controller.signal,
        progress: (s) => report(s, 30),
      });
      stage = "scene_detection";
      progress = 70;
      await beat();
      const timeline = await detect(
        output,
        a.id,
        normalized.frames,
        controller.signal,
      );
      stage = "thumbnails";
      const scenes = [];
      for (let i = 0; i < timeline.length; i++) {
        const c = timeline[i],
          thumb = join(dir, `scene-${i}.jpg`),
          path = `${prefix}/scene-${i}.jpg`;
        await thumbnail(
          output,
          thumb,
          Math.min(c.end - 1, c.start + Math.floor((c.end - c.start) / 2)),
          controller.signal,
        );
        await upload(thumb, path, "image/jpeg");
        scenes.push({ start: c.start, end: c.end, path });
      }
      stage = "upload";
      const path = `${prefix}/canonical.mp4`;
      await upload(output, path, "video/mp4");
      result = {
        path,
        duration: normalized.frames / FPS,
        frames: normalized.frames,
        has_audio: normalized.hasAudio,
        timeline,
        scenes,
      };
    } else {
      if (!job.snapshot) throw new MediaError("Немає знімка монтажу");
      stage = "render";
      await beat();
      const media = await render(input, output, job.snapshot, a.id, {
        signal: controller.signal,
        progress: (s) => report(s, durationFrames(job.snapshot!) / FPS),
      });
      stage = "upload";
      progress = 95;
      await beat();
      const path = `${prefix}/render.mp4`;
      await upload(output, path, "video/mp4");
      result = { path, duration: media.duration, render_ms: media.renderMs };
    }
    await beat();
    if (controller.signal.aborted)
      throw new MediaError("Втрачено резервування", "ABORTED");
    const accepted = await rpc(db, "worker_complete", {
      p_job: job.id,
      p_attempt: job.attempt,
      p_msg: job.msg_id,
      p_result: result,
    });
    console.log(
      JSON.stringify({
        event: accepted ? "job_completed" : "stale_attempt",
        job: job.id,
        attempt: job.attempt,
      }),
    );
  } catch (error) {
    const code = error instanceof MediaError ? error.code : "INFRASTRUCTURE";
    console.error(
      JSON.stringify({
        event: "job_failed",
        job: job.id,
        code,
        message: redact(safeMessage(error)),
      }),
    );
    try {
      await rpc(db, "worker_fail", {
        p_job: job.id,
        p_attempt: job.attempt,
        p_msg: job.msg_id,
        p_code: code,
        p_message: redact(safeMessage(error)),
        p_stack: redact(error instanceof Error ? (error.stack ?? "") : ""),
        p_retry:
          !(error instanceof MediaError) ||
          ["TIMEOUT", "ABORTED"].includes(code),
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "error_persistence_failed",
          job: job.id,
          message: redact(safeMessage(e)),
        }),
      );
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    controller.abort();
    // Resolve and check the exact temporary directory before recursive removal.
    const root = resolve(tmpdir()) + sep,
      target = resolve(dir);
    if (
      target.startsWith(root) &&
      target.slice(root.length).startsWith("amo-video-")
    )
      await rm(target, { recursive: true, force: true });
    else
      console.error(
        JSON.stringify({ event: "unsafe_temporary_path_cleanup_skipped" }),
      );
  }
}
