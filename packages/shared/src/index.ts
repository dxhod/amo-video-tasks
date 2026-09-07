import { z } from "zod";

export const FPS = 30;
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_SECONDS = 30;
export const clipSchema = z
  .object({
    id: z.uuid(),
    asset_id: z.uuid(),
    start: z.number().int().min(0),
    end: z.number().int().positive(),
  })
  .refine((c) => c.end > c.start, "Порожній фрагмент");
export const timelineSchema = z
  .array(clipSchema)
  .min(1)
  .max(300)
  .superRefine((clips, ctx) => {
    if (new Set(clips.map((c) => c.id)).size !== clips.length)
      ctx.addIssue({ code: "custom", message: "Повторний ID фрагмента" });
    if (clips.reduce((sum, c) => sum + c.end - c.start, 0) > MAX_SECONDS * FPS)
      ctx.addIssue({ code: "custom", message: "Монтаж довший за 30 секунд" });
  });
export type Clip = z.infer<typeof clipSchema>;
export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export const STATUSES: TaskStatus[] = ["todo", "in_progress", "review", "done"];
export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "До роботи",
  in_progress: "У роботі",
  review: "На перевірці",
  done: "Готово",
};
export const durationFrames = (clips: Clip[]) =>
  clips.reduce((sum, c) => sum + c.end - c.start, 0);
export function validateTimeline(
  clips: Clip[],
  assetId: string,
  frames: number,
) {
  timelineSchema.parse(clips);
  if (clips.some((c) => c.asset_id !== assetId || c.end > frames))
    throw new Error("Фрагмент поза межами відео");
  return clips;
}
export function locateFrame(clips: Clip[], frame: number) {
  if (!clips.length) return null;
  let offset = 0;
  const bounded = Math.max(
    0,
    Math.min(Math.floor(frame), durationFrames(clips) - 1),
  );
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index],
      length = clip.end - clip.start;
    if (bounded < offset + length)
      return { index, sourceFrame: clip.start + bounded - offset, offset };
    offset += length;
  }
  return null;
}
export function splitAt(clips: Clip[], frame: number, newId: string): Clip[] {
  const hit = locateFrame(clips, frame);
  if (!hit || frame < 0 || frame >= durationFrames(clips)) return clips;
  const c = clips[hit.index];
  if (hit.sourceFrame <= c.start || hit.sourceFrame >= c.end) return clips;
  return [
    ...clips.slice(0, hit.index),
    { ...c, end: hit.sourceFrame },
    { ...c, id: newId, start: hit.sourceFrame },
    ...clips.slice(hit.index + 1),
  ];
}
export function trimClip(
  clips: Clip[],
  id: string,
  start: number,
  end: number,
  frames: number,
) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > frames ||
    end <= start
  )
    throw new Error("Некоректні межі");
  return clips.map((c) => (c.id === id ? { ...c, start, end } : c));
}
export function moveClip(clips: Clip[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= clips.length || to >= clips.length)
    return clips;
  const result = [...clips];
  const [clip] = result.splice(from, 1);
  result.splice(to, 0, clip);
  return result;
}
export function sceneClips(
  asset: string,
  frames: number,
  seconds: number[],
  uuid: () => string,
): Clip[] {
  const boundaries = [
    ...new Set([
      0,
      ...seconds
        .map((s) => Math.round(s * FPS))
        .filter((f) => f > 0 && f < frames),
      frames,
    ]),
  ].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, i) => ({
    id: uuid(),
    asset_id: asset,
    start,
    end: boundaries[i + 1],
  }));
}
export function shouldReview(
  currentVersion: string | null,
  completedVersion: string,
  status: TaskStatus,
) {
  return currentVersion === completedVersion && status === "in_progress";
}
export const safeMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
export function redact(text: string) {
  return text
    .replace(/https?:\/\/[^\s"']+/g, "[URL]")
    .replace(/(?:Bearer\s+)[\w.-]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[TOKEN]")
    .slice(0, 12000);
}
export interface Job {
  id: string;
  task_id: string;
  asset_id: string;
  version_id: string | null;
  kind: "analyze" | "render";
  status: string;
  attempt: number;
  msg_id: number;
  progress: number;
  snapshot: Clip[] | null;
  user_id: string;
  lease_until: string;
}
export interface Asset {
  id: string;
  task_id: string;
  project_id: string;
  source_path: string;
  canonical_path: string | null;
  status: string;
  frames: number | null;
  duration: number | null;
  has_audio: boolean;
  mime: string;
  bytes: number;
}
