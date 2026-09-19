import { describe, expect, it } from "vitest";
import { IncrementalFrameParser, isCompleteInternalFrame } from "../src/protocol/frame-parser";

const frame = (nonce: string, payload: unknown) =>
  `<CCGUI_INTERNAL_${nonce}>${JSON.stringify(payload)}</CCGUI_INTERNAL_${nonce}>`;

const NONCE = "8f12c04e";

/**
 * Observed in a real OMP turn: the model emitted `append` as a sibling of
 * `patch` instead of inside it. The whole frame was rejected, so the turn
 * reduced as `semantic-update-missing` even though the intent was
 * unambiguous. Model output is untrusted but imperfect: one misplaced
 * top-level patch key must not discard the turn's semantic update.
 */
describe("frame tolerance for misplaced patch keys", () => {
  it("lifts a patch key emitted as a sibling of patch", () => {
    const payload = {
      plugin: "ccgui.client-context-bridge",
      version: 1,
      patch: { set: { goal: "Ship the merge" } },
      append: { completed: ["ported web dispatch"] },
    };
    const parser = new IncrementalFrameParser(NONCE);
    parser.push(`before ${frame(NONCE, payload)} after`);

    expect(parser.finish()).toEqual({
      visibleText: "before  after",
      patch: {
        set: { goal: "Ship the merge" },
        append: { completed: ["ported web dispatch"] },
      },
    });
  });

  it("accepts the same recovered frame through the host capture validator", () => {
    expect(
      isCompleteInternalFrame({
        plugin: "ccgui.client-context-bridge",
        version: 1,
        patch: { set: { goal: "Ship" } },
        remove: { completedIds: ["c1"] },
      }),
    ).toBe(true);
  });

  it("never lets a sibling key overwrite the same key inside patch", () => {
    const payload = {
      plugin: "ccgui.client-context-bridge",
      version: 1,
      patch: { append: { completed: ["authoritative"] } },
      append: { completed: ["stray"] },
    };
    const parser = new IncrementalFrameParser(NONCE);
    parser.push(frame(NONCE, payload));

    expect(parser.finish().patch).toEqual({ append: { completed: ["authoritative"] } });
  });

  it("still rejects a frame carrying genuinely unknown keys", () => {
    const payload = {
      plugin: "ccgui.client-context-bridge",
      version: 1,
      patch: { set: { goal: "Ship" } },
      notAPatchKey: { whatever: true },
    };
    const source = frame(NONCE, payload);
    const parser = new IncrementalFrameParser(NONCE);
    parser.push(source);

    expect(parser.finish()).toEqual({ visibleText: source, patch: null });
    expect(isCompleteInternalFrame(payload)).toBe(false);
  });
});
