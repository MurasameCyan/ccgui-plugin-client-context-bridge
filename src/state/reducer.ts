import {
  MAX_DOCUMENT_BYTES,
  MAX_ITEM_CHARS,
  contentFingerprint,
  type CcbChangedFile,
  type CcbConsumption,
  type CcbDecision,
  type CcbEnvelopeV1,
  type CcbItem,
  type CcbVerification,
  type EvidenceLevel,
  type SemanticPatch,
} from "../protocol/schema";

const LIMITS = {
  acceptance: 20,
  constraints: 20,
  completed: 20,
  remaining: 12,
  decisions: 20,
  risks: 12,
  verification: 10,
  files: 100,
  // Bookkeeping rows must stay bounded: every cross-client handoff adds one,
  // and `enforceByteBudget` would otherwise start dropping the task content
  // the handoff exists to carry in order to keep them.
  consumption: 50,
} as const;

const EVIDENCE_RANK: Record<EvidenceLevel, number> = {
  "agent-reported": 0,
  "tool-reported": 1,
  "host-observed": 2,
  "user-stated": 3,
};

/**
 * A `touched`/`unknown` file record only asserts that a mutating tool targeted
 * the path; it does not assert created/modified/deleted. Rank those below the
 * committed change kinds so a later weak observation cannot downgrade a path
 * whose change the engine already stated.
 */
const FILE_CHANGE_RANK: Record<CcbChangedFile["change"], number> = {
  touched: 0,
  unknown: 0,
  created: 1,
  modified: 1,
  deleted: 1,
  renamed: 1,
};

/**
 * A `command-started` observation only proves the engine invoked the command; it
 * carries no exit code. Rank it below the resolved outcomes so a later weak
 * record cannot downgrade a command whose result the engine already stated.
 */
const VERIFICATION_STATUS_RANK: Record<CcbVerification["status"], number> = {
  unknown: 0,
  passed: 1,
  failed: 1,
  cancelled: 1,
};

const REMOVE_FIELD_BY_COLLECTION = {
  acceptance: "acceptanceIds",
  constraints: "constraintIds",
  completed: "completedIds",
  remaining: "remainingIds",
  risks: "riskIds",
} as const;

export interface HostFacts {
  changedFiles?: CcbChangedFile[];
  verification?: CcbVerification[];
  items?: Partial<Record<"acceptance" | "constraints" | "completed" | "remaining" | "risks", CcbItem[]>>;
  decisions?: CcbDecision[];
  source?: Partial<CcbEnvelopeV1["source"]>;
  workspace?: Partial<CcbEnvelopeV1["workspace"]>;
}

export interface ReduceInput {
  now: string;
  patch?: SemanticPatch | null;
  facts?: HostFacts;
  consumption?: CcbConsumption;
}

export function reduceContext(base: CcbEnvelopeV1, input: ReduceInput): CcbEnvelopeV1 {
  const next = structuredClone(base);
  if (input.consumption && input.patch === undefined && input.facts === undefined) {
    upsertConsumption(next, input.consumption);
    return next;
  }

  const before = contentFingerprint(next);
  if (input.patch === null) addDegraded(next, "semantic-update-missing");
  if (input.patch) applyPatch(next, input.patch, input.now);
  if (input.facts) applyFacts(next, input.facts);
  enforceLimits(next);
  if (input.consumption) upsertConsumption(next, input.consumption);
  if (input.patch) {
    next.provenance.lastSemanticUpdateAt = input.now;
    removeDegraded(next, "semantic-update-missing");
  }
  enforceByteBudget(next);
  const changed = before !== contentFingerprint(next);
  if (changed) {
    next.updatedAt = input.now;
    if (input.facts) next.provenance.lastHostObservationAt = input.now;
  }
  if (changed) next.revision = base.revision + 1;
  return next;
}

