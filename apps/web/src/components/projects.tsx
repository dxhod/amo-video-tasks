"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Folder, ArrowUpRight, Film } from "lucide-react";
import { api, command } from "@/lib/client-api";
import { Button } from "./ui/button";
export function Projects() {
  const { data, error, isLoading } = useQuery({
      queryKey: ["projects"],
      queryFn: () => api("projects"),
    }),
    cache = useQueryClient(),
    router = useRouter();
  const [creating, setCreating] = useState(false),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Менше хаосу. Більше творчості.
          </div>
          <h1>Ваші проєкти</h1>
          <p>Кожна історія починається з одного простору.</p>
        </div>
        <Button onClick={() => setCreating(!creating)}>
          <Plus size={16} />
          Новий проєкт
        </Button>
      </div>
      {creating && (
        <form
          className="panel create-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const f = new FormData(e.currentTarget);
              const p = await command("project.create", {
                name: f.get("name"),
              });
              await cache.invalidateQueries({ queryKey: ["projects"] });
              router.push(`/projects/${p.id}`);
            } catch (e) {
              setFailure((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Назва проєкту
            <input
              name="name"
              placeholder="Наприклад, осіння кампанія"
              required
              maxLength={120}
            />
          </label>
          <div className="row">
            <Button disabled={busy}>Створити простір</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCreating(false)}
            >
              Скасувати
            </Button>
          </div>
        </form>
      )}
      {(failure || error) && (
        <div role="alert" className="error">
          {failure || error?.message}
        </div>
      )}
      {isLoading ? (
        <div className="loading">Завантажуємо простір…</div>
      ) : (
        <div className="project-grid">
          {data?.projects?.map((p: any) => (
            <Link
              className="panel project-card"
              key={p.id}
              href={`/projects/${p.id}`}
            >
              <div className="row between">
                <span className="project-icon">
                  <Folder size={22} />
                </span>
                <ArrowUpRight size={18} color="#909b85" />
              </div>
              <h2>{p.name}</h2>
              <footer>
                <span>Відеопродакшн</span>
                <span>
                  {new Date(p.created_at).toLocaleDateString("uk-UA")}
                </span>
              </footer>
            </Link>
          ))}
        </div>
      )}
      {!isLoading && !data?.projects?.length && (
        <div className="empty">
          <Film size={32} />
          <h3>Місце для вашої першої історії</h3>
          <p>Створіть проєкт та запросіть команду.</p>
        </div>
      )}
      {!!data?.deleted_projects?.length && (
        <section className="panel" style={{ marginTop: 24 }}>
          <h3>Видалені проєкти</h3>
          <p>
            Відновлення поверне проєкт разом із задачами, відео та історією.
          </p>
          {data.deleted_projects.map((p: any) => (
            <div className="row between" key={p.id} style={{ marginTop: 12 }}>
              <span>{p.name}</span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setFailure("");
                  try {
                    await command("project.restore", { project_id: p.id });
                    await cache.invalidateQueries();
                  } catch (e) {
                    setFailure((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Відновити проєкт
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
