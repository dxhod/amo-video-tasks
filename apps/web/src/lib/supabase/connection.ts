export function serverConnection() {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return {
    url: process.env.SUPABASE_URL ?? publicUrl,
    // Keep the browser's default cookie namespace when Docker uses an internal URL.
    cookieName: `sb-${new URL(publicUrl).hostname.split(".")[0]}-auth-token`,
  };
}