function applyPatch(next: CcbEnvelopeV1, patch: SemanticPatch, now: string): void {
  if (patch.set?.goal !== undefined) next.task.goal = clampText(patch.set.goal);
  if (patch.set?.nextAction !== undefined) {
    const incoming = semanticItem(patch.set.nextAction, "next-action", now);
    if (!next.task.nextAction || EVIDENCE_RANK[incoming.source] >= EVIDENCE_RANK[next.task.nextAction.source]) next.task.nextAction = incoming;
  }

  const collections = ["acceptance", "constraints", "completed", "remaining", "risks"] as const;
  for (const key of collections) {
    const removeKey = REMOVE_FIELD_BY_COLLECTION[key];
    const requestedRemovals = new Set(patch.remove?.[removeKey] ?? []);
    next.task[key] = next.task[key].filter((item) => !requestedRemovals.has(item.id) || EVIDENCE_RANK[item.source] >= EVIDENCE_RANK["host-observed"]);
    for (const value of patch.append?.[key] ?? []) mergeItem(next.task[key], semanticItem(value, key, now));
  }

  const decisionRemovals = new Set(patch.remove?.decisionIds ?? []);
  next.task.decisions = next.task.decisions.filter((item) => !decisionRemovals.has(item.id) || EVIDENCE_RANK[item.source] >= EVIDENCE_RANK["host-observed"]);
  for (const decision of patch.append?.decisions ?? []) {
    mergeItem(next.task.decisions, {
      ...semanticItem(decision.summary, "decision", now),
      ...(decision.reason ? { reason: clampText(decision.reason) } : {}),
    });
  }
}

function applyFacts(next: CcbEnvelopeV1, facts: HostFacts): void {
  if (facts.source) next.source = { ...next.source, ...clampStrings(facts.source) };
  if (facts.workspace) next.workspace = { ...next.workspace, ...clampStrings(facts.workspace) };
  for (const key of ["acceptance", "constraints", "completed", "remaining", "risks"] as const) {
    for (const item of facts.items?.[key] ?? []) mergeItem(next.task[key], clampStrings(item));
  }
  for (const decision of facts.decisions ?? []) mergeItem(next.task.decisions, clampStrings(decision));
  for (const file of facts.changedFiles ?? []) mergeChangedFile(next.changes.files, clampStrings(file));
  for (const verification of facts.verification ?? []) mergeVerification(next.verification, clampStrings(verification));
}

/**
 * Host facts bypass `parseSemanticPatch`, so an over-long command, path, or item
 * would otherwise fail schema validation at serialize time and pin the workspace
 * into permanent write failure. Truncate to the schema's per-item limit instead.
 */
function clampStrings<T extends object>(value: T): T {
  const result = { ...value } as Record<string, unknown>;
  for (const [key, entry] of Object.entries(result)) if (typeof entry === "string") result[key] = clampText(entry);
  return result as T;
}

function clampText(value: string, limit = MAX_ITEM_CHARS): string {
  const characters = [...value];
  if (characters.length <= limit) return value;
  const suffix = `…#${fingerprint(value)}`;
  return `${characters.slice(0, limit - suffix.length).join("")}${suffix}`;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function semanticItem(value: string, category: string, now: string): CcbItem {
  return { id: stableId(category, value), text: clampText(value), source: "agent-reported", updatedAt: now };
}

function stableId(category: string, value: string): string {
  return `${category}-${fingerprint(`${category}\0${value.trim().toLocaleLowerCase()}`)}`;
}

function mergeItem<T extends CcbItem>(items: T[], incoming: T): void {
  const byId = items.findIndex((item) => item.id === incoming.id);
  const byText = items.findIndex((item) => item.text.trim().toLocaleLowerCase() === incoming.text.trim().toLocaleLowerCase());
  const index = byId >= 0 ? byId : byText;
  if (index < 0) items.push(incoming);
  else if (EVIDENCE_RANK[incoming.source] >= EVIDENCE_RANK[items[index]!.source]) items[index] = incoming;
}

function mergeBy<T>(items: T[], incoming: T, key: (value: T) => string): void {
  const index = items.findIndex((item) => key(item) === key(incoming));
  if (index < 0) items.push(incoming);
  else items[index] = incoming;
}

/**
 * Files merge by path (stable id), and a weaker incoming change never replaces
 * a stronger known one for that path; equal rank keeps the later observation.
 */
function mergeChangedFile(files: CcbChangedFile[], incoming: CcbChangedFile): void {
  const index = files.findIndex((file) => file.path === incoming.path);
  if (index < 0) {
    files.push(incoming);
    return;
  }
  if (FILE_CHANGE_RANK[incoming.change] >= FILE_CHANGE_RANK[files[index]!.change]) files[index] = incoming;
}

/**
 * Verifications merge by command and working directory: one command in one cwd
 * is one verification record regardless of how many events observed it. A later
 * record replaces the stored one only when its status outranks it, so an
 * unknown-outcome `command-started` observation never erases a resolved result.
 */
function mergeVerification(verification: CcbVerification[], incoming: CcbVerification): void {
  const index = verification.findIndex((value) => verificationKey(value) === verificationKey(incoming));
  if (index < 0) {
    verification.push(incoming);
    return;
  }
  if (VERIFICATION_STATUS_RANK[incoming.status] >= VERIFICATION_STATUS_RANK[verification[index]!.status]) verification[index] = incoming;
}

function verificationKey(value: CcbVerification): string {
  return `${value.command}\0${value.cwdHint ?? ""}`;
}

function enforceLimits(next: CcbEnvelopeV1): void {
  for (const key of ["acceptance", "constraints", "completed", "remaining", "risks"] as const) {
    next.task[key] = prioritize(next.task[key]).slice(0, LIMITS[key]);
  }
  next.task.decisions = prioritize(next.task.decisions).slice(0, LIMITS.decisions);
  next.changes.files = next.changes.files.slice(-LIMITS.files);
  next.verification = next.verification.slice(-LIMITS.verification);
}

function prioritize<T extends CcbItem>(items: T[]): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => EVIDENCE_RANK[b.item.source] - EVIDENCE_RANK[a.item.source] || a.index - b.index).map(({ item }) => item);
}

