import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function emailLink(
  request: APIRequestContext,
  email: string,
  excluded = "",
) {
  let id = "";
  await expect
    .poll(async () => {
      const response = await request.get(
        "http://127.0.0.1:54324/api/v1/messages",
      );
      const data = await response.json();
      id =
        data.messages.find(
          (m: { ID: string; To: { Address: string }[] }) =>
            m.ID !== excluded && m.To.some((to) => to.Address === email),
        )?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = await (
    await request.get(`http://127.0.0.1:54324/api/v1/message/${id}`)
  ).json();
  const link = String(message.HTML).match(
    /href="([^"]*\/auth\/v1\/verify[^"]*)"/,
  )?.[1];
  expect(link).toBeTruthy();
  const url = new URL(link!.replaceAll("&amp;", "&"));
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  return { id, link: url.toString() };
}

test("email confirmation and password recovery", async ({ page, request }) => {
  const email = `signup-${randomUUID()}@amo.test`;
  const password = `Amo-${randomUUID()}!`;
  await page.goto("/login");
  await page.getByRole("button", { name: "Створити акаунт" }).click();
  await page.getByLabel("Ваше ім’я").fill("Новий учасник");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Зареєструватися" }).click();
  await expect(page.getByRole("status")).toContainText("Перевірте пошту");
  const confirmation = await emailLink(request, email);
  await page.goto(confirmation.link);
  await expect(
    page.getByRole("heading", { name: "Ваші проєкти" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Вийти", exact: true }).click();
  await page.getByRole("button", { name: "Забули пароль?" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Надіслати лист" }).click();
  await expect(page.getByRole("status")).toContainText("лист для відновлення");
  const recovery = await emailLink(request, email, confirmation.id);
  await page.goto(recovery.link);
  await expect(
    page.getByRole("heading", { name: "Новий пароль." }),
  ).toBeVisible();
  await page.getByLabel("Пароль", { exact: true }).fill(`${password}new`);
  await page.getByRole("button", { name: "Зберегти пароль" }).click();
  await expect(
    page.getByRole("heading", { name: "Ваші проєкти" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Вийти", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(`${password}new`);
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ваші проєкти" }),
  ).toBeVisible();
});
