export class ClientError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new ClientError(
      data.message ?? "Помилка мережі",
      data.code ?? "NETWORK",
    );
  return data;
}
export const command = (action: string, payload: Record<string, unknown>) =>
  api("commands", { action, payload });
