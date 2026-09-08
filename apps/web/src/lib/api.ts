import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { redact, timelineSchema } from "@amo/shared";
import { serverClient } from "./supabase/server";
import { serviceClient } from "./supabase/service";
import { requestOrigin } from "./request-origin";

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const messages: Record<string, string> = {
  UNAUTHORIZED: "Увійдіть до облікового запису.",
  FORBIDDEN: "Недостатньо прав для цієї дії.",
  NOT_FOUND: "Об’єкт не знайдено.",
  USER_NOT_FOUND: "Користувач має зареєструватися та підтвердити email.",
  REVISION_CONFLICT:
    "Монтаж змінено в іншій вкладці. Завантажте актуальну версію.",
  VERSION_LOCKED:
    "Монтаж доступний у статусі «У роботі», коли версія не рендериться.",
  PROJECT_DELETED:
    "Проєкт видалено. Адміністратор може відновити його у списку проєктів.",
  INVALID_TRANSITION: "Цей перехід статусу недоступний.",
  RENDER_REQUIRED: "Спочатку завершіть рендер актуальної версії.",
  TASK_DONE: "Адміністратор має спочатку повернути задачу в роботу.",
  TASK_DELETED:
    "Задачу видалено. Адміністратор може відновити її в статистиці проєкту.",
  SOURCE_EXISTS: "Задача вже має вихідне відео або незавершене завантаження.",
  INVALID_TIMELINE: "Перевірте межі фрагментів монтажу.",
  UPLOAD_INCOMPLETE: "Завантаження ще не завершено.",
  INVALID_UPLOAD:
    "Сесію завантаження завершено або термін її дії минув. Оберіть файл знову.",
  COMMENT_REQUIRED: "Додайте коментар із причиною повернення задачі.",
  INVALID_FILE: "Оберіть MP4, MOV або WebM до 50 MiB.",
  INVALID_INPUT: "Перевірте введені дані.",
  IDEMPOTENCY_CONFLICT: "Повторний запит має інші параметри.",
  INTERNAL_ERROR: "Не вдалося виконати дію. Спробуйте ще раз.",
  RATE_LIMIT: "Забагато повідомлень. Спробуйте пізніше.",
  ORIGIN_MISMATCH: "Недопустиме джерело запиту.",
};
export const commandSchema = z.object({
  action: z.enum([
    "project.create",
    "project.delete",
    "project.restore",
    "member.add",
    "task.create",
    "task.update",
    "task.delete",
    "task.restore",
    "task.status",
    "comment.add",
    "upload.create",
    "upload.complete",
    "upload.cancel",
    "version.copy",
    "version.delete",
    "version.save",
    "render.start",
    "render.retry",
  ]),
  payload: z.record(z.string(), z.unknown()),
});
export function validateCommand(action: string, p: Record<string, unknown>) {
  for (const field of ["task_id", "project_id", "version_id", "asset_id"])
    if (p[field] !== undefined) z.uuid().parse(p[field]);
  if (action === "version.save") {
    timelineSchema.parse(p.timeline);
    z.number().int().positive().parse(p.revision);
  }
  if (action === "project.create")
    z.string().trim().min(1).max(120).parse(p.name);
  if (action === "task.create")
    z.string().trim().min(1).max(160).parse(p.title);
  if (action === "task.create" || action === "task.update") {
    if (p.description !== undefined) z.string().max(10000).parse(p.description);
    for (const field of ["assignee_id", "reviewer_id"])
      if (p[field] !== undefined && p[field] !== null && p[field] !== "")
        z.uuid().parse(p[field]);
  }
  if (action === "task.status") {
    z.enum(["todo", "in_progress", "review", "done"]).parse(p.status);
    if (p.comment !== undefined)
      z.string().trim().min(1).max(5000).parse(p.comment);
  }
  if (action === "render.start") z.number().int().positive().parse(p.revision);
  if (action === "member.add") z.email().parse(p.email);
  if (action === "comment.add")
    z.string().trim().min(1).max(5000).parse(p.body);
  if (action === "upload.create") {
    z.number().int().positive().max(52428800).parse(p.bytes);
    z.enum(["video/mp4", "video/quicktime", "video/webm"]).parse(p.mime);
  }
  if (action.startsWith("render.") || action === "upload.complete")
    z.string().min(8).max(128).parse(p.key);
}
export async function identity() {
  const db = await serverClient();
  const { data, error } = await db.auth.getClaims();
  if (error || !data?.claims?.sub) throw new ApiError("UNAUTHORIZED", 401);
  return {
    db,
    userId: String(data.claims.sub),
    taskId: undefined as string | undefined,
  };
}
export function unwrap<T>({
  data,
  error,
}: {
  data: T;
  error: any;
}): NonNullable<T> {
  if (error) throw new Error(error.message);
  return data as NonNullable<T>;
}
export async function reportError(args: {
  userId?: string;
  taskId?: string;
  stage: string;
  type: string;
  message: string;
  stack?: string;
  critical?: boolean;
  requestId: string;
}) {
  try {
    const { error } = await serviceClient().rpc("log_error", {
      p_task: args.taskId ?? null,
      p_job: null,
      p_user: args.userId ?? null,
      p_stage: args.stage,
      p_type: args.type,
      p_message: redact(args.message),
      p_stack: redact(args.stack ?? ""),
      p_critical: args.critical ?? false,
      p_request: args.requestId,
    });
    if (error) throw error;
  } catch {
    console.error(
      JSON.stringify({
        event: "error_persistence_failed",
        request_id: args.requestId,
        stage: args.stage,
        type: args.type,
      }),
    );
  }
}
export async function handle(
  request: NextRequest,
  fn: (
    ctx: Awaited<ReturnType<typeof identity>>,
    requestId: string,
  ) => Promise<unknown>,
) {
  const requestId = crypto.randomUUID();
  let context: Awaited<ReturnType<typeof identity>> | undefined;
  try {
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== requestOrigin(request))
        throw new ApiError("ORIGIN_MISMATCH", 403);
      if (Number(request.headers.get("content-length") ?? 0) > 100000)
        throw new ApiError("INVALID_INPUT", 413);
    }
    context = await identity();
    const result = await fn(context, requestId);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof z.ZodError || error instanceof SyntaxError
        ? "INVALID_INPUT"
        : (Object.keys(messages).find((c) => raw === c || raw.includes(c)) ??
          "INTERNAL_ERROR");
    const status =
      error instanceof ApiError
        ? error.status
        : code === "UNAUTHORIZED"
          ? 401
          : code === "FORBIDDEN"
            ? 403
            : code === "NOT_FOUND"
              ? 404
              : code.includes("CONFLICT")
                ? 409
                : code === "INTERNAL_ERROR"
                  ? 500
                  : 400;
    await reportError({
      userId: context?.userId,
      taskId: context?.taskId,
      stage: "api",
      type: code,
      message: raw,
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    });
    return NextResponse.json(
      { code, message: messages[code], request_id: requestId },
      { status },
    );
  }
}
