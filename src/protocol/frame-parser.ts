import { MAX_PATCH_BYTES, parseSemanticPatch, type SemanticPatch } from "./schema";

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
          if (isFrameEnvelope(parsed)) complete.push({ start, end, patch: parseSemanticPatch(parsed.patch) });
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

function isFrameEnvelope(value: unknown): value is { plugin: string; version: number; patch: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame);
  return keys.length === 3
    && keys.every((key) => key === "plugin" || key === "version" || key === "patch")
    && frame.plugin === PLUGIN_ID
    && frame.version === 1;
}

/**
 * Synchronous validator handed to the host's internal-frame capture so that
 * JSON-parseable but schema-invalid frames stay user-visible instead of being
 * hidden. Accepts only a well-formed CCB frame carrying a valid semantic patch.
 */
export function isCompleteInternalFrame(payload: unknown): boolean {
  if (!isFrameEnvelope(payload)) return false;
  try {
    parseSemanticPatch(payload.patch);
    return true;
  } catch {
    return false;
  }
}
