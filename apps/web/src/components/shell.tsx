"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Film,
  LayoutGrid,
  ArrowUpRight,
  LogOut,
  Folder,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/client-api";
import { browserClient } from "@/lib/supabase/browser";
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(),
    router = useRouter();
  const { data } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api("projects"),
  });
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-icon">
            <Film size={21} />
          </span>
          amo
          <span style={{ fontSize: 10, letterSpacing: 1, color: "#92a283" }}>
            {" "}
            / studio
          </span>
        </Link>
        <p className="eyebrow">Робочий простір</p>
        <Link
          href="/"
          className={`nav-link ${pathname === "/" ? "active" : ""}`}
        >
          <LayoutGrid size={16} />
          Усі проєкти
        </Link>
        <div className="divider" style={{ background: "#3c4437" }} />
        <p className="eyebrow">Мої проєкти</p>
        {data?.projects?.slice(0, 8).map((p: any) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className={`nav-link nav-project ${pathname.includes(p.id) ? "active" : ""}`}
          >
            <Folder size={15} />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.name}
            </span>
          </Link>
        ))}
        <div className="sidebar-bottom">
          <p>
            Від першого кадру
            <br />
            до фінального «готово».
          </p>
          <div className="row" style={{ marginTop: 14, color: "#94a283" }}>
            AMO VIDEO TASKS <ArrowUpRight size={13} />
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="row">
            <span>Робочий простір</span>
            <ChevronRight size={12} />
            <strong>Відеопродакшн</strong>
          </div>
          <div className="row">
            <span className="hint">Створюйте. Монтуйте. Обговорюйте.</span>
            <button
              className="btn btn-ghost btn-icon"
              title="Вийти"
              aria-label="Вийти"
              onClick={async () => {
                await browserClient().auth.signOut();
                router.push("/login");
                router.refresh();
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
