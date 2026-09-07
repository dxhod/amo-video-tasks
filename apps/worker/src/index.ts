import "dotenv/config";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { redact, safeMessage, type Job } from "@amo/shared";
import { serviceClient, rpc } from "./service";
import { processJob } from "./process-job";
import { deliverNotification } from "./notifications";
const db = serviceClient(),
  worker = `${hostname()}-${randomUUID()}`;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function notifications() {
  while (!stopping) {
    try {
      await deliverNotification(db);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "notification_loop_error",
          message: redact(safeMessage(e)),
        }),
      );
    }
    await delay(1000);
  }
}
async function heartbeat() {
  while (!stopping) {
    await db
      .from("worker_heartbeats")
      .upsert({ id: worker, updated_at: new Date().toISOString() });
    await delay(20000);
  }
}
async function main() {
  console.log(JSON.stringify({ event: "worker_started", worker }));
  const side = [notifications(), heartbeat()];
  while (!stopping) {
    try {
      const job = await rpc<Job | null>(db, "worker_claim", {
        p_worker: worker,
      });
      if (job) await processJob(db, job);
      else await delay(1000);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "worker_loop_error",
          message: redact(safeMessage(e)),
        }),
      );
      await delay(3000);
    }
  }
  await Promise.all(side);
}
await main();
