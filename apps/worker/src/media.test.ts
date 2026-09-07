import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ffmpeg, normalize, detect, render, probe, run } from "./media";
let dir: string;
const asset = randomUUID();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "amo-test-"));
});
afterAll(async () => {
  const target = resolve(dir),
    root = resolve(tmpdir()) + sep;
  if (
    target.startsWith(root) &&
    target.slice(root.length).startsWith("amo-test-")
  )
    await rm(target, { recursive: true, force: true });
});
async function fixture(name: string, audio: boolean, vertical = false) {
  const out = join(dir, name);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=${vertical ? "180x320" : "320x180"}:r=30:d=1`,
    "-f",
    "lavfi",
    "-i",
    `color=c=blue:s=${vertical ? "180x320" : "320x180"}:r=30:d=1`,
    ...(audio
      ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000"]
      : []),
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    ...(audio ? ["-map", "2:a", "-c:a", "aac"] : ["-an"]),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  return out;
}
describe("real FFmpeg", () => {
  it.each([true, false])(
    "detects and renders reordered trimmed clips, audio=%s",
    async (audio) => {
      const input = await fixture(`source-${audio}.mp4`, audio),
        canonical = join(dir, `canonical-${audio}.mp4`),
        output = join(dir, `render-${audio}.mp4`);
      const normalized = await normalize(input, canonical);
      expect(normalized.frames).toBe(60);
      expect(normalized.hasAudio).toBe(audio);
      const scenes = await detect(canonical, asset, 60);
      expect(scenes.map((c) => c.start)).toContain(30);
      const clips = [
        { id: randomUUID(), asset_id: asset, start: 30, end: 60 },
        { id: randomUUID(), asset_id: asset, start: 0, end: 15 },
      ];
      const result = await render(canonical, output, clips, asset);
      expect(result.frames).toBe(45);
      expect(result.hasAudio).toBe(audio);
      // The first output frame must be blue, the last must be red, regardless of source order.
      const pixel = async (frame: number) => {
        const { stdout } = await ffmpeg([
          "-i",
          output,
          "-vf",
          `select=eq(n\\,${frame}),scale=1:1,format=rgb24`,
          "-frames:v",
          "1",
          "-f",
          "image2",
          "-c:v",
          "ppm",
          "pipe:1",
        ]);
        return stdout;
      };
      expect((await pixel(0)).length).toBeGreaterThan(10);
      const stats = await ffmpeg([
        "-i",
        output,
        "-vf",
        "signalstats,metadata=print:file=-",
        "-an",
        "-f",
        "null",
        "-",
      ]);
      const u = [
        ...stats.stdout.matchAll(/lavfi.signalstats.UAVG=([\d.]+)/g),
      ].map((m) => Number(m[1]));
      expect(u[0]).toBeGreaterThan(u[44] + 80);
    },
  );
  it("keeps vertical geometry without upscaling", async () => {
    const input = await fixture("vertical.mp4", false, true);
    const info = await normalize(input, join(dir, "vertical-normal.mp4"));
    expect([info.width, info.height]).toEqual([180, 320]);
  });
  it("rejects corrupt files and clips exceeding the source", async () => {
    const bad = join(dir, "bad.mp4");
    await writeFile(bad, "not video");
    await expect(probe(bad)).rejects.toThrow();
    const input = await fixture("bounds.mp4", false);
    await expect(
      render(
        input,
        join(dir, "bad-output.mp4"),
        [{ id: randomUUID(), asset_id: asset, start: 0, end: 90 }],
        asset,
      ),
    ).rejects.toThrow();
  });
  it("rejects video over thirty seconds", async () => {
    const input = join(dir, "long.mp4");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=32x32:r=1:d=31",
      "-c:v",
      "libx264",
      input,
    ]);
    await expect(
      normalize(input, join(dir, "long-output.mp4")),
    ).rejects.toThrow("30");
  });
  it("terminates a process on timeout", async () => {
    await expect(
      run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
        timeout: 50,
      }),
    ).rejects.toThrow("час");
  });
});
