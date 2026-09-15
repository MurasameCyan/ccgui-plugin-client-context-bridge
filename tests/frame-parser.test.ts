import { describe, expect, it } from "vitest";
import { IncrementalFrameParser } from "../src/protocol/frame-parser";

const frame = (nonce: string, payload: unknown) =>
  `<CCGUI_INTERNAL_${nonce}>${JSON.stringify(payload)}</CCGUI_INTERNAL_${nonce}>`;

describe("incremental nonce frame parser", () => {
  it("removes the last complete valid frame across arbitrary chunks", () => {
    const parser = new IncrementalFrameParser("8f12c04e");
    const text = `visible ${frame("8f12c04e", { plugin: "ccgui.client-context-bridge", version: 1, patch: { set: { goal: "Ship" } } })} done`;
    for (const chunk of [text.slice(0, 11), text.slice(11, 39), text.slice(39, 71), text.slice(71)]) {
      parser.push(chunk);
    }
    expect(parser.finish()).toEqual({
      visibleText: "visible  done",
      patch: { set: { goal: "Ship" } },
    });
  });

  it("keeps wrong-nonce, invalid, incomplete, and oversized frames visible", () => {
    const wrong = frame("deadbeef", { plugin: "ccgui.client-context-bridge", version: 1, patch: {} });
    const invalid = frame("8f12c04e", { plugin: "other", version: 1, patch: {} });
    const incomplete = '<CCGUI_INTERNAL_8f12c04e>{"plugin":';
    const oversized = frame("8f12c04e", { plugin: "ccgui.client-context-bridge", version: 1, patch: { set: { goal: "x".repeat(17 * 1024) } } });

    for (const source of [wrong, invalid, incomplete, oversized]) {
      const parser = new IncrementalFrameParser("8f12c04e");
      parser.push(source);
      expect(parser.finish()).toEqual({ visibleText: source, patch: null });
    }
  });

  it("accepts only the final complete valid frame", () => {
    const first = frame("8f12c04e", { plugin: "ccgui.client-context-bridge", version: 1, patch: { set: { goal: "old" } } });
    const last = frame("8f12c04e", { plugin: "ccgui.client-context-bridge", version: 1, patch: { set: { goal: "new" } } });
    const parser = new IncrementalFrameParser("8f12c04e");
    parser.push(first + "between" + last);
    expect(parser.finish()).toEqual({ visibleText: "between", patch: { set: { goal: "new" } } });
  });
});
