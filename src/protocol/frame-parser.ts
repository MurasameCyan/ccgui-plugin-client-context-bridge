import { MAX_PATCH_BYTES, PATCH_KEYS, parseSemanticPatch, type SemanticPatch } from "./schema";

const PLUGIN_ID = "ccgui.client-context-bridge";

export interface FrameParseResult {
  visibleText: string;
  patch: SemanticPatch | null;
}

interface Candidate {
  start: number;
  end: number;
  patch: SemanticPatch;
}

export class IncrementalFrameParser {
  private readonly opening: string;
  private readonly closing: string;
  private source = "";

  constructor(nonce: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) throw new Error("nonce has an invalid format");
    this.opening = `<CCGUI_INTERNAL_${nonce}>`;
    this.closing = `</CCGUI_INTERNAL_${nonce}>`;
  }

  push(chunk: string): void {
    this.source += chunk;
  }

  finish(): FrameParseResult {
    const complete: Candidate[] = [];
    let searchFrom = 0;
    while (searchFrom < this.source.length) {
      const start = this.source.indexOf(this.opening, searchFrom);
      if (start < 0) break;
      const payloadStart = start + this.opening.length;
      const close = this.source.indexOf(this.closing, payloadStart);
      if (close < 0) break;
      const end = close + this.closing.length;
      const rawPayload = this.source.slice(payloadStart, close);
      if (new TextEncoder().encode(rawPayload).byteLength <= MAX_PATCH_BYTES) {
        try {
          const parsed = JSON.parse(rawPayload) as unknown;
          const normalized = normalizedFramePatch(parsed);
          if (normalized) complete.push({ start, end, patch: parseSemanticPatch(normalized.patch) });
        } catch {
          // Invalid frames remain user-visible by design.
        }
      }
      searchFrom = end;
    }

    if (complete.length === 0) return { visibleText: this.source, patch: null };
    const accepted = complete[complete.length - 1]!;
    const hidden = complete.map((candidate) => [candidate.start, candidate.end] as const);
    let visibleText = "";
    let cursor = 0;
    for (const [start, end] of hidden) {
      visibleText += this.source.slice(cursor, start);
      cursor = end;
    }
    visibleText += this.source.slice(cursor);
    return { visibleText, patch: accepted.patch };
  }
}

/**
 * A CCB frame's patch, with misplaced patch keys lifted into `patch`.
 *
 * Model output is untrusted but imperfect: a real OMP turn emitted `append`
 * as a sibling of `patch` rather than inside it, so the whole frame was
 * discarded and the turn reduced as `semantic-update-missing` despite an
 * unambiguous intent. Recover that shape, but keep two guarantees: `patch`
 * stays authoritative (a stray sibling never overwrites a key it already
 * carries), and a frame bearing any genuinely unknown key is still refused
 * so it remains user-visible.
 */
export function normalizedFramePatch(value: unknown): { patch: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.plugin !== PLUGIN_ID || frame.version !== 1 || !("patch" in frame)) return null;
  let patch = frame.patch;
  for (const key of Object.keys(frame)) {
    if (key === "plugin" || key === "version" || key === "patch") continue;
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return null;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
    const inner = patch as Record<string, unknown>;
    if (key in inner) continue;
    patch = { ...inner, [key]: frame[key] };
  }
  return { patch };
}

/**
 * Synchronous validator handed to the host's internal-frame capture so that
 * JSON-parseable but schema-invalid frames stay user-visible instead of being
 * hidden. Accepts only a well-formed CCB frame carrying a valid semantic patch.
 */
export function isCompleteInternalFrame(payload: unknown): boolean {
  const normalized = normalizedFramePatch(payload);
  if (!normalized) return false;
  try {
    parseSemanticPatch(normalized.patch);
    return true;
  } catch {
    return false;
  }
}
