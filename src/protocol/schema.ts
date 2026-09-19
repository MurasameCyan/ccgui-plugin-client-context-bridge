export const CCB_FORMAT = "ccgui-client-context-bridge" as const;
export const CCB_SCHEMA_VERSION = 1 as const;
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_PATCH_BYTES = 16 * 1024;
export const MAX_ITEM_CHARS = 500;

export type EvidenceLevel = "host-observed" | "tool-reported" | "agent-reported" | "user-stated";
export type TurnStatus = "completed" | "cancelled" | "failed";

export interface CcbItem {
  id: string;
  text: string;
  source: EvidenceLevel;
  updatedAt: string;
}

export interface CcbDecision extends CcbItem {
  reason?: string;
}

export interface CcbChangedFile {
  path: string;
  change: "created" | "modified" | "deleted" | "touched" | "renamed" | "unknown";
  observedAt: string;
}

export interface CcbVerification {
  command: string;
  cwdHint?: string;
  exitCode: number | null;
  status: "passed" | "failed" | "cancelled" | "unknown";
  summary?: string;
  observedAt: string;
}

export interface CcbConsumption {
  targetEngine: string;
  targetSessionId: string;
  consumedRevision: number;
  consumedAt: string;
}

export interface CcbEnvelopeV1 {
  format: typeof CCB_FORMAT;
  schemaVersion: typeof CCB_SCHEMA_VERSION;
  workspaceId: string;
  revision: number;
  updatedAt: string;
  source: {
    engine: string;
    nativeSessionId?: string;
    turnId?: string;
    turnStatus: TurnStatus;
  };
  workspace: {
    rootHint?: string;
    gitBranch?: string;
    gitHead?: string;
    dirty?: boolean;
  };
  task: {
    goal?: string;
    acceptance: CcbItem[];
    constraints: CcbItem[];
    completed: CcbItem[];
    remaining: CcbItem[];
    decisions: CcbDecision[];
    risks: CcbItem[];
    nextAction?: CcbItem;
  };
  changes: { files: CcbChangedFile[] };
  verification: CcbVerification[];
  provenance: {
    lastHostObservationAt: string;
    lastSemanticUpdateAt?: string;
    degraded: boolean;
    degradedReasons: string[];
  };
  consumption: CcbConsumption[];
}

export interface SemanticPatch {
  set?: { goal?: string; nextAction?: string };
  append?: {
    acceptance?: string[];
    constraints?: string[];
    completed?: string[];
    remaining?: string[];
    decisions?: Array<{ summary: string; reason?: string }>;
    risks?: string[];
  };
  remove?: {
    acceptanceIds?: string[];
    constraintIds?: string[];
    completedIds?: string[];
    remainingIds?: string[];
    decisionIds?: string[];
    riskIds?: string[];
  };
}

export interface CreateEnvelopeInput {
  workspaceId: string;
  engine: string;
  turnStatus: TurnStatus;
  now: string;
}

export function createEmptyEnvelope(input: CreateEnvelopeInput): CcbEnvelopeV1 {
  return {
    format: CCB_FORMAT,
    schemaVersion: CCB_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    revision: 0,
    updatedAt: input.now,
    source: { engine: input.engine, turnStatus: input.turnStatus },
    workspace: {},
    task: {
      acceptance: [], constraints: [], completed: [], remaining: [], decisions: [], risks: [],
    },
    changes: { files: [] },
    verification: [],
    provenance: {
      lastHostObservationAt: input.now,
      degraded: false,
      degradedReasons: [],
    },
    consumption: [],
  };
}

/**
 * Identity of the task/fact content that `revision` tracks. Per-turn
 * provenance (`source.turnId`, `source.turnStatus`) is excluded on purpose:
 * both change on every single turn, so folding them in would make `revision` a
 * turn counter rather than a content revision, and every consumer that
 * compares revisions (the one-shot handoff guard, conflict merge) would drift
 * on turns that changed nothing.
 */
export function contentFingerprint(envelope: CcbEnvelopeV1): string {
  const { turnId: _turnId, turnStatus: _turnStatus, ...source } = envelope.source;
  return JSON.stringify({
    source,
    workspace: envelope.workspace,
    task: envelope.task,
    changes: envelope.changes,
    verification: envelope.verification,
    degraded: envelope.provenance.degraded,
    degradedReasons: envelope.provenance.degradedReasons,
  });
}

