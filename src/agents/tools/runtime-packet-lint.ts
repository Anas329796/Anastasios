import { isRecord } from "../../utils.js";

const SIDE_EFFECT_TASK_RE =
  /\b(add|apply|build|change|commit|create|delete|deploy|disable|edit|enable|fix|install|modify|move|patch|publish|remove|repair|restart|source|update|write)\b/i;

const READ_ONLY_TASK_RE =
  /\b(read-only|readonly|scan-only|dry-run|inspect|analy[sz]e|summari[sz]e|classify|list|status|audit|review|research)\b/i;

export type RuntimeExecutionPacketLintResult =
  | { ok: true; required: boolean; reason: string }
  | { ok: false; required: true; error: string };

export function taskTextRequiresRuntimeExecutionPacket(taskText: string): boolean {
  const text = taskText.trim();
  if (!text) {
    return false;
  }
  if (!SIDE_EFFECT_TASK_RE.test(text)) {
    return false;
  }
  // Explicitly read-only work can still mention risky words in the object being inspected.
  if (
    READ_ONLY_TASK_RE.test(text) &&
    /\b(no side effects|no-side-effect|do not modify|do not write|do not edit)\b/i.test(text)
  ) {
    return false;
  }
  return true;
}

function hasPacketObject(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const hasFoundation =
    isRecord(value.foundationRefs) ||
    isRecord(value.taskDoctrineRefs) ||
    typeof value.foundationConflictRule === "string";
  const hasConfidence = isRecord(value.confidenceLoop) || typeof value.confidenceLoop === "string";
  return hasFoundation && hasConfidence;
}

function hasEmbeddedPacketText(taskText: string): boolean {
  return (
    /foundationRefs\s*:/i.test(taskText) &&
    /confidenceLoop\s*:/i.test(taskText) &&
    /(vulnerabilityLedger|residualRiskPolicy|foundationConflictRule)\s*:/i.test(taskText)
  );
}

export function readRuntimeExecutionPacket(params: Record<string, unknown>): unknown {
  return params.executionPacket ?? params.runtimePacket ?? params.boundedExecutionPacket;
}

export function validateRuntimeExecutionPacket(params: {
  action: string;
  taskText: string;
  executionPacket?: unknown;
  required?: boolean;
}): RuntimeExecutionPacketLintResult {
  const required = params.required ?? taskTextRequiresRuntimeExecutionPacket(params.taskText);
  if (!required) {
    return { ok: true, required: false, reason: "packet not required for read-only/low-risk task" };
  }
  if (hasPacketObject(params.executionPacket)) {
    return { ok: true, required: true, reason: "executionPacket provided" };
  }
  if (hasEmbeddedPacketText(params.taskText)) {
    return { ok: true, required: true, reason: "execution packet embedded in task text" };
  }
  return {
    ok: false,
    required: true,
    error: `${params.action} requires an executionPacket for side-effectful delegated work. Include foundationRefs and confidenceLoop, or embed a bounded execution packet with foundationRefs/confidenceLoop in the task text.`,
  };
}
