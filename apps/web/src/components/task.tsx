"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload as TusUpload } from "tus-js-client";
import {
  ArrowLeft,
  Upload,
  Plus,
  Lock,
  Download,
  Check,
  MessageSquare,
  RotateCcw,
  Film,
  Trash2,
} from "lucide-react";
import { MAX_BYTES, STATUS_LABELS, type TaskStatus } from "@amo/shared";
import { api, command } from "@/lib/client-api";
import { browserClient } from "@/lib/supabase/browser";
import { time } from "@/lib/utils";
import { Button } from "./ui/button";
import { Editor } from "./editor";
const stages: Record<string, string> = {
  queued: "Очікує обробки",
  download: "Завантажуємо файл",
  normalize: "Готуємо відео",
  scene_detection: "Визначаємо сцени",
  thumbnails: "Створюємо мініатюри",
  render: "Рендеримо монтаж",
  upload: "Зберігаємо результат",
  complete: "Готово",
  failed: "Обробку зупинено",
};
function UploadZone({
  taskId,
  existing,
  onComplete,
}: {
  taskId: string;
  existing: any;
  onComplete: () => void;
}) {
  const [progress, setProgress] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef<TusUpload | null>(null);
  useEffect(
    () => () => {
      void active.current?.abort();
    },
    [],
  );
  async function upload(file: File) {
    setError("");
    if (file.size > MAX_BYTES || file.size === 0) {
      setError("Оберіть файл до 50 MiB.");
      return;
    }
    const mime =
      file.type ||
      (/\.mov$/i.test(file.name)
        ? "video/quicktime"
        : /\.webm$/i.test(file.name)
          ? "video/webm"
          : "video/mp4");
    if (
      !/\.(mp4|mov|webm)$/i.test(file.name) ||
      !["video/mp4", "video/quicktime", "video/webm"].includes(mime)
    ) {
      setError("Підтримуються MP4, MOV і WebM.");
      return;
    }
    setBusy(true);
    try {
      const asset =
        existing?.status === "uploading" &&
        new Date(existing.expires_at).getTime() > Date.now()
          ? existing
          : await command("upload.create", {
              task_id: taskId,
              bytes: file.size,
              mime,
            });
      if (asset.bytes !== file.size)
        throw new Error("Для відновлення оберіть той самий файл.");
      const db = browserClient();
      const { data } = await db.auth.getSession();
      if (!data.session) throw new Error("Увійдіть повторно.");
      await new Promise<void>((resolve, reject) => {
        const tus = new TusUpload(file, {
          endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
          retryDelays: [0, 1000, 3000, 5000],
          chunkSize: 6 * 1024 * 1024,
          headers: {
            authorization: `Bearer ${data.session!.access_token}`,
            "x-upsert": "false",
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          metadata: {
            bucketName: "sources",
            objectName: asset.source_path,
            contentType: mime,
            cacheControl: "3600",
          },
          fingerprint: async () =>
            `amo:${asset.id}:${file.name}:${file.size}:${file.lastModified}`,
          onError: reject,
          onProgress: (sent, total) =>
            setProgress(Math.round((sent / total) * 100)),
          onSuccess: () => resolve(),
        });
        active.current = tus;
        void tus
          .findPreviousUploads()
          .then((previous) => {
            if (previous.length) tus.resumeFromPreviousUpload(previous[0]);
            tus.start();
          })
          .catch(reject);
      });
      await command("upload.complete", {
        asset_id: asset.id,
        key: `upload:${asset.id}`,
      });
      onComplete();
    } catch (e) {
      setError((e as Error).message);
      await api("upload-errors", {
        task_id: taskId,
        message: (e as Error).message.slice(0, 2000),
      }).catch(() => {});
      onComplete();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="upload-zone">
      <Upload size={30} style={{ margin: "0 auto", color: "#819369" }} />
      <h2 style={{ marginTop: 14 }}>Додайте перший кадр історії</h2>
      <p>MP4, MOV або WebM · до 30 секунд · до 50 MiB · до 4K</p>
      <input
        type="file"
        aria-label="Завантажити відео"
        accept=".mp4,.mov,.webm"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {existing?.status === "uploading" && (
        <div
          className="row"
          style={{ justifyContent: "center", marginTop: 12 }}
        >
          <small>
            Завантаження не завершено: оберіть той самий файл або перевірте його
            наявність.
          </small>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              try {
                await command("upload.complete", {
                  asset_id: existing.id,
                  key: `upload:${existing.id}`,
                });
                onComplete();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Перевірити
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              try {
                await command("upload.cancel", { asset_id: existing.id });
                setError("");
                onComplete();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Обрати інший файл
          </Button>
        </div>
      )}
      {busy && (
        <>
          <div className="progress">
            <div style={{ width: `${progress}%` }} />
          </div>
          <small>Завантажено {progress}%</small>
        </>
      )}
      {error && (
        <div role="alert" className="error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
export function Task({ id }: { id: string }) {
  const router = useRouter();
  const cache = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["task", id],
    queryFn: () => api(`tasks/${id}`),
    refetchInterval: (q) =>
      q.state.data?.jobs?.some((j: any) =>
        ["queued", "running"].includes(j.status),
      )
        ? 2000
        : false,
  });
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [returning, setReturning] = useState(false),
    [deleting, setDeleting] = useState(false),
    [editorKey, setEditorKey] = useState(0);
  const flushRef = useRef<(() => Promise<string>) | null>(null);
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["task", id] });
    await cache.invalidateQueries({ queryKey: ["project"] });
  };
  async function act(action: string, payload: Record<string, unknown>) {
    setFailure("");
    setBusy(true);
    try {
      if (action === "task.status") await flushRef.current?.();
      const result = await command(action, payload);
      await refresh();
      return result;
    } catch (e) {
      setFailure((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  if (isLoading)
    return <div className="loading">Готуємо монтажний простір…</div>;
  if (error || !data)
    return (
      <div className="page error">{error?.message ?? "Задачу не знайдено"}</div>
    );
  const t = data.task,
    admin = data.members.some(
      (m: any) => m.user_id === data.user_id && m.role === "admin",
    ),
    canWork =
      (admin || t.assignee_id === data.user_id) &&
      ["todo", "in_progress"].includes(t.status),
    editable = canWork && t.status === "in_progress",
    reviewer = admin || t.reviewer_id === data.user_id;
  const version =
      data.versions.find(
        (v: any) => v.id === (selectedVersion ?? t.current_version_id),
      ) ?? data.versions.at(-1),
    asset =
      data.assets.find((a: any) => a.id === version?.asset_id) ??
      data.assets.find((a: any) => a.status !== "failed") ??
      data.assets[0];
  const activeJob = data.jobs.findLast((j: any) =>
      ["queued", "running"].includes(j.status),
    ),
    job = data.jobs.find(
      (j: any) =>
        j.version_id === version?.id &&
        j.version_revision === version?.revision,
    ),
    versionBusy = data.jobs.some(
      (j: any) =>
        j.version_id === version?.id &&
        ["queued", "running"].includes(j.status),
    ),
    render = data.renders.find(
      (r: any) =>
        r.version_id === version?.id &&
        r.version_revision === version?.revision,
    ),
    history = data.renders
      .filter(
        (r: any) =>
          r.version_id === version?.id &&
          r.version_revision !== version?.revision,
      )
      .sort((a: any, b: any) => b.version_revision - a.version_revision),
    name = (uid: string) =>
      data.profiles.find((p: any) => p.id === uid)?.display_name ??
      "Не призначено";
  return (
    <div className="page">
      {deleting && admin && (
        <section
          role="alertdialog"
          aria-label="Видалення задачі"
          className="panel"
          style={{ marginBottom: 24 }}
        >
          <h3>Видалити «{t.title}»?</h3>
          <p>
            Задача зникне з дошки та статистики. Відео, версії й історія
            збережуться. Відновлення доступне у статистиці проєкту.
          </p>
          {activeJob && (
            <p>
              Поточна обробка завершиться у фоні; її результат збережеться для
              відновлення.
            </p>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFailure("");
                try {
                  await flushRef.current?.();
                  await command("task.delete", { task_id: id });
                  await cache.invalidateQueries({
                    queryKey: ["project", t.project_id],
                  });
                  await cache.invalidateQueries({
                    queryKey: ["admin", t.project_id],
                  });
                  router.push(`/projects/${t.project_id}`);
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
      <Link
        href={`/projects/${t.project_id}`}
        className="row muted"
        style={{ fontSize: 11, marginBottom: 20 }}
      >
        <ArrowLeft size={13} />
        До дошки проєкту
      </Link>
      <div className="page-head">
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="eyebrow">
              ВІДЕО / {t.id.slice(0, 8).toUpperCase()}
            </span>
            <span
              className={`pill ${t.status === "review" ? "blue" : t.status === "in_progress" ? "orange" : ""}`}
            >
              {STATUS_LABELS[t.status as TaskStatus]}
            </span>
          </div>
          <h1>{t.title}</h1>
          <p>{t.description || "Ваша наступна історія починається тут."}</p>
        </div>
        <div className="row wrap">
          {admin && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Видалити задачу
            </Button>
          )}
          {t.status === "review" && reviewer && (
            <>
              <Button
                variant="secondary"
                onClick={() => setReturning(!returning)}
                disabled={busy}
              >
                <RotateCcw size={14} />
                Доопрацювати
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act("task.status", {
                    task_id: id,
                    status: "done",
                  }).catch(() => {})
                }
              >
                <Check size={15} />
                Прийняти
              </Button>
            </>
          )}
          {t.status === "done" && admin && (
            <Button
              variant="secondary"
              onClick={() =>
                void act("task.status", {
                  task_id: id,
                  status: "in_progress",
                }).catch(() => {})
              }
            >
              Повернути в роботу
            </Button>
          )}
          {t.status === "in_progress" &&
            editable &&
            data.renders.some(
              (r: any) =>
                r.version_id === t.current_version_id &&
                r.version_revision ===
                  data.versions.find((v: any) => v.id === t.current_version_id)
                    ?.revision,
            ) && (
              <Button
                disabled={busy || !!activeJob}
                onClick={() =>
                  void act("task.status", {
                    task_id: id,
                    status: "review",
                  }).catch(() => {})
                }
              >
                Передати на перевірку
              </Button>
            )}
        </div>
      </div>
      {failure && (
        <div role="alert" className="error" style={{ marginBottom: 16 }}>
          {failure}
        </div>
      )}
      {returning && (
        <form
          className="panel create-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await act("task.status", {
                task_id: id,
                status: "in_progress",
                comment: new FormData(e.currentTarget).get("comment"),
              });
              setReturning(false);
            } catch {
              /* act displays the error */
            }
          }}
        >
          <label>
            Що потрібно змінити?
            <textarea name="comment" required maxLength={5000} />
          </label>
          <Button disabled={busy}>Повернути з коментарем</Button>
        </form>
      )}
      {activeJob && (
        <div className="notice" role="status" style={{ marginBottom: 20 }}>
          <div className="row between">
            <span>{stages[activeJob.stage] ?? activeJob.stage}</span>
            <span>
              {activeJob.progress}% · спроба {activeJob.attempt || 1}
            </span>
          </div>
          <div className="progress">
            <div style={{ width: `${activeJob.progress}%` }} />
          </div>
          <small>Можна закрити сторінку — обробка продовжиться.</small>
        </div>
      )}
      {!version &&
        (!asset || ["uploading", "failed"].includes(asset.status)) &&
        canWork && (
          <UploadZone
            taskId={id}
            existing={asset}
            onComplete={() => void refresh()}
          />
        )}
      {!version && !canWork && !activeJob && (
        <div className="empty">
          <Film size={30} />
          <p>Виконавець ще не підготував відео.</p>
        </div>
      )}
      {asset?.status === "failed" && (
        <div className="error" style={{ marginTop: 16 }}>
          Не вдалося проаналізувати відео. Перевірте формат і тривалість та
          завантажте його повторно.
        </div>
      )}
      {version && asset && (
        <div className="editor-layout">
          <Editor
            flushRef={flushRef}
            key={`${version.id}:${editorKey}`}
            version={version}
            asset={asset}
            scenes={data.scenes}
            urls={data.urls}
            editable={editable && !versionBusy}
            onSaved={(versionId) => {
              setSelectedVersion(versionId);
              void refresh();
            }}
            onRefresh={() => {
              void refresh().then(() => setEditorKey((k) => k + 1));
            }}
            onRender={async (revision, versionId) => {
              await act("render.start", {
                version_id: versionId,
                revision,
                key: `render:${versionId}:${revision}`,
              });
            }}
          />
          <aside className="editor-side">
            <section className="panel">
              <div className="row between">
                <h3>Версії монтажу</h3>
                <span className="count">{data.versions.length}</span>
              </div>
              <small>Кожна версія — окрема історія.</small>
              {data.versions.map((v: any) => (
                <div key={v.id} className="version-row group relative">
                  <button
                    className={`version-button ${v.id === version.id ? "active" : ""}`}
                    onClick={async () => {
                      try {
                        await flushRef.current?.();
                        setSelectedVersion(v.id);
                      } catch (e) {
                        setFailure((e as Error).message);
                      }
                    }}
                  >
                    <span>
                      <strong>
                        {v.number === 0 ? "Оригінал" : `v${v.number}`}
                      </strong>{" "}
                      {v.id === t.current_version_id && (
                        <small>· актуальна</small>
                      )}
                    </span>
                    {!editable ||
                    data.jobs.some(
                      (j: any) =>
                        j.version_id === v.id &&
                        ["queued", "running"].includes(j.status),
                    ) ? (
                      <Lock size={12} />
                    ) : (
                      <small>Редагування</small>
                    )}
                  </button>
                  {editable && v.number !== 0 && (
                    <button
                      className="absolute right-2 top-2 rounded bg-white p-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 max-md:opacity-100"
                      aria-label={`Видалити версію v${v.number}`}
                      title={`Видалити версію v${v.number}`}
                      disabled={
                        busy ||
                        data.jobs.some(
                          (j: any) =>
                            j.version_id === v.id &&
                            ["queued", "running"].includes(j.status),
                        )
                      }
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `Видалити версію v${v.number}? Вихідне відео та інші версії збережуться.`,
                          )
                        )
                          return;
                        try {
                          await flushRef.current?.();
                          const result = await act("version.delete", {
                            version_id: v.id,
                          });
                          if (version.id === v.id)
                            setSelectedVersion(result.selected_version_id);
                          setEditorKey((k) => k + 1);
                        } catch (e) {
                          setFailure((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {editable && (
                <Button
                  style={{ width: "100%", marginTop: 12 }}
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const savedId = await flushRef.current?.();
                      const v = await act("version.copy", {
                        version_id: savedId ?? version.id,
                      });
                      setSelectedVersion(v.id);
                    } catch (e) {
                      setFailure((e as Error).message);
                    }
                  }}
                >
                  <Plus size={14} />
                  Нова версія з цієї
                </Button>
              )}
            </section>
            <section className="panel">
              <h3>Результат v{version.number}</h3>
              {render ? (
                <>
                  <div className="version-result">
                    <Check size={12} style={{ display: "inline" }} /> Готово ·{" "}
                    {time(render.duration)}
                  </div>
                  <video
                    controls
                    playsInline
                    style={{
                      width: "100%",
                      borderRadius: 6,
                      background: "#222920",
                    }}
                    src={data.urls[render.path]}
                  />
                  <Button
                    asChild
                    variant="secondary"
                    size="sm"
                    style={{ width: "100%", marginTop: 12 }}
                  >
                    <a
                      href={data.urls[render.path]}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={13} />
                      Відкрити MP4
                    </a>
                  </Button>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  {job?.status === "failed"
                    ? "Рендер не завершено. Можна повторити."
                    : job
                      ? "Версія обробляється."
                      : "Результат з’явиться після рендера."}
                </p>
              )}
              {job?.status === "failed" && editable && (
                <Button
                  size="sm"
                  style={{ marginTop: 12 }}
                  disabled={busy}
                  onClick={() =>
                    void act("render.retry", {
                      version_id: version.id,
                      key: crypto.randomUUID(),
                    }).catch(() => {})
                  }
                >
                  <RotateCcw size={13} />
                  Повторити рендер
                </Button>
              )}
            </section>
            {!!history.length && (
              <section className="panel">
                <h3>Попередні рендери v{version.number}</h3>
                {!render && (
                  <p role="status">
                    Монтаж змінено. Попередній результат застарів — потрібен
                    новий рендер.
                  </p>
                )}
                {history.map((r: any) => (
                  <div key={r.id} style={{ marginTop: 12 }}>
                    <small>
                      Ревізія {r.version_revision} · {time(r.duration)}
                    </small>
                    <video
                      controls
                      playsInline
                      src={data.urls[r.path]}
                      style={{ width: "100%", borderRadius: 6 }}
                    />
                    <a
                      href={data.urls[r.path]}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Відкрити попередній MP4 · ревізія {r.version_revision}
                    </a>
                  </div>
                ))}
              </section>
            )}
            <section className="panel">
              <div className="eyebrow">Вихідне відео</div>
              <p style={{ marginTop: 8 }}>
                {time(asset.duration ?? 0)} · 30 fps
              </p>
              <small>
                {asset.has_audio ? "З оригінальним звуком" : "Без аудіодоріжки"}
              </small>
            </section>
          </aside>
        </div>
      )}
      <div className="detail-grid">
        <section className="panel">
          <div className="row">
            <MessageSquare size={17} />
            <h3>Обговорення</h3>
            <span className="count">{data.comments.length}</span>
          </div>
          {data.comments.map((c: any) => (
            <article className="comment" key={c.id}>
              <strong style={{ fontSize: 12 }}>{name(c.user_id)}</strong>
              <p>{c.body}</p>
              <small>{new Date(c.created_at).toLocaleString("uk-UA")}</small>
            </article>
          ))}
          {!data.comments.length && (
            <p className="muted" style={{ padding: "24px 0", fontSize: 12 }}>
              Залиште перший коментар для команди.
            </p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              try {
                await act("comment.add", {
                  task_id: id,
                  body: new FormData(form).get("body"),
                });
                form.reset();
              } catch {
                /* act displays the error */
              }
            }}
          >
            <label>
              Ваш коментар
              <textarea
                name="body"
                required
                maxLength={5000}
                placeholder="Що варто знати команді?"
              />
            </label>
            <Button disabled={busy} size="sm" style={{ marginTop: 12 }}>
              Додати коментар
            </Button>
          </form>
        </section>
        <section className="panel">
          <h3>Деталі задачі</h3>
          <div className="stack" style={{ marginTop: 18, gap: 12 }}>
            <div className="row between">
              <small>Виконавець</small>
              <span>{name(t.assignee_id)}</span>
            </div>
            <div className="row between">
              <small>Рев’юер</small>
              <span>{name(t.reviewer_id)}</span>
            </div>
            <div className="row between">
              <small>Створено</small>
              <span>{new Date(t.created_at).toLocaleDateString("uk-UA")}</span>
            </div>
          </div>
          {admin && (
            <details style={{ marginTop: 18 }}>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>
                Редагувати задачу
              </summary>
              <form
                className="stack"
                style={{ marginTop: 12, gap: 8 }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  await act("task.update", {
                    task_id: id,
                    title: f.get("title"),
                    description: f.get("description"),
                    assignee_id: f.get("assignee_id"),
                    reviewer_id: f.get("reviewer_id"),
                  }).catch(() => {});
                }}
              >
                <label>
                  Назва
                  <input
                    name="title"
                    defaultValue={t.title}
                    required
                    maxLength={160}
                  />
                </label>
                <label>
                  Опис
                  <textarea
                    name="description"
                    defaultValue={t.description}
                    maxLength={10000}
                  />
                </label>
                {["assignee_id", "reviewer_id"].map((field, i) => (
                  <label key={field}>
                    {i ? "Рев’юер" : "Виконавець"}
                    <select name={field} defaultValue={t[field] ?? ""}>
                      <option value="">Не призначено</option>
                      {data.members.map((m: any) => (
                        <option key={m.user_id} value={m.user_id}>
                          {name(m.user_id)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <Button size="sm" disabled={busy}>
                  Зберегти деталі
                </Button>
              </form>
            </details>
          )}
          <div className="divider" />
          <h3>Історія</h3>
          {data.events.map((event: any) => (
            <div key={event.id} style={{ paddingTop: 12, fontSize: 11 }}>
              <span className="muted">
                {new Date(event.created_at).toLocaleString("uk-UA")}
              </span>
              <p>
                {event.from_status
                  ? STATUS_LABELS[event.from_status as TaskStatus]
                  : "Створено"}{" "}
                → {STATUS_LABELS[event.to_status as TaskStatus]}
                {event.event_type === "deleted" && " · Задачу видалено"}
                {event.event_type === "restored" && " · Задачу відновлено"}
              </p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