const ENVELOPE_KEYS = ["format", "schemaVersion", "workspaceId", "revision", "updatedAt", "source", "workspace", "task", "changes", "verification", "provenance", "consumption"] as const;
const TASK_KEYS = ["goal", "acceptance", "constraints", "completed", "remaining", "decisions", "risks", "nextAction"] as const;
export const PATCH_KEYS = ["set", "append", "remove"] as const;
const SET_KEYS = ["goal", "nextAction"] as const;
const APPEND_KEYS = ["acceptance", "constraints", "completed", "remaining", "decisions", "risks"] as const;
const REMOVE_KEYS = ["acceptanceIds", "constraintIds", "completedIds", "remainingIds", "decisionIds", "riskIds"] as const;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${name} contains unknown field: ${unknown}`);
}

function text(value: unknown, name: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  if ([...value].length > MAX_ITEM_CHARS) throw new Error(`${name} exceeds 500 characters`);
  return value;
}

function iso(value: unknown, name: string): string {
  const result = text(value, name);
  if (!result || !Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function parseItem(value: unknown, name: string, decision = false): CcbItem | CcbDecision {
  const item = record(value, name);
  exactKeys(item, decision ? ["id", "text", "source", "updatedAt", "reason"] : ["id", "text", "source", "updatedAt"], name);
  const source = item.source;
  if (!(["host-observed", "tool-reported", "agent-reported", "user-stated"] as unknown[]).includes(source)) throw new Error(`${name}.source is invalid`);
  const parsed: CcbDecision = {
    id: text(item.id, `${name}.id`)!,
    text: text(item.text, `${name}.text`)!,
    source: source as EvidenceLevel,
    updatedAt: iso(item.updatedAt, `${name}.updatedAt`),
  };
  if (decision && item.reason !== undefined) parsed.reason = text(item.reason, `${name}.reason`);
  return parsed;
}

function parseEnvelopeV1(value: unknown): CcbEnvelopeV1 {
  const root = record(value, "envelope");
  exactKeys(root, ENVELOPE_KEYS, "envelope");
  if (root.format !== CCB_FORMAT) throw new Error("format is invalid");
  if (root.schemaVersion !== CCB_SCHEMA_VERSION) throw new Error("schemaVersion is unsupported");
  if (!Number.isSafeInteger(root.revision) || (root.revision as number) < 0) throw new Error("revision is invalid");
  const source = record(root.source, "source");
  exactKeys(source, ["engine", "nativeSessionId", "turnId", "turnStatus"], "source");
  if (!(["completed", "cancelled", "failed"] as unknown[]).includes(source.turnStatus)) throw new Error("turnStatus is invalid");
  const workspace = record(root.workspace, "workspace");
  exactKeys(workspace, ["rootHint", "gitBranch", "gitHead", "dirty"], "workspace");
  const task = record(root.task, "task");
  exactKeys(task, TASK_KEYS, "task");
  const changes = record(root.changes, "changes");
  exactKeys(changes, ["files"], "changes");
  const provenance = record(root.provenance, "provenance");
  exactKeys(provenance, ["lastHostObservationAt", "lastSemanticUpdateAt", "degraded", "degradedReasons"], "provenance");

  const parsed = root as unknown as CcbEnvelopeV1;
  text(parsed.workspaceId, "workspaceId");
  iso(parsed.updatedAt, "updatedAt");
  text(source.engine, "source.engine");
  for (const optional of [source.nativeSessionId, source.turnId, workspace.rootHint, workspace.gitBranch, workspace.gitHead]) if (optional !== undefined) text(optional, "optional string");
  if (source.nativeSessionId !== undefined && typeof source.nativeSessionId !== "string") throw new Error("source.nativeSessionId is invalid");
  if (source.turnId !== undefined && typeof source.turnId !== "string") throw new Error("source.turnId is invalid");
  if (workspace.dirty !== undefined && typeof workspace.dirty !== "boolean") throw new Error("workspace.dirty is invalid");
  if (task.goal !== undefined) text(task.goal, "task.goal");
  for (const required of ["acceptance", "constraints", "completed", "remaining", "decisions", "risks"]) if (!(required in task)) throw new Error(`task.${required} is required`);
  for (const key of ["acceptance", "constraints", "completed", "remaining", "risks"] as const) array(task[key], `task.${key}`).forEach((item, i) => parseItem(item, `${key}[${i}]`));
  array(task.decisions, "task.decisions").forEach((item, i) => parseItem(item, `decisions[${i}]`, true));
  if (task.nextAction !== undefined) parseItem(task.nextAction, "task.nextAction");
  array(changes.files, "changes.files").forEach((value, index) => {
    const file = record(value, `changes.files[${index}]`);
    exactKeys(file, ["path", "change", "observedAt"], `changes.files[${index}]`);
    text(file.path, `changes.files[${index}].path`);
    if (!(["created", "modified", "deleted", "touched", "renamed", "unknown"] as unknown[]).includes(file.change)) throw new Error(`changes.files[${index}].change is invalid`);
    iso(file.observedAt, `changes.files[${index}].observedAt`);
  });
  array(root.verification, "verification").forEach((value, index) => {
    const verification = record(value, `verification[${index}]`);
    exactKeys(verification, ["command", "cwdHint", "exitCode", "status", "summary", "observedAt"], `verification[${index}]`);
    text(verification.command, `verification[${index}].command`);
    if (verification.cwdHint !== undefined) text(verification.cwdHint, `verification[${index}].cwdHint`);
    if (verification.exitCode !== null && !Number.isSafeInteger(verification.exitCode)) throw new Error(`verification[${index}].exitCode is invalid`);
    if (!(["passed", "failed", "cancelled", "unknown"] as unknown[]).includes(verification.status)) throw new Error(`verification[${index}].status is invalid`);
    if (verification.summary !== undefined) text(verification.summary, `verification[${index}].summary`);
    iso(verification.observedAt, `verification[${index}].observedAt`);
  });
  if (typeof provenance.degraded !== "boolean") throw new Error("provenance.degraded is invalid");
  if (!("lastHostObservationAt" in provenance) || !("degraded" in provenance) || !("degradedReasons" in provenance)) throw new Error("provenance is incomplete");
  array(provenance.degradedReasons, "degradedReasons").forEach((reason) => text(reason, "degraded reason"));
  iso(provenance.lastHostObservationAt, "lastHostObservationAt");
  if (provenance.lastSemanticUpdateAt !== undefined) iso(provenance.lastSemanticUpdateAt, "lastSemanticUpdateAt");
  array(root.consumption, "consumption").forEach((value, index) => {
    const consumption = record(value, `consumption[${index}]`);
    exactKeys(consumption, ["targetEngine", "targetSessionId", "consumedRevision", "consumedAt"], `consumption[${index}]`);
    text(consumption.targetEngine, `consumption[${index}].targetEngine`);
    text(consumption.targetSessionId, `consumption[${index}].targetSessionId`);
    if (!Number.isSafeInteger(consumption.consumedRevision) || (consumption.consumedRevision as number) < 0) throw new Error(`consumption[${index}].consumedRevision is invalid`);
    iso(consumption.consumedAt, `consumption[${index}].consumedAt`);
  });
  return parsed;
}

export function migrateCcbEnvelope(value: unknown): unknown {
  const root = record(value, "envelope");
  if (root.schemaVersion === CCB_SCHEMA_VERSION) return value;
  throw new Error(`schemaVersion ${String(root.schemaVersion)} is unsupported`);
}

export interface ParseEnvelopeOptions {
  migrate?: (value: unknown) => unknown;
}

export function parseCcbEnvelope(content: string, options: ParseEnvelopeOptions = {}): CcbEnvelopeV1 {
  if (new TextEncoder().encode(content).byteLength > MAX_DOCUMENT_BYTES) throw new Error("CCB document exceeds 64 KB");
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("CCB document is not valid JSON"); }
  const candidate = options.migrate ? options.migrate(value) : migrateCcbEnvelope(value);
  return parseEnvelopeV1(candidate);
}

export function parseSemanticPatch(value: unknown): SemanticPatch {
  const root = record(value, "patch");
  exactKeys(root, PATCH_KEYS, "patch");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PATCH_BYTES) throw new Error("patch exceeds 16 KB");
  if (root.set !== undefined) {
    const set = record(root.set, "set");
    exactKeys(set, SET_KEYS, "set");
    for (const key of SET_KEYS) if (set[key] !== undefined) text(set[key], `set.${key}`);
  }
  if (root.append !== undefined) {
    const append = record(root.append, "append");
    exactKeys(append, APPEND_KEYS, "append");
    for (const key of APPEND_KEYS) {
      if (append[key] === undefined) continue;
      const values = array(append[key], `append.${key}`);
      if (key === "decisions") {
        values.forEach((entry, i) => {
          const decision = record(entry, `decision[${i}]`);
          exactKeys(decision, ["summary", "reason"], `decision[${i}]`);
          text(decision.summary, `decision[${i}].summary`);
          if (decision.reason !== undefined) text(decision.reason, `decision[${i}].reason`);
        });
      } else values.forEach((entry, i) => text(entry, `${key}[${i}]`));
    }
  }
  if (root.remove !== undefined) {
    const remove = record(root.remove, "remove");
    exactKeys(remove, REMOVE_KEYS, "remove");
    for (const key of REMOVE_KEYS) if (remove[key] !== undefined) array(remove[key], `remove.${key}`).forEach((id, i) => text(id, `${key}[${i}]`));
  }
  return value as SemanticPatch;
}
