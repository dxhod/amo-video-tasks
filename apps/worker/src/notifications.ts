import { redact, safeMessage } from "@amo/shared";
import { rpc, type ServiceClient } from "./service";
export async function deliverNotification(db: ServiceClient) {
  const n = await rpc<any>(db, "notification_claim");
  if (!n) return false;
  let error: string | null = null;
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN,
      chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) throw new Error("Telegram не налаштований");
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `AMO · Помилка обробки\nЕтап: ${n.stage}\nТип: ${n.type}\nЗадача: ${n.task_id ?? "—"}\nПомилка: ${n.error_id}`,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = (await response.json()) as { ok?: boolean };
    if (!response.ok || !body.ok)
      throw new Error(`Telegram HTTP ${response.status}`);
  } catch (e) {
    error = redact(safeMessage(e));
  }
  await rpc(db, "notification_finish", {
    p_id: n.id,
    p_token: n.token,
    p_error: error,
  });
  return true;
}
