/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import type { MarkdownEditorApi } from "@reader/renderer/engine/editing/editor-api";
import Harness from "./DocumentEditorMountHarness.svelte";

describe("DocumentEditor mount", () => {
  it("does not rebuild when writing the outline makes the shell re-render", () => {
    const events: Array<"in" | "out"> = [];
    const target = document.createElement("div");
    document.body.append(target);
    const app = mount(Harness, {
      target,
      props: {
        onRegister: (api: MarkdownEditorApi | null) => {
          events.push(api === null ? "out" : "in");
        },
      },
    });
    flushSync();
    expect(events).toEqual(["in"]);
    unmount(app);
    target.remove();
  });
});
