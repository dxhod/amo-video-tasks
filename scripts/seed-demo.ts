import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { testUser, cmd, localDb } from "../tests/integration/helpers";
import { ffmpeg } from "../apps/worker/src/media";
import { processJob } from "../apps/worker/src/process-job";
import { rpc } from "../apps/worker/src/service";
const admin = localDb();
const editor = await testUser("Олена · монтаж"),
  reviewer = await testUser("Максим · review");
const project = await cmd(editor.db, "project.create", {
  name: "Історії, що надихають",
});
await cmd(editor.db, "member.add", {
  project_id: project.id,
  email: reviewer.email,
});
const task = await cmd(editor.db, "task.create", {
  project_id: project.id,
  title: "Кольори нової історії",
  description:
    "Короткий відеоетюд: три кольори, два варіанти монтажу. Готовий до обговорення.",
  assignee_id: editor.id,
  reviewer_id: reviewer.id,
});
await mkdir(".local", { recursive: true });
const source = join(".local", "demo-source.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=c=0xb8c69a:s=640x360:r=30:d=2",
  "-f",
  "lavfi",
  "-i",
  "color=c=0xd78254:s=640x360:r=30:d=2",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x516852:s=640x360:r=30:d=2",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=6",
  "-filter_complex",
  "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
  "-map",
  "[v]",
  "-map",
  "3:a",
  "-c:v",
  "libx264",
  "-c:a",
  "aac",
  "-pix_fmt",
  "yuv420p",
  source,
]);
const bytes = await readFile(source),
  asset = await cmd(editor.db, "upload.create", {
    task_id: task.id,
    mime: "video/mp4",
    bytes: bytes.length,
  });
const uploaded = await editor.db.storage
  .from("sources")
  .upload(asset.source_path, bytes, { contentType: "video/mp4" });
if (uploaded.error) throw uploaded.error;
await cmd(editor.db, "upload.complete", {
  asset_id: asset.id,
  key: randomUUID(),
});
async function drain() {
  for (let i = 0; i < 20; i++) {
    const job = await rpc(admin, "worker_claim", { p_worker: "demo-seed" });
    if (!job) return;
    await processJob(admin, job);
  }
}
await drain();
const { data: versions, error } = await editor.db
  .from("edit_versions")
  .select("*")
  .eq("task_id", task.id);
if (error || !versions?.length) throw error ?? new Error("Analysis failed");
const v1 = versions[0];
await cmd(editor.db, "render.start", {
  version_id: v1.id,
  revision: 1,
  key: randomUUID(),
});
await drain();
await cmd(reviewer.db, "task.status", {
  task_id: task.id,
  status: "in_progress",
  comment: "Підготувати альтернативну версію монтажу.",
});
const v2 = await cmd(editor.db, "version.copy", { version_id: v1.id });
await cmd(editor.db, "version.save", {
  version_id: v2.id,
  revision: 1,
  timeline: [...v1.timeline].reverse(),
});
await cmd(editor.db, "render.start", {
  version_id: v2.id,
  revision: 2,
  key: randomUUID(),
});
await drain();
await cmd(reviewer.db, "comment.add", {
  task_id: task.id,
  body: "Другий варіант має цікавіший початок. Перевірмо фінальний кадр перед затвердженням.",
});
for (const [title, description] of [
  ["Літній настрій", "Вибрати ключові моменти для короткого ролика."],
  ["Знайомство з командою", "Перший монтаж історії про людей за кадром."],
  ["Новий погляд", "Підготувати альтернативну версію вступу."],
])
  await cmd(editor.db, "task.create", {
    project_id: project.id,
    title,
    description,
    assignee_id: editor.id,
    reviewer_id: reviewer.id,
  });
await writeFile(
  ".local/demo.json",
  JSON.stringify(
    {
      project_id: project.id,
      task_id: task.id,
      editor: { email: editor.email, password: editor.password },
      reviewer: { email: reviewer.email, password: reviewer.password },
    },
    null,
    2,
  ),
);
console.log(
  "Demo created. Local-only credentials: .local/demo.json (gitignored).",
);
