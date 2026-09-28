import { describe, expect, it } from "vitest";
import {
  createCloseGate,
  onCloseAttempt,
  onFlushResult,
} from "../../../modules/notes/packages/desktop/src/main/close-gate";

describe("close gate", () => {
  it("does not wait for a flush when the renderer cannot receive it", () => {
    const gate = createCloseGate();
    expect(onCloseAttempt(gate, { asQuit: false, rendererReady: false })).toBe("proceed");
  });

  it("dedupes close and quit while a flush is in flight, remembering quit", () => {
    const gate = createCloseGate();
    expect(onCloseAttempt(gate, { asQuit: false, rendererReady: true })).toBe("prevent-and-send");
    expect(onCloseAttempt(gate, { asQuit: true, rendererReady: true })).toBe("prevent-quiet");
    expect(onFlushResult(gate, true)).toBe("quit");
  });

  it("stays open when the flush did not land a clean buffer", () => {
    const gate = createCloseGate();
    onCloseAttempt(gate, { asQuit: true, rendererReady: true });
    expect(onFlushResult(gate, false)).toBe("stay");
    expect(gate.quit).toBe(false);
    expect(onCloseAttempt(gate, { asQuit: false, rendererReady: true })).toBe("prevent-and-send");
  });
});
