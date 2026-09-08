import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  FPS,
  MAX_SECONDS,
  sceneClips,
  validateTimeline,
  type Clip,
} from "@amo/shared";

export class MediaError extends Error {
  constructor(
    message: string,
    public code = "INVALID_MEDIA",
  ) {
    super(message);
  }
}
export interface RunOptions {
  signal?: AbortSignal;
  progress?: (seconds: number) => void;
  timeout?: number;
}
export async function run(
  executable: string,
  args: string[],
  options: RunOptions = {},
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      pending = "",
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(new MediaError("Обробку зупинено", "ABORTED"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new MediaError("Перевищено час обробки", "TIMEOUT"));
    }, options.timeout ?? 600000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdout = (stdout + value).slice(-2_000_000);
      pending += value;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/);
        if (match) options.progress?.(Number(match[1]) / 1e6);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-100000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new MediaError(`FFmpeg/ffprobe (${code}): ${stderr.slice(-4000)}`),
      ),
    );
    if (options.signal?.aborted) abort();
  });
}
export const ffmpeg = (args: string[], options?: RunOptions) =>
  run(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    ["-hide_banner", "-nostdin", "-y", ...args],
    options,
  );
export async function probe(path: string, signal?: AbortSignal) {
  const { stdout } = await run(
    process.env.FFPROBE_PATH ?? "ffprobe",
    [
      "-protocol_whitelist",
      "file,pipe",
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      path,
    ],
    { signal, timeout: 30000 },
  );
  const parsed = JSON.parse(stdout);
  const video = parsed.streams?.find(
    (s: any) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const duration = Number(parsed.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0)
    throw new MediaError("Файл не містить коректного відео");
  return {
    duration,
    frames: Number(video.nb_frames) || Math.round(duration * FPS),
    hasAudio: parsed.streams.some((s: any) => s.codec_type === "audio"),
    width: Number(video.width),
    height: Number(video.height),
    format: String(parsed.format?.format_name ?? ""),
  };
}
export async function normalize(
  input: string,
  output: string,
  options: RunOptions = {},
) {
  const source = await probe(input, options.signal);
  if (source.duration > MAX_SECONDS + 0.001)
    throw new MediaError(
      "Відео має бути не довшим за 30 секунд",
      "VIDEO_TOO_LONG",
    );
  if (!/mov|mp4|matroska|webm/.test(source.format))
    throw new MediaError("Підтримуються MP4, MOV і WebM");
  if (source.width * source.height > 3840 * 2160)
    throw new MediaError("Максимальна роздільність вихідного відео — 4K");
  const scale =
    "scale=w='trunc(iw*min(1,1920/max(iw,ih))/2)*2':h='trunc(ih*min(1,1920/max(iw,ih))/2)*2',setsar=1,fps=30,setpts=PTS-STARTPTS";
  await ffmpeg(
    [
      "-protocol_whitelist",
      "file,pipe",
      "-threads",
      "2",
      "-i",
      input,
      "-filter_threads",
      "1",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      scale,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      ...(source.hasAudio
        ? [
            "-af",
            "aresample=48000:async=1:first_pts=0",
            "-c:a",
            "aac",
            "-ac",
            "2",
          ]
        : ["-an"]),
      "-t",
      "30",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      output,
    ],
    options,
  );
  return probe(output, options.signal);
}
export async function detect(
  path: string,
  assetId: string,
  frames: number,
  signal?: AbortSignal,
) {
  const { stdout } = await ffmpeg(
    [
      "-i",
      path,
      "-vf",
      "scdet=threshold=10,metadata=print:file=-",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  const times = [...stdout.matchAll(/lavfi\.scd\.time=([\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
  return sceneClips(assetId, frames, times, randomUUID);
}
export async function thumbnail(
  input: string,
  output: string,
  frame: number,
  signal?: AbortSignal,
) {
  await ffmpeg(
    [
      "-ss",
      String(frame / FPS),
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      "scale=240:-2",
      "-q:v",
      "4",
      output,
    ],
    { signal, timeout: 30000 },
  );
}
export function renderGraph(clips: Clip[], audio: boolean) {
  const parts: string[] = [];
  if (clips.length > 1) {
    parts.push(
      `[0:v]split=${clips.length}${clips.map((_, i) => `[sv${i}]`).join("")}`,
    );
    if (audio)
      parts.push(
        `[0:a]asplit=${clips.length}${clips.map((_, i) => `[sa${i}]`).join("")}`,
      );
  }
  clips.forEach((c, i) => {
    parts.push(
      `[${clips.length > 1 ? `sv${i}` : "0:v"}]trim=start_frame=${c.start}:end_frame=${c.end},setpts=PTS-STARTPTS[v${i}]`,
    );
    if (audio)
      parts.push(
        `[${clips.length > 1 ? `sa${i}` : "0:a"}]atrim=start=${c.start / FPS}:end=${c.end / FPS},asetpts=PTS-STARTPTS,apad,atrim=duration=${(c.end - c.start) / FPS}[a${i}]`,
      );
  });
  parts.push(
    `${clips.map((_, i) => `[v${i}]${audio ? `[a${i}]` : ""}`).join("")}concat=n=${clips.length}:v=1:a=${audio ? 1 : 0}[video]${audio ? "[audio]" : ""}`,
  );
  return parts.join(";");
}
export async function render(
  input: string,
  output: string,
  clips: Clip[],
  assetId: string,
  options: RunOptions = {},
) {
  const source = await probe(input, options.signal);
  validateTimeline(clips, assetId, source.frames);
  const started = Date.now();
  // A split/concat graph buffers most of the source for reversed clips. Process
  // one clip at a time so memory does not grow with the timeline length.
  // NUT preserves rational video timestamps; PCM avoids AAC priming at every cut.
  const work = await mkdtemp(join(dirname(output), "render-parts-"));
  try {
    let completed = 0;
    for (const [i, clip] of clips.entries()) {
      const duration = (clip.end - clip.start) / FPS;
      await ffmpeg(
        [
          "-threads",
          "2",
          "-i",
          input,
          "-filter_threads",
          "1",
          "-map",
          "0:v:0",
          "-vf",
          `trim=start_frame=${clip.start}:end_frame=${clip.end},setpts=PTS-STARTPTS`,
          ...(source.hasAudio
            ? [
                "-map",
                "0:a:0",
                "-af",
                `atrim=start=${clip.start / FPS}:end=${clip.end / FPS},asetpts=PTS-STARTPTS,apad,atrim=duration=${duration}`,
                "-c:a",
                "pcm_s16le",
              ]
            : ["-an"]),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-threads",
          "2",
          "-x264-params",
          "rc-lookahead=10:sync-lookahead=0",
          "-progress",
          "pipe:1",
          join(work, `part-${i}.nut`),
        ],
        {
          ...options,
          progress: (s) =>
            options.progress?.(completed + Math.min(s, duration)),
        },
      );
      completed += duration;
    }
    const list = join(work, "parts.txt");
    await writeFile(
      list,
      clips
        .map(
          (c, i) =>
            `file 'part-${i}.nut'\nduration ${(c.end - c.start) / FPS}\n`,
        )
        .join(""),
    );
    await ffmpeg(
      [
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        list,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        ...(source.hasAudio ? ["-map", "0:a:0", "-c:a", "aac"] : ["-an"]),
        "-movflags",
        "+faststart",
        output,
      ],
      { ...options, progress: undefined },
    );
  } finally {
    // mkdtemp returns a new child directory of the caller's temporary job folder.
    if (dirname(resolve(work)) === resolve(dirname(output)))
      await rm(work, { recursive: true, force: true });
  }
  const result = await probe(output, options.signal);
  const expected = clips.reduce((s, c) => s + c.end - c.start, 0);
  if (Math.abs(result.frames - expected) > 1)
    throw new MediaError(
      "Тривалість результату не відповідає монтажу",
      "RENDER_MISMATCH",
    );
  return {
    ...result,
    renderMs: Date.now() - started,
    duration: expected / FPS,
  };
}
