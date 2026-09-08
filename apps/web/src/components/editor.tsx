"use client";
import { useState, useRef, useEffect } from "react";
import { useStore } from "zustand";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Play,
  Pause,
  Scissors,
  Trash2,
  GripVertical,
  Film,
  Save,
  RotateCcw,
} from "lucide-react";
import {
  FPS,
  durationFrames,
  locateFrame,
  splitAt,
  trimClip,
  moveClip,
  type Clip,
} from "@amo/shared";
import { createEditorStore } from "@/lib/editor-store";
import { command, ClientError } from "@/lib/client-api";
import { time } from "@/lib/utils";
import { Button } from "./ui/button";
const PX = 3;
function ClipBlock({
  clip,
  selected,
  thumb,
  locked,
  onSelect,
  onTrim,
}: {
  clip: Clip;
  selected: boolean;
  thumb?: string;
  locked: boolean;
  onSelect: () => void;
  onTrim: (start: number, end: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: clip.id, disabled: locked });
  function trim(
    e: React.PointerEvent<HTMLSpanElement>,
    edge: "left" | "right",
  ) {
    if (locked) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const origin = e.clientX,
      start = clip.start,
      end = clip.end,
      node = e.currentTarget;
    const move = (event: PointerEvent) => {
      const delta = Math.round((event.clientX - origin) / PX);
      onTrim(
        edge === "left" ? Math.max(0, Math.min(end - 1, start + delta)) : start,
        edge === "right" ? Math.max(start + 1, end + delta) : end,
      );
    };
    const up = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }
  return (
    <div
      ref={setNodeRef}
      className={`clip ${selected ? "selected" : ""}`}
      style={{
        width: (clip.end - clip.start) * PX,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      onClick={onSelect}
      role="group"
      aria-label={`Фрагмент ${time(clip.start / FPS)}–${time(clip.end / FPS)}`}
    >
      <div
        className="clip-image"
        style={{ backgroundImage: thumb ? `url("${thumb}")` : undefined }}
      >
        {!thumb && <Film size={18} />}
      </div>
      <div className="clip-label">{time((clip.end - clip.start) / FPS)}</div>
      {!locked && (
        <>
          <button
            className="clip-grab"
            aria-label="Переставити фрагмент"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={15} />
          </button>
          <span
            className="trim-handle left"
            role="slider"
            aria-label="Початок фрагмента"
            aria-valuenow={clip.start}
            onPointerDown={(e) => trim(e, "left")}
          />
          <span
            className="trim-handle right"
            role="slider"
            aria-label="Кінець фрагмента"
            aria-valuenow={clip.end}
            onPointerDown={(e) => trim(e, "right")}
          />
        </>
      )}
    </div>
  );
}
export function Editor({
  version,
  asset,
  scenes,
  urls,
  editable,
  onRender,
  onRefresh,
  onSaved,
  flushRef,
}: {
  version: any;
  asset: any;
  scenes: any[];
  urls: Record<string, string>;
  editable: boolean;
  onRender: (revision: number, versionId: string) => Promise<void>;
  onRefresh: () => void;
  onSaved: (versionId: string) => void;
  flushRef: { current: (() => Promise<string>) | null };
}) {
  const [store] = useState(() =>
    createEditorStore(version.timeline, version.revision),
  );
  const state = useStore(store),
    video = useRef<HTMLVideoElement>(null),
    playingRef = useRef(false),
    clipIndex = useRef(0),
    savedGeneration = useRef(0),
    saving = useRef<Promise<void> | null>(null),
    workingVersion = useRef(version.id),
    lockedFailure = useRef(false),
    conflicted = useRef(false);
  const [playing, setPlaying] = useState(false),
    [saveLabel, setSaveLabel] = useState("Усі зміни збережено"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const locked = !editable || busy,
    total = durationFrames(state.clips),
    selected = state.clips.find((c) => c.id === state.selected);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  async function flush() {
    if (conflicted.current)
      throw new Error("Завантажте актуальну версію, щоб продовжити.");
    if (saving.current) await saving.current;
    while (savedGeneration.current !== store.getState().generation) {
      const snapshot = store.getState();
      setSaveLabel("Зберігаємо…");
      const work = (async () => {
        try {
          const result = await command("version.save", {
            version_id: workingVersion.current,
            revision: snapshot.revision,
            timeline: snapshot.clips,
          });
          store.getState().ack(result.revision);
          workingVersion.current = result.id;
          savedGeneration.current = snapshot.generation;
          setSaveLabel("Усі зміни збережено");
          setError("");
        } catch (e) {
          if (
            e instanceof ClientError &&
            ["REVISION_CONFLICT", "VERSION_LOCKED"].includes(e.code)
          ) {
            conflicted.current = true;
            lockedFailure.current = e.code === "VERSION_LOCKED";
          }
          setSaveLabel("Не збережено");
          setError((e as Error).message);
          throw e;
        }
      })();
      saving.current = work;
      try {
        await work;
      } finally {
        if (saving.current === work) saving.current = null;
      }
    }
    onSaved(workingVersion.current);
    return workingVersion.current as string;
  }
  useEffect(() => {
    // Polling can update a clean editor after a render or another command.
    // Never replace unsaved local changes with server state.
    if (
      !saving.current &&
      workingVersion.current === version.id &&
      version.revision > store.getState().revision &&
      store.getState().generation === savedGeneration.current
    ) {
      store.setState({ clips: version.timeline, revision: version.revision });
      conflicted.current = false;
    }
  }, [version.id, version.revision, version.timeline, store]);
  useEffect(() => {
    if (editable && lockedFailure.current) {
      lockedFailure.current = false;
      conflicted.current = false;
      setError("");
    }
  }, [editable]);
  useEffect(() => {
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  });
  useEffect(() => {
    if (state.generation === savedGeneration.current || locked) return;
    setSaveLabel("Незбережені зміни");
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [state.generation, locked]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (store.getState().generation !== savedGeneration.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [store]);
  useEffect(() => {
    return () => {
      playingRef.current = false;
    };
  }, []);
  function seek(frame: number) {
    const hit = locateFrame(store.getState().clips, frame);
    if (!hit || !video.current) return;
    clipIndex.current = hit.index;
    video.current.currentTime = hit.sourceFrame / FPS;
    store.getState().seek(frame);
  }
  function toggle() {
    if (!video.current) return;
    if (playing) {
      video.current.pause();
      playingRef.current = false;
      setPlaying(false);
    } else {
      seek(state.frame >= total - 1 ? 0 : state.frame);
      playingRef.current = true;
      setPlaying(true);
      void video.current.play().catch((e) => {
        setError(e.message);
        playingRef.current = false;
        setPlaying(false);
      });
    }
  }
  useEffect(() => {
    if (!playing) return;
    let animation: number;
    const tick = () => {
      const element = video.current,
        current = store.getState();
      if (!element || !playingRef.current) return;
      const index = clipIndex.current,
        c = current.clips[index];
      if (!c) return;
      if (element.currentTime * FPS >= c.end - 0.5 || element.ended) {
        if (index + 1 < current.clips.length) {
          clipIndex.current = index + 1;
          element.currentTime = current.clips[index + 1].start / FPS;
          void element.play().catch(() => {});
        } else {
          element.pause();
          playingRef.current = false;
          setPlaying(false);
          current.seek(durationFrames(current.clips) - 1);
          return;
        }
      } else {
        const offset = durationFrames(current.clips.slice(0, index));
        current.seek(
          Math.max(
            offset,
            Math.min(
              offset + c.end - c.start - 1,
              offset + Math.floor(element.currentTime * FPS) - c.start,
            ),
          ),
        );
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, store]);
  function edit(clips: Clip[]) {
    if (locked) return;
    playingRef.current = false;
    setPlaying(false);
    video.current?.pause();
    store.getState().setClips(clips);
  }
  function trim(id: string, start: number, end: number) {
    try {
      edit(
        trimClip(
          store.getState().clips,
          id,
          start,
          Math.min(asset.frames, end),
          asset.frames,
        ),
      );
    } catch {
      /* Clamp invalid pointer moves; numeric controls show validity. */
    }
  }
  return (
    <div>
      <div className="editor-stage">
        <div className="stage-top">
          <span>ПЕРЕДПЕРЕГЛЯД · V{version.number}</span>
          <span>30 FPS · {asset.has_audio ? "ВІДЕО + ЗВУК" : "БЕЗ ЗВУКУ"}</span>
        </div>
        <div className="video-wrap">
          <video
            ref={video}
            src={urls[asset.canonical_path]}
            preload="auto"
            playsInline
            onLoadedMetadata={() => seek(store.getState().frame)}
            onError={() =>
              setError(
                "Не вдалося відкрити відео. Оновіть сторінку для нової адреси доступу.",
              )
            }
          />
        </div>
        <div className="transport">
          <Button
            variant="ghost"
            size="icon"
            aria-label={playing ? "Пауза" : "Відтворити монтаж"}
            onClick={toggle}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </Button>
          <span className="mono">{time(state.frame / FPS)}</span>
          <input
            aria-label="Позиція відтворення"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={state.frame}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <span className="mono">{time(total / FPS)}</span>
        </div>
      </div>
      <div className="timeline-panel">
        <div className="timeline-toolbar">
          <div className="row">
            <strong style={{ fontSize: 12 }}>Таймлайн</strong>
            <span className="pill gray">{state.clips.length} фрагм.</span>
          </div>
          <div className="row">
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() =>
                edit(splitAt(state.clips, state.frame, crypto.randomUUID()))
              }
            >
              <Scissors size={14} />
              Розрізати
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Видалити фрагмент"
              disabled={locked || state.clips.length <= 1}
              onClick={() =>
                edit(state.clips.filter((c) => c.id !== state.selected))
              }
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
        <div className="timeline-scroll">
          <div
            style={{ width: Math.max(total * PX, 300), position: "relative" }}
          >
            <div
              className="ruler"
              onClick={(e) =>
                seek(
                  Math.min(
                    total - 1,
                    Math.max(
                      0,
                      Math.round(
                        (e.clientX -
                          e.currentTarget.getBoundingClientRect().left) /
                          PX,
                      ),
                    ),
                  ),
                )
              }
            >
              {Array.from({ length: Math.floor(total / FPS) + 1 }, (_, i) => (
                <span
                  key={i}
                  className="ruler-label"
                  style={{ left: i * FPS * PX }}
                >
                  {time(i)}
                </span>
              ))}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => {
                if (e.over)
                  edit(
                    moveClip(
                      state.clips,
                      state.clips.findIndex((c) => c.id === e.active.id),
                      state.clips.findIndex((c) => c.id === e.over!.id),
                    ),
                  );
              }}
            >
              <SortableContext
                items={state.clips.map((c) => c.id)}
                strategy={horizontalListSortingStrategy}
              >
                <div className="track">
                  {state.clips.map((c) => (
                    <ClipBlock
                      key={c.id}
                      clip={c}
                      selected={c.id === state.selected}
                      locked={locked}
                      thumb={
                        urls[
                          scenes.find(
                            (s) =>
                              s.start_frame <= c.start && s.end_frame > c.start,
                          )?.thumbnail_path
                        ]
                      }
                      onSelect={() => store.getState().select(c.id)}
                      onTrim={(start, end) => trim(c.id, start, end)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            <div className="playhead" style={{ left: state.frame * PX }} />
          </div>
        </div>
        <div className="row between wrap" style={{ marginTop: 12 }}>
          <small className="row">
            <Save size={12} />
            {!editable ? "Версію заблоковано" : saveLabel}
          </small>
          <small>Перетягуйте фрагменти за ⠿ · змінюйте краї</small>
        </div>
      </div>
      {selected && (
        <div className="panel row wrap" style={{ marginTop: 14, padding: 16 }}>
          <strong style={{ fontSize: 12 }}>Обраний фрагмент</strong>
          <label style={{ width: 120 }}>
            Початок, кадр
            <input
              aria-label="Початок, кадр"
              type="number"
              min={0}
              max={selected.end - 1}
              value={selected.start}
              disabled={locked}
              onChange={(e) =>
                trim(selected.id, Number(e.target.value), selected.end)
              }
            />
          </label>
          <label style={{ width: 120, marginTop: 0 }}>
            Кінець, кадр
            <input
              aria-label="Кінець, кадр"
              type="number"
              min={selected.start + 1}
              max={asset.frames}
              value={selected.end}
              disabled={locked}
              onChange={(e) =>
                trim(selected.id, selected.start, Number(e.target.value))
              }
            />
          </label>
          <small>Кінцевий кадр не входить у фрагмент.</small>
        </div>
      )}
      {error && (
        <div role="alert" className="error" style={{ marginTop: 14 }}>
          {error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (conflicted.current) onRefresh();
              else void flush().catch(() => {});
            }}
          >
            <RotateCcw size={14} />
            {conflicted.current
              ? "Завантажити актуальну"
              : "Повторити збереження"}
          </Button>
        </div>
      )}
      <div className="row between" style={{ marginTop: 18 }}>
        <small>
          Монтаж доступний у статусі «У роботі». Попередні рендери зберігаються.
        </small>
        {editable && (
          <Button
            disabled={busy || !!error}
            onClick={async () => {
              setBusy(true);
              try {
                await flush();
                await onRender(
                  store.getState().revision,
                  workingVersion.current,
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Film size={15} />
            {busy ? "Запускаємо…" : "Рендерити версію"}
          </Button>
        )}
      </div>
    </div>
  );
}
