import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  testMatch: "workflow.spec.ts",
  webServer: undefined,
  use: { ...config.use, baseURL: "http://127.0.0.1:3100" },
  outputDir: "test-results/docker",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/docker", open: "never" }],
  ],
});
