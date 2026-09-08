import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { normalize, detect, render } from "../apps/worker/src/media";

// Run inside a disposable Docker container with --memory=512m --memory-swap=512m.
// Input is a local synthetic fixture. No database, credentials or external jobs.
const [input, directory] = process.argv.slice(2);
if (!input || !directory)
  throw new Error("Usage: media-resource-check input output-dir");
await mkdir(directory, { recursive: true });
const id = randomUUID();
const canonical = join(directory, "canonical.mp4");
const info = await normalize(input, canonical);
const scenes = await detect(canonical, id, info.frames);
console.log(
  JSON.stringify({ stage: "analyzed", ...info, scenes: scenes.length }),
);
const clips = Array.from({ length: 6 }, (_, i) => ({
  id: randomUUID(),
  asset_id: id,
  start: Math.floor((i * info.frames) / 6),
  end: Math.floor(((i + 1) * info.frames) / 6),
})).reverse();
const result = await render(
  canonical,
  join(directory, "reversed.mp4"),
  clips,
  id,
);
let peak: string | null = null;
try {
  peak = (await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim();
} catch {
  /* cgroup v1 */
}
console.log(
  JSON.stringify({ stage: "rendered", ...result, cgroup_peak_bytes: peak }),
);
