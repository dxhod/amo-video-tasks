import type { NextRequest } from "next/server";

export function requestOrigin(request: NextRequest) {
  const configured = new URL(process.env.NEXT_PUBLIC_APP_URL ?? request.url);
  const local = (hostname: string) =>
    ["localhost", "127.0.0.1"].includes(hostname);
  // Next's internal request URL can use localhost even when the browser uses 127.0.0.1.
  if (local(configured.hostname)) {
    const requested = new URL(
      `http://${request.headers.get("host") ?? configured.host}`,
    );
    if (local(requested.hostname)) return requested.origin;
  }
  return configured.origin;
}
