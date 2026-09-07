import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { testUser } from "../integration/helpers";
import { ffmpeg } from "../../apps/worker/src/media";
test("team video workflow through the browser", async ({ page, browser }) => {
  const editor = await testUser("UI Монтажер"),
    reviewer = await testUser("UI Рев’юер");
  await mkdir(".local", { recursive: true });
  const source = resolve(".local", `e2e-${randomUUID()}.mp4`);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=30:d=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(editor.email);
  await page.getByLabel("Пароль", { exact: true }).fill(editor.password);
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваші проєкти" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Новий проєкт" }).click();
  await page.getByLabel("Назва проєкту").fill("UI відеопростір");
  await page.getByRole("button", { name: "Створити простір" }).click();
  await expect(
    page.getByRole("heading", { name: "UI відеопростір" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Команда", exact: true }).click();
  await page
    .getByLabel("Email зареєстрованого користувача")
    .fill(reviewer.email);
  await page.getByRole("button", { name: "Додати учасника" }).click();
  await page.getByRole("button", { name: "Нова задача" }).click();
  await page.getByLabel("Назва задачі").fill("UI тест монтажу");
  await page
    .getByRole("combobox", { name: "Рев’юер", exact: true })
    .selectOption(reviewer.id);
  await page.getByRole("button", { name: "Створити задачу" }).click();
  await page.getByRole("heading", { name: "UI тест монтажу" }).click();
  await expect(page).toHaveURL(/\/tasks\//);
  const taskUrl = page.url();
  await page.getByLabel("Завантажити відео").setInputFiles(source);
  await expect(
    page.getByRole("button", { name: "Рендерити версію" }),
  ).toBeVisible({ timeout: 120000 });
  await page.getByLabel("Кінець, кадр", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Рендерити версію" }).click();
  await expect(page.getByRole("link", { name: "Відкрити MP4" })).toBeVisible({
    timeout: 120000,
  });
  const v1url = await page
    .getByRole("link", { name: "Відкрити MP4" })
    .getAttribute("href");
  await expect(page.getByLabel("Кінець, кадр", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Доопрацювати", exact: true }).click();
  await page
    .getByLabel("Що потрібно змінити?")
    .fill("Підготувати другий монтаж");
  await page.getByRole("button", { name: "Повернути з коментарем" }).click();
  await expect(page.getByLabel("Кінець, кадр", { exact: true })).toBeEnabled();
  await page.getByLabel("Кінець, кадр", { exact: true }).fill("10");
  await expect(page.getByText(/Попередній результат застарів/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Передати на перевірку" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Рендерити версію" }).click();
  await expect(page.getByLabel("Кінець, кадр", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Відкрити MP4", exact: true }),
  ).toBeVisible({ timeout: 120000 });
  const v1revised = await page
    .getByRole("link", { name: "Відкрити MP4", exact: true })
    .getAttribute("href");
  expect(v1revised?.split("?")[0]).not.toBe(v1url?.split("?")[0]);
  expect((await page.request.get(v1url!)).ok()).toBe(true);
  await page.getByRole("button", { name: "Доопрацювати", exact: true }).click();
  await page
    .getByLabel("Що потрібно змінити?")
    .fill("Тепер створити окрему v2");
  await page.getByRole("button", { name: "Повернути з коментарем" }).click();
  await page.getByRole("button", { name: "Нова версія з цієї" }).click();
  await expect(
    page.getByRole("heading", { name: "Результат v2" }),
  ).toBeVisible();
  await page.getByLabel("Позиція відтворення").fill("5");
  await expect(page.getByLabel("Позиція відтворення")).toHaveValue("5");
  await page.getByRole("button", { name: "Розрізати", exact: true }).click();
  await expect(page.getByText("3 фрагм.")).toBeVisible();
  await page.getByLabel("Видалити фрагмент", { exact: true }).click();
  await page.getByRole("button", { name: "Рендерити версію" }).click();
  await expect(page.getByRole("link", { name: "Відкрити MP4" })).toBeVisible({
    timeout: 120000,
  });
  const v2url = await page
    .getByRole("link", { name: "Відкрити MP4" })
    .getAttribute("href");
  expect(v2url?.split("?")[0]).not.toBe(v1url?.split("?")[0]);
  for (const url of [v1url, v2url]) {
    const response = await page.request.get(url!);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("video/mp4");
    expect((await response.body()).byteLength).toBeGreaterThan(0);
  }
  await page.getByRole("button", { name: /^v1/ }).click();
  await expect(
    page.getByRole("link", { name: "Відкрити MP4" }),
  ).toHaveAttribute("href", /render\.mp4/);
  const reviewContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const review = await reviewContext.newPage();
  await review.goto("/login");
  await review.getByLabel("Email", { exact: true }).fill(reviewer.email);
  await review.getByLabel("Пароль", { exact: true }).fill(reviewer.password);
  await review.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(
    review.getByRole("heading", { name: "Ваші проєкти" }),
  ).toBeVisible();
  await review.goto(taskUrl);
  await review
    .getByLabel("Ваш коментар")
    .fill("Перевірено: другий монтаж готовий.");
  await review.getByRole("button", { name: "Додати коментар" }).click();
  await review.getByRole("button", { name: "Прийняти", exact: true }).click();
  await expect(
    review.locator(".page-head").getByText("Готово", { exact: true }),
  ).toBeVisible();
  await reviewContext.close();
  await page.reload();
  await expect(
    page.locator(".page-head").getByText("Готово", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "До дошки проєкту" }).click();
  await page.getByRole("link", { name: "Статистика" }).click();
  await expect(
    page.getByRole("heading", { name: "Пульс проєкту" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "UI Монтажер", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/e2e-admin.png", fullPage: true });
  await page.goto(taskUrl);
  await page
    .getByRole("button", { name: "Видалити задачу", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Видалення задачі" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Скасувати", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "UI тест монтажу" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Видалити задачу", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Підтвердити видалення", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(
    page.getByRole("heading", { name: "UI тест монтажу" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Статистика" }).click();
  await expect(
    page.getByRole("heading", { name: "Видалені задачі" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "UI Монтажер", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Відновити UI тест монтажу", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Відновити UI тест монтажу",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: "UI Монтажер", exact: true }),
  ).toBeVisible();
  await page.goto(taskUrl);
  await expect(
    page.getByRole("heading", { name: "Результат v2" }),
  ).toBeVisible();
  await expect(
    page.getByText("Перевірено: другий монтаж готовий."),
  ).toBeVisible();
  await page.getByRole("button", { name: /^v1/ }).click();
  await expect(page.getByRole("link", { name: "Відкрити MP4" })).toBeVisible();
  await expect(page.getByLabel("Кінець, кадр", { exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "До дошки проєкту" }).click();
  const projectUrl = page.url();
  await page
    .getByRole("button", { name: "Видалити проєкт", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Видалення проєкту" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Скасувати", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "UI відеопростір" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Видалити проєкт", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Підтвердити видалення", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Видалені проєкти" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /UI відеопростір/ })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Відновити проєкт", exact: true })
    .click();
  await page.goto(projectUrl);
  await expect(
    page.getByRole("heading", { name: "UI тест монтажу" }),
  ).toBeVisible();
  await page.goto(taskUrl);
  await expect(
    page.getByRole("heading", { name: "Результат v2" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Відкрити MP4", exact: true }),
  ).toBeVisible();
});
