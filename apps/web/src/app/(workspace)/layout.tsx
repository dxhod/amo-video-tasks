import { redirect } from "next/navigation";
import { serverClient } from "@/lib/supabase/server";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
    return (
      <div className="page">
        <div className="panel">
          <h1>Налаштування простору</h1>
          <p>
            Додайте параметри Supabase до apps/web/.env.local згідно з README та
            перезапустіть застосунок.
          </p>
        </div>
      </div>
    );
  const db = await serverClient();
  const { data } = await db.auth.getClaims();
  if (!data?.claims) redirect("/login");
  return <Shell>{children}</Shell>;
}
