/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { mathPlaceholderText, observeViewport } from "@reader/renderer/engine/rendering/viewport";

type IoCallback = (entries: IntersectionObserverEntry[]) => void;

let ioCallback: IoCallback | undefined;
let observed: Element[] = [];
let unobserved: Element[] = [];
const OriginalObserver = globalThis.IntersectionObserver;

class MockObserver {
  constructor(callback: IoCallback) {
    ioCallback = callback;
  }

  observe(el: Element): void {
    observed.push(el);
  }

  unobserve(el: Element): void {
    unobserved.push(el);
  }

  disconnect(): void {}
}

describe("mathPlaceholderText", () => {
  it("wraps inline and block tex so unreadied math stays readable", () => {
    expect(mathPlaceholderText("a+b", false)).toBe("$a+b$");
    expect(mathPlaceholderText("x^2", true)).toBe("$$x^2$$");
  });
});

describe("observeViewport", () => {
  afterEach(() => {
    ioCallback = undefined;
    observed = [];
    unobserved = [];
    globalThis.IntersectionObserver = OriginalObserver;
  });

  it("reports visibility from IntersectionObserver and stops after unsubscribe", () => {
    globalThis.IntersectionObserver = MockObserver as unknown as typeof IntersectionObserver;
    const el = document.createElement("span");
    const seen: boolean[] = [];
    const stop = observeViewport(el, (visible) => {
      seen.push(visible);
    });
    expect(observed).toEqual([el]);
    ioCallback?.([{ target: el, isIntersecting: true } as IntersectionObserverEntry]);
    ioCallback?.([{ target: el, isIntersecting: false } as IntersectionObserverEntry]);
    expect(seen).toEqual([true, false]);
    stop();
    expect(unobserved).toEqual([el]);
    ioCallback?.([{ target: el, isIntersecting: true } as IntersectionObserverEntry]);
    expect(seen).toEqual([true, false]);
  });
});
