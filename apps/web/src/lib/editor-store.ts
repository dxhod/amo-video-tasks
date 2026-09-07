import { createStore } from "zustand/vanilla";
import type { Clip } from "@amo/shared";
export function createEditorStore(clips: Clip[], revision: number) {
  return createStore<{
    clips: Clip[];
    revision: number;
    generation: number;
    selected: string | null;
    frame: number;
    setClips: (clips: Clip[]) => void;
    select: (id: string) => void;
    seek: (frame: number) => void;
    ack: (revision: number) => void;
  }>((set) => ({
    clips,
    revision,
    generation: 0,
    selected: clips[0]?.id ?? null,
    frame: 0,
    setClips: (clips) =>
      set((s) => ({
        clips,
        generation: s.generation + 1,
        frame: Math.min(
          s.frame,
          Math.max(0, clips.reduce((n, c) => n + c.end - c.start, 0) - 1),
        ),
      })),
    select: (selected) => set({ selected }),
    seek: (frame) => set({ frame }),
    ack: (revision) => set({ revision }),
  }));
}
