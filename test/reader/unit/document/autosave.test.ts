import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, createAutosave } from "@reader/renderer/engine/document/autosave";

describe("createAutosave", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves once after idle delay from the last touch", async () => {
    vi.useFakeTimers();
    let saves = 0;
    let dirty = true;
    const autosave = createAutosave({
      isDirty: () => dirty,
      save: async () => {
        saves += 1;
        dirty = false;
      },
    });
    autosave.touch();
    autosave.touch();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(saves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toBe(1);
    autosave.dispose();
  });

  it("flush saves immediately and cancels the idle timer", async () => {
    vi.useFakeTimers();
    let saves = 0;
    let dirty = true;
    const autosave = createAutosave({
      isDirty: () => dirty,
      save: async () => {
        saves += 1;
        dirty = false;
      },
    });
    autosave.touch();
    await autosave.flush();
    expect(saves).toBe(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(saves).toBe(1);
    autosave.dispose();
  });

  it("touch during an in-flight save restarts idle from that touch", async () => {
    vi.useFakeTimers();
    let saves = 0;
    let dirty = true;
    let finish: (() => void) | undefined;
    const autosave = createAutosave({
      isDirty: () => dirty,
      save: () =>
        new Promise<void>((resolve) => {
          saves += 1;
          finish = resolve;
        }),
    });
    autosave.touch();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(saves).toBe(1);
    autosave.touch();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(saves).toBe(1);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(saves).toBe(2);
    finish?.();
    autosave.dispose();
  });

  it("flush waits for an in-flight save then writes again if still dirty", async () => {
    vi.useFakeTimers();
    let saves = 0;
    let dirty = true;
    let releaseFirst: (() => void) | undefined;
    const autosave = createAutosave({
      isDirty: () => dirty,
      save: () => {
        saves += 1;
        if (saves === 1) {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        dirty = false;
        return Promise.resolve();
      },
    });
    autosave.touch();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const flushed = autosave.flush();
    releaseFirst?.();
    await flushed;
    expect(saves).toBe(2);
    autosave.dispose();
  });
});
