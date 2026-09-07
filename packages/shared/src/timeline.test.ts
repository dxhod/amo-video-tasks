import { describe, it, expect } from "vitest";
import {
  durationFrames,
  locateFrame,
  splitAt,
  trimClip,
  moveClip,
  validateTimeline,
  sceneClips,
  shouldReview,
} from "./index";
const asset = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const clips = [
  { id, asset_id: asset, start: 30, end: 60 },
  { id: other, asset_id: asset, start: 0, end: 15 },
];
describe("timeline", () => {
  it("maps reordered video to source and clamps the final frame", () => {
    expect(durationFrames(clips)).toBe(45);
    expect(locateFrame(clips, 30)?.sourceFrame).toBe(0);
    expect(locateFrame(clips, 45)?.sourceFrame).toBe(14);
  });
  it("splits with exclusive boundaries and no empty scene", () => {
    expect(splitAt(clips, 0, asset)).toEqual(clips);
    const parts = splitAt(clips, 10, asset);
    expect(parts).toHaveLength(3);
    expect(durationFrames(parts)).toBe(45);
    expect(parts[1].start).toBe(40);
  });
  it("trims and reorders without changing other clips", () => {
    expect(trimClip(clips, id, 35, 55, 90)[0].end).toBe(55);
    expect(() => trimClip(clips, id, 55, 55, 90)).toThrow();
    expect(moveClip(clips, 0, 1)[0].id).toBe(other);
  });
  it("rejects foreign assets, overflow, duplicates and empty timelines", () => {
    expect(() => validateTimeline(clips, other, 90)).toThrow();
    expect(() => validateTimeline(clips, asset, 40)).toThrow();
    expect(() => validateTimeline([clips[0], clips[0]], asset, 90)).toThrow();
    expect(() => validateTimeline([], asset, 90)).toThrow();
  });
  it("normalizes scene boundaries and falls back to one scene", () => {
    expect(sceneClips(asset, 90, [], () => id)).toHaveLength(1);
    expect(
      sceneClips(asset, 90, [-1, 0, 1, 1.001, 9], () => id).map((c) => [
        c.start,
        c.end,
      ]),
    ).toEqual([
      [0, 30],
      [30, 90],
    ]);
  });
  it("does not let an old render or done task enter review", () => {
    expect(shouldReview(id, other, "in_progress")).toBe(false);
    expect(shouldReview(id, id, "done")).toBe(false);
    expect(shouldReview(id, id, "in_progress")).toBe(true);
  });
});
