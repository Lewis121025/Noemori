import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, createAutosave } from "@reader/renderer/document/autosave";

describe("createAutosave", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续输入每十秒保存一次，不能被每次按键无限推迟", async () => {
    vi.useFakeTimers();
    let dirty = false;
    const save = vi.fn(async () => {
      dirty = false;
    });
    const autosave = createAutosave({ isDirty: () => dirty, save });
    for (let second = 0; second < 60; second++) {
      dirty = true;
      autosave.touch();
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(Math.floor((second + 1) / 10));
    }
    autosave.dispose();
  });

  it("反复组词不重置最早编辑时间，超过期限后等确认才保存", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const autosave = createAutosave({ isDirty: () => true, save });
    for (let second = 0; second < 11; second++) {
      autosave.pause();
      autosave.touch();
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).not.toHaveBeenCalled();
      if (second < 9) autosave.resume();
    }
    autosave.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledOnce();
    autosave.dispose();
  });

  it("最长等待触发的保存仍串行，写盘中的新输入会再次保存", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let revision = 0;
    let saved = 0;
    const save = vi.fn(async () => {
      const captured = revision;
      if (save.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      saved = captured;
    });
    const autosave = createAutosave({ isDirty: () => revision !== saved, save });
    for (let second = 0; second < 30; second++) {
      revision++;
      autosave.touch();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save).toHaveBeenCalledOnce();
    release?.();
    await autosave.flush();
    expect(saved).toBe(revision);
    expect(save).toHaveBeenCalledTimes(2);
    autosave.dispose();
  });

  it("保存失败不空转重试，新输入和手动保存仍可继续", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const autosave = createAutosave({ isDirty: () => true, save });
    autosave.touch();
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledOnce();
    autosave.touch();
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(2);
    autosave.dispose();
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
