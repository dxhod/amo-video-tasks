"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Activity } from "lucide-react";
import { api, command } from "@/lib/client-api";
import { Button } from "./ui/button";
import { STATUS_LABELS, type TaskStatus } from "@amo/shared";
export function Admin({ id }: { id: string }) {
  const cache = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [stage, setStage] = useState(""),
    [type, setType] = useState(""),
    [task, setTask] = useState(""),
    [date, setDate] = useState("");
  const params = new URLSearchParams();
  if (stage) params.set("stage", stage);
  if (type) params.set("type", type);
  if (task) params.set("task_id", task);
  if (date) params.set("after", new Date(date).toISOString());
  const { data, error, isLoading } = useQuery({
    queryKey: ["admin", id, stage, type, task, date],
    queryFn: () => api(`admin/${id}?${params}`),
  });
  const total = data
    ? Object.values(data.completed).reduce(
        (s: number, n: any) => s + Number(n),
        0,
      )
    : 0;
  return (
    <div className="page">
      <Link
        href={`/projects/${id}`}
        className="row muted"
        style={{ fontSize: 11, marginBottom: 24 }}
      >
        <ArrowLeft size={13} />
        До проєкту
      </Link>
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Прозорість процесу
          </div>
          <h1>Пульс проєкту</h1>
          <p>
            Результати команди, час обробки та сигнали, що потребують уваги.
          </p>
        </div>
        <Activity size={28} color="#85996c" />
      </div>
      {error && (
        <div role="alert" className="error">
          {error.message}
        </div>
      )}
      {isLoading ? (
        <div className="loading">Збираємо статистику…</div>
      ) : (
        data && (
          <>
            <div className="metrics">
              <div className="panel">
                <div className="eyebrow">Готові задачі</div>
                <div className="metric-value">{total}</div>
                <small>Поточний статус «Готово»</small>
              </div>
              <div className="panel">
                <div className="eyebrow">Середній рендер</div>
                <div className="metric-value">
                  {data.average_render_ms === null
                    ? "—"
                    : `${(data.average_render_ms / 1000).toFixed(1)} с`}
                </div>
                <small>Без очікування в черзі</small>
              </div>
              <div className="panel">
                <div className="eyebrow">Worker</div>
                <div className="metric-value" style={{ fontSize: 22 }}>
                  {data.worker_seen_at &&
                  Date.now() - new Date(data.worker_seen_at).getTime() < 60000
                    ? "На зв’язку"
                    : "Немає сигналу"}
                </div>
                <small>
                  {data.worker_seen_at
                    ? new Date(data.worker_seen_at).toLocaleString("uk-UA")
                    : "Ще не запускався"}
                </small>
              </div>
            </div>
            <section className="panel" style={{ marginBottom: 24 }}>
              <h3>Завершено за виконавцем</h3>
              <table>
                <thead>
                  <tr>
                    <th>Виконавець</th>
                    <th>Задачі</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.completed).map(([uid, count]) => (
                    <tr key={uid}>
                      <td>
                        {data.profiles.find((p: any) => p.id === uid)
                          ?.display_name ?? "Не призначено"}
                      </td>
                      <td>{String(count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!total && (
                <p className="muted" style={{ marginTop: 16 }}>
                  Статистика з’явиться після прийняття першої задачі.
                </p>
              )}
            </section>
          </>
        )
      )}
      {data && (
        <section className="panel" style={{ marginBottom: 24 }}>
          <h3>Видалені задачі</h3>
          <p className="muted">
            Відео та історія збережені. Відновлена задача повернеться на дошку з
            її поточним статусом.
          </p>
          {failure && (
            <p role="alert" className="error">
              {failure}
            </p>
          )}
          {!data.deleted_tasks?.length ? (
            <p style={{ marginTop: 16 }}>Видалених задач немає.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Задача</th>
                    <th>Статус</th>
                    <th>Видалено</th>
                    <th>Дія</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deleted_tasks.map((t: any) => (
                    <tr key={t.id}>
                      <td>{t.title}</td>
                      <td>{STATUS_LABELS[t.status as TaskStatus]}</td>
                      <td>{new Date(t.deleted_at).toLocaleString("uk-UA")}</td>
                      <td>
                        <Button
                          size="sm"
                          disabled={restoring !== null}
                          aria-label={`Відновити ${t.title}`}
                          onClick={async () => {
                            setRestoring(t.id);
                            setFailure("");
                            try {
                              await command("task.restore", { task_id: t.id });
                              await cache.invalidateQueries({
                                queryKey: ["admin", id],
                              });
                              await cache.invalidateQueries({
                                queryKey: ["project", id],
                              });
                              await cache.invalidateQueries({
                                queryKey: ["task", t.id],
                              });
                            } catch (e) {
                              setFailure((e as Error).message);
                            } finally {
                              setRestoring(null);
                            }
                          }}
                        >
                          {restoring === t.id ? "Відновлюємо…" : "Відновити"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <section className="panel">
        <h3>Журнал помилок</h3>
        <div className="row wrap" style={{ margin: "18px 0" }}>
          <label className="grow">
            Етап
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">Усі етапи</option>
              {[
                "api",
                "upload",
                "download",
                "normalize",
                "scene_detection",
                "thumbnails",
                "render",
                "worker",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="grow" style={{ marginTop: 0 }}>
            Тип
            <input
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="Наприклад, INVALID_MEDIA"
            />
          </label>
          <label className="grow" style={{ marginTop: 0 }}>
            ID задачі
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="UUID"
            />
          </label>
          <label style={{ marginTop: 0 }}>
            Починаючи з
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Час</th>
                <th>Етап / тип</th>
                <th>Повідомлення</th>
                <th>Деталі</th>
              </tr>
            </thead>
            <tbody>
              {data?.errors.map((e: any) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {new Date(e.created_at).toLocaleString("uk-UA")}
                  </td>
                  <td>
                    <span className={`pill ${e.critical ? "orange" : "gray"}`}>
                      {e.stage}
                    </span>
                    <p style={{ marginTop: 6 }}>{e.type}</p>
                  </td>
                  <td>{e.message}</td>
                  <td>
                    <details>
                      <summary>Stack trace</summary>
                      <pre>
                        {e.stack_trace || "Немає stack trace"}
                        {`\nTask: ${e.task_id}\nRequest: ${e.request_id}`}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.errors.length && (
            <div className="empty" style={{ marginTop: 12 }}>
              Помилок за цими фільтрами немає.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
