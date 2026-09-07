import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
const output = execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["supabase", "status", "-o", "json"],
  {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const values = JSON.parse(output);
const url = values.API_URL ?? values.api_url;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw new Error("Local Supabase required");
const anon = values.ANON_KEY ?? values.anon_key,
  service = values.SERVICE_ROLE_KEY ?? values.service_role_key;
if (!anon || !service) throw new Error("Supabase keys missing");
const text = `NEXT_PUBLIC_SUPABASE_URL=${url}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${anon}\nSUPABASE_URL=${url}\nSUPABASE_SERVICE_ROLE_KEY=${service}\nNEXT_PUBLIC_APP_URL=http://localhost:3000\nALLOW_LOCAL_TESTS=true\n`;
for (const path of [".env", "apps/web/.env.local"]) {
  if (existsSync(path) && !process.argv.includes("--replace-local"))
    throw new Error(
      `${path} exists; preserve it or explicitly use --replace-local`,
    );
  writeFileSync(path, text);
}
console.log("Local environment files written. Keys were not printed.");
