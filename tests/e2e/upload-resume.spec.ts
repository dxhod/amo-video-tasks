import { test, expect } from "@playwright/test";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { cmd, testUser } from "../integration/helpers";
import { ffmpeg } from "../../apps/worker/src/media";

test("resumes a partially uploaded video after reload", async ({ page }) => {
  const user = await testUser("TUS перевірка");
  const project = await cmd(user.db, "project.create", {
    name: "TUS recovery",
  });
  const task = await cmd(user.db, "task.create", {
    project_id: project.id,
    title: "Перерване завантаження",
    assignee_id: user.id,
    reviewer_id: user.id,
  });
  await mkdir(".local", { recursive: true });
  const source = resolve(".local", `tus-${randomUUID()}.mp4`);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1280x720:r=30:d=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "10",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  const bytes = (await stat(source)).size;
  expect(bytes).toBeGreaterThan(6 * 1024 * 1024);
  expect(bytes).toBeLessThan(50 * 1024 * 1024);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваші проєкти" }),
  ).toBeVisible();
  await page.goto(`/tasks/${task.id}`);
  let broken = true;
  let rejectedChunks = 0;
  let resumedOffset = 0;
  await page.route("**/storage/v1/upload/resumable**", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      if (broken) {
        rejectedChunks++;
        await route.abort("connectionreset");
        return;
      }
      resumedOffset = Math.max(
        resumedOffset,
        Number(request.headers()["upload-offset"] ?? 0),
      );
    }
    await route.continue();
  });
  await page.getByLabel("Завантажити відео").setInputFiles(source);
  await expect
    .poll(() => rejectedChunks, { timeout: 45000 })
    .toBeGreaterThan(0);
  await expect(page.getByLabel("Завантажити відео")).toBeEnabled({
    timeout: 60000,
  });
  const original = await user.db
    .from("media_assets")
    .select("id,source_path,status")
    .eq("task_id", task.id)
    .single();
  expect(original.data?.status).toBe("uploading");
  broken = false;
  await page.reload();
  await page.getByLabel("Завантажити відео").setInputFiles(source);
  await expect(
    page.getByRole("button", { name: "Рендерити версію" }),
  ).toBeVisible({ timeout: 120000 });
  expect(resumedOffset).toBeGreaterThanOrEqual(6 * 1024 * 1024);
  const after = await user.db
    .from("media_assets")
    .select("id,source_path,status")
    .eq("task_id", task.id);
  expect(after.data).toEqual([{ ...original.data, status: "ready" }]);
});