const BYTE_BUDGET = MAX_DOCUMENT_BYTES - 1024;

function enforceByteBudget(next: CcbEnvelopeV1): void {
  if (serializedBytes(next) <= BYTE_BUDGET) return;
  const droppers: Array<() => boolean> = [
    () => next.verification.pop() !== undefined,
    () => next.changes.files.pop() !== undefined,
    () => next.task.decisions.pop() !== undefined,
    () => next.task.risks.pop() !== undefined,
    () => next.task.constraints.pop() !== undefined,
    () => next.task.completed.pop() !== undefined,
    () => next.task.acceptance.pop() !== undefined,
    () => next.task.remaining.pop() !== undefined,
    // Last resort: dropping a consumption row unhides a handoff the target
    // session already consumed, re-injecting it on the next switch.
    () => next.consumption.pop() !== undefined,
  ];
  while (serializedBytes(next) > BYTE_BUDGET) {
    const drop = droppers.find((candidate) => {
      const before = serializedBytes(next);
      return candidate() && serializedBytes(next) < before;
    });
    if (!drop) break;
  }
  addDegraded(next, "document-size-trimmed");
}

/**
 * The writer validates the exact bytes it stores, which are the pretty-printed
 * JSON produced by `ContextStore`. Budgeting the compact form would let a
 * document through the reducer that the writer then rejects forever.
 */
function serializedBytes(value: CcbEnvelopeV1): number {
  return new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength;
}

function addDegraded(next: CcbEnvelopeV1, reason: string): void {
  next.provenance.degraded = true;
  if (!next.provenance.degradedReasons.includes(reason)) next.provenance.degradedReasons.push(reason);
}

function removeDegraded(next: CcbEnvelopeV1, reason: string): void {
  next.provenance.degradedReasons = next.provenance.degradedReasons.filter((entry) => entry !== reason);
  next.provenance.degraded = next.provenance.degradedReasons.length > 0;
}

function upsertConsumption(next: CcbEnvelopeV1, consumption: CcbConsumption): void {
  const key = (entry: CcbConsumption) => `${entry.targetEngine}\0${entry.targetSessionId}`;
  mergeBy(next.consumption, consumption, key);
  // Trim here rather than in `enforceLimits`: the consumption-only path skips
  // that pass entirely, and rows are upserted after it on the full path.
  // `mergeBy` appends, so the tail is the newest. Evicting the oldest row can
  // re-offer a handoff to a long-idle session — strictly better than losing
  // the context itself.
  if (next.consumption.length > LIMITS.consumption) {
    next.consumption = next.consumption.slice(-LIMITS.consumption);
  }
}
