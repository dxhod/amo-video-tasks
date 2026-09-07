import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { serviceClient, rpc } from "../../apps/worker/src/service";
export function localDb() {
  const url = process.env.SUPABASE_URL;
  if (
    process.env.ALLOW_LOCAL_TESTS !== "true" ||
    !url ||
    !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
  )
    throw new Error("Tests require ALLOW_LOCAL_TESTS=true and local Supabase");
  return serviceClient();
}
export async function testUser(label: string) {
  const admin = localDb();
  const email = `test-${randomUUID()}@amo.test`,
    password = `Amo-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: label },
  });
  if (error) throw error;
  const db = createClient(
    process.env.SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const login = await db.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { db, id: data.user.id, email, password };
}
export async function cmd(db: any, action: string, p: Record<string, unknown>) {
  return rpc(db, "amo_command", { p_action: action, p });
}
