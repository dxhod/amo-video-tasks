import "dotenv/config";
import { serviceClient } from "./service";
const db = serviceClient();
const apply = process.argv.includes("--apply");
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const referenced = new Set<string>();
for (const [table, column] of [
  ["media_assets", "canonical_path"],
  ["detected_scenes", "thumbnail_path"],
  ["renders", "path"],
]) {
  let offset = 0;
  while (true) {
    const { data, error } = await db
      .from(table)
      .select(column)
      .range(offset, offset + 999);
    if (error) throw error;
    for (const row of data ?? [])
      if ((row as any)[column]) referenced.add((row as any)[column]);
    if ((data?.length ?? 0) < 1000) break;
    offset += 1000;
  }
}
const { data: active, error: activeError } = await db
  .from("processing_jobs")
  .select("id")
  .in("status", ["queued", "running"]);
if (activeError) throw activeError;
const activeIds = new Set(active?.map((j) => j.id));
const candidates: string[] = [];
async function walk(prefix = "") {
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await db.storage
      .from("media")
      .list(prefix, { limit: 100, offset });
    if (error) throw error;
    for (const item of data ?? []) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (!item.id) {
        await walk(path);
        continue;
      }
      if (
        !referenced.has(path) &&
        !activeIds.has(path.split("/")[2]) &&
        item.created_at &&
        new Date(item.created_at).getTime() < cutoff
      )
        candidates.push(path);
    }
    if ((data?.length ?? 0) < 100) break;
  }
}
await walk();
console.log(
  JSON.stringify(
    { mode: apply ? "apply" : "dry-run", orphaned_media: candidates },
    null,
    2,
  ),
);
if (apply) {
  for (let i = 0; i < candidates.length; i += 100) {
    const { error } = await db.storage
      .from("media")
      .remove(candidates.slice(i, i + 100));
    if (error) throw error;
  }
}
