"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  Plus,
  GripVertical,
  Clock,
  ArrowUpRight,
  Users,
  LayoutGrid,
  Settings2,
} from "lucide-react";
import { STATUSES, STATUS_LABELS, type TaskStatus } from "@amo/shared";
import { api, command } from "@/lib/client-api";
import { time } from "@/lib/utils";
import { Button } from "./ui/button";
function Card({
  task,
  profiles,
  duration,
  rendered,
}: {
  task: any;
  profiles: any[];
  duration: number | undefined;
  rendered: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: task.id });
  const owner = profiles.find((p) => p.id === task.assignee_id);
  return (
    <article
      ref={setNodeRef}
      className="panel task-card"
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 1,
      }}
    >
      <div className="row between">
        <span
          className={`pill ${task.status === "review" ? "blue" : task.status === "in_progress" ? "orange" : "gray"}`}
        >
          ВІДЕО · {task.id.slice(0, 4).toUpperCase()}
        </span>
        <button
          aria-label={`Перемістити ${task.title}`}
          className="drag-handle"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} />
        </button>
      </div>
      <Link href={`/tasks/${task.id}`}>
        <h3>{task.title}</h3>
        <p>{task.description || "Відкрийте задачу, щоб почати монтаж."}</p>
      </Link>
      <footer>
        <span
          className="row"
          style={{ gap: 6, fontSize: 10, color: "#87927b" }}
        >
          <Clock size={12} />
          {duration === undefined
            ? "Без відео"
            : `${rendered ? "Монтаж" : "Оригінал"} · ${time(duration)}`}
        </span>
        <span className="avatar" title={owner?.display_name ?? "Не призначено"}>
          {owner?.display_name?.slice(0, 2).toUpperCase() ?? "—"}
        </span>
      </footer>
    </article>
  );
}
function Column({
  status,
  tasks,
  data,
}: {
  status: TaskStatus;
  tasks: any[];
  data: any;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section ref={setNodeRef} className={`column ${isOver ? "over" : ""}`}>
      <div className="column-head">
        <span className={`dot ${status}`} />
        {STATUS_LABELS[status]}
        <span className="count">{tasks.length}</span>
      </div>
      {tasks.map((t) => (
        <Card
          key={t.id}
          task={t}
          profiles={data.profiles}
          rendered={data.renders.some(
            (r: any) => r.version_id === t.current_version_id,
          )}
          duration={
            data.renders.find((r: any) => r.version_id === t.current_version_id)
              ?.duration ??
            data.assets.find((a: any) => a.task_id === t.id)?.duration
          }
        />
      ))}
      {!tasks.length && (
        <div className="empty" style={{ padding: "28px 12px", fontSize: 11 }}>
          Тут поки тихо
        </div>
      )}
    </section>
  );
}
export function Board({ id }: { id: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const cache = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api(`projects/${id}`),
  });
  const [form, setForm] = useState<"task" | "member" | null>(null),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [returnTask, setReturnTask] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(KeyboardSensor),
  );
  const refresh = () => cache.invalidateQueries({ queryKey: ["project", id] });
  async function change(task: string, status: string, comment?: string) {
    setFailure("");
    try {
      await command("task.status", { task_id: task, status, comment });
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  function drop(e: DragEndEvent) {
    if (!e.over || !STATUSES.includes(String(e.over.id) as TaskStatus)) return;
    const t = data.tasks.find((t: any) => t.id === e.active.id);
    if (!t || t.status === e.over.id) return;
    if (t.status === "review" && e.over.id === "in_progress") {
      setReturnTask(t.id);
      return;
    }
    void change(t.id, String(e.over.id));
  }
  if (isLoading) return <div className="loading">Відкриваємо проєкт…</div>;
  if (error || !data)
    return (
      <div className="page error">{error?.message ?? "Проєкт не знайдено"}</div>
    );
  const admin = data.members.some(
    (m: any) => m.user_id === data.user_id && m.role === "admin",
  );
  return (
    <div className="page">
      {deleting && admin && (
        <section
          role="alertdialog"
          aria-label="Видалення проєкту"
          className="panel"
          style={{ marginBottom: 24 }}
        >
          <h3>Видалити «{data.project.name}»?</h3>
          <p>
            Проєкт і всі його задачі зникнуть із робочого простору команди.
            Відео та історія збережуться. Відновлення доступне у списку
            проєктів. Поточна обробка завершиться у фоні.
          </p>
          <div className="row" style={{ marginTop: 16 }}>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailure("");
                try {
                  await command("project.delete", { project_id: id });
                  await cache.invalidateQueries();
                  router.push("/");
                } catch (e) {
                  setFailure((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Підтвердити видалення
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              Скасувати
            </Button>
          </div>
        </section>
      )}
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Проєкт / Відеопродакшн
          </div>
          <h1>{data.project.name}</h1>
          <p>Від першої ідеї до фінального кадру — разом.</p>
        </div>
        {admin && (
          <div className="row">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Видалити проєкт
            </Button>
            <Button
              disabled={busy}
              onClick={() => setForm(form === "task" ? null : "task")}
            >
              <Plus size={16} />
              Нова задача
            </Button>
          </div>
        )}
      </div>
      <div className="board-tools">
        <div className="row">
          <LayoutGrid size={16} />
          <strong style={{ fontSize: 12 }}>Дошка задач</strong>
          <span className="count">{data.tasks.length}</span>
        </div>
        <div className="row">
          <div className="members">
            {data.members.map((m: any) => (
              <span
                key={m.user_id}
                className="avatar"
                title={
                  data.profiles.find((p: any) => p.id === m.user_id)
                    ?.display_name
                }
              >
                {data.profiles
                  .find((p: any) => p.id === m.user_id)
                  ?.display_name?.slice(0, 2)
                  .toUpperCase()}
              </span>
            ))}
          </div>
          {admin && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setForm(form === "member" ? null : "member")}
              >
                <Users size={14} />
                Команда
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/projects/${id}/admin`}>
                  <Settings2 size={14} />
                  Статистика
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
      {failure && (
        <div role="alert" className="error" style={{ marginBottom: 16 }}>
          {failure}
        </div>
      )}
      {form && (
        <form
          className="panel create-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setFailure("");
            const f = new FormData(e.currentTarget);
            try {
              if (form === "member")
                await command("member.add", {
                  project_id: id,
                  email: f.get("email"),
                });
              else
                await command("task.create", {
                  project_id: id,
                  title: f.get("title"),
                  description: f.get("description"),
                  assignee_id: f.get("assignee_id"),
                  reviewer_id: f.get("reviewer_id"),
                });
              setForm(null);
              await refresh();
            } catch (e) {
              setFailure((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {form === "member" ? (
            <label>
              Email зареєстрованого користувача
              <input
                name="email"
                type="email"
                required
                placeholder="colleague@company.com"
              />
            </label>
          ) : (
            <>
              <label>
                Назва задачі
                <input
                  name="title"
                  required
                  maxLength={160}
                  placeholder="Коротка історія, велика ідея"
                />
              </label>
              <label>
                Опис
                <textarea name="description" maxLength={10000} />
              </label>
              <div className="row" style={{ alignItems: "end" }}>
                {["assignee_id", "reviewer_id"].map((name, i) => (
                  <label key={name} className="grow">
                    {i ? "Рев’юер" : "Виконавець"}
                    <select name={name} required defaultValue={data.user_id}>
                      {data.members.map((m: any) => (
                        <option key={m.user_id} value={m.user_id}>
                          {data.profiles.find((p: any) => p.id === m.user_id)
                            ?.display_name ?? m.user_id}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="row">
            <Button disabled={busy}>
              {form === "member" ? "Додати учасника" : "Створити задачу"}
              <ArrowUpRight size={14} />
            </Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>
              Скасувати
            </Button>
          </div>
        </form>
      )}
      {returnTask && (
        <form
          className="panel create-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const comment = String(
              new FormData(e.currentTarget).get("comment"),
            );
            await change(returnTask, "in_progress", comment);
            setReturnTask(null);
          }}
        >
          <label>
            Що потрібно доопрацювати?
            <textarea name="comment" required />
          </label>
          <Button>Повернути в роботу</Button>
        </form>
      )}
      <DndContext sensors={sensors} onDragEnd={drop}>
        <div className="board">
          {STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={data.tasks.filter((t: any) => t.status === status)}
              data={data}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
