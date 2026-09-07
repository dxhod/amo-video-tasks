import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { serverConnection } from "./connection";
export async function serverClient() {
  const jar = await cookies();
  const connection = serverConnection();
  return createServerClient(
    connection.url,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: { name: connection.cookieName },
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (values) => {
          try {
            values.forEach(({ name, value, options }) =>
              jar.set(name, value, options),
            );
          } catch {
            /* Server Component; proxy refreshes cookies. */
          }
        },
      },
    },
  );
}
