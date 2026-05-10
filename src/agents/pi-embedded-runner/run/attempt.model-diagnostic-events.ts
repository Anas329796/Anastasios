import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import type { DiagnosticContentCapturePolicy } from "../../../infra/diagnostic-content-capture.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticProviderRequestIdHash,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
  type DiagnosticMemoryUsage,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../../plugins/hook-types.js";

export { diagnosticErrorCategory };

type ModelCallContentCapturePolicy = Pick<
  DiagnosticContentCapturePolicy,
  "inputMessages" | "outputMessages"
>;

type ModelCallDiagnosticContext = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  trace: DiagnosticTraceContext;
  nextCallId: () => string;
  onStarted?: () => void;
  contentCapture: ModelCallContentCapturePolicy;
};

type ModelCallEventBase = Omit<
  Extract<DiagnosticEventInput, { type: "model.call.started" }>,
  "type"
>;
type ModelCallErrorFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.error" }>,
  "errorCategory" | "failureKind" | "memory" | "upstreamRequestIdHash"
>;
type ModelCallEndedHookFields = Pick<
  PluginHookModelCallEndedEvent,
  | "durationMs"
  | "outcome"
  | "errorCategory"
  | "requestPayloadBytes"
  | "responseStreamBytes"
  | "timeToFirstByteMs"
  | "failureKind"
  | "upstreamRequestIdHash"
>;
type ModelCallSizeTimingFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.completed" }>,
  "requestPayloadBytes" | "responseStreamBytes" | "timeToFirstByteMs"
>;
type ModelCallObservationState = {
  requestPayloadBytes?: number;
  responseStreamBytes: number;
  timeToFirstByteMs?: number;
  inputMessages?: string[];
  outputTextChunks: string[];
};

const MODEL_CALL_STREAM_RETURN_TIMEOUT_MS = 1000;
const TRACEPARENT_HEADER_NAME = "traceparent";
type ModelCallStreamOptions = Parameters<StreamFn>[2];

function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function assignRequestPayloadBytes(state: ModelCallObservationState, payload: unknown): void {
  const bytes = utf8JsonByteLength(payload);
  if (bytes !== undefined) {
    state.requestPayloadBytes = bytes;
  }
}

function observeResponseChunk(
  state: ModelCallObservationState,
  startedAt: number,
  chunk: unknown,
  contentCapture: ModelCallContentCapturePolicy,
): void {
  state.timeToFirstByteMs ??= Math.max(0, Date.now() - startedAt);
  const bytes = utf8JsonByteLength(chunk);
  if (bytes !== undefined) {
    state.responseStreamBytes += bytes;
  }
  if (!contentCapture.outputMessages) {
    return;
  }
  const text = extractTextFromChunk(chunk);
  if (text) {
    state.outputTextChunks.push(text);
  }
}

/**
 * Extract text content from a streamed response chunk.
 * Handles three formats:
 * 1. Normalized provider chunks: { type: "text_delta", delta: "..." }
 * 2. OpenAI chat completion stream format: { choices: [{ delta: { content: "..." } }] }
 * 3. OpenAI responses API stream format: { type: "response.output_text.delta", delta: "..." }
 */
function extractTextFromChunk(chunk: unknown): string | undefined {
  if (typeof chunk !== "object" || chunk === null) {
    return undefined;
  }
  const obj = chunk as Record<string, unknown>;

  // Normalized provider stream format: { type: "text_delta", delta: "..." }
  // Used by OpenAI WS, Anthropic, and other providers after normalization.
  if (obj.type === "text_delta" && typeof obj.delta === "string" && obj.delta.length > 0) {
    return obj.delta;
  }

  // Non-streaming normalized format: { type: "text", text: "..." }
  if (obj.type === "text" && typeof obj.text === "string" && obj.text.length > 0) {
    return obj.text;
  }

  // OpenAI chat completion stream format: { choices: [{ delta: { content: "..." } }] }
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = (choices[0] as Record<string, unknown>)?.delta;
    if (typeof delta === "object" && delta !== null) {
      const content = (delta as Record<string, unknown>).content;
      if (typeof content === "string" && content.length > 0) {
        return content;
      }
    }
  }

  // OpenAI responses API stream format: { type: "response.output_text.delta", delta: "..." }
  if (
    obj.type === "response.output_text.delta" &&
    typeof obj.delta === "string" &&
    obj.delta.length > 0
  ) {
    return obj.delta;
  }

  return undefined;
}

/**
 * Extract input message texts from a model request payload.
 * Handles OpenAI chat completions format ({ messages: [...] })
 * and responses API format ({ input: [...] }).
 * Returns an array of message content strings for content capture.
 */
function extractInputMessages(model: unknown): string[] {
  if (typeof model !== "object" || model === null) {
    return [];
  }
  const obj = model as Record<string, unknown>;
  const messages: string[] = [];

  // OpenAI chat completions: { messages: [{ role, content }] }
  const chatMessages = obj.messages;
  if (Array.isArray(chatMessages)) {
    for (const msg of chatMessages) {
      if (typeof msg === "object" && msg !== null) {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string" && content.length > 0) {
          messages.push(content);
        } else if (Array.isArray(content)) {
          // Multimodal content: extract text parts
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              (part as Record<string, unknown>).type === "text"
            ) {
              const text = (part as Record<string, unknown>).text;
              if (typeof text === "string" && text.length > 0) {
                messages.push(text);
              }
            }
          }
        }
      }
    }
    return messages;
  }

  // OpenAI responses API: { input: [{ role, content }] } or { input: "string" }
  const input = obj.input;
  if (typeof input === "string" && input.length > 0) {
    messages.push(input);
    return messages;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "object" && item !== null) {
        const content = (item as Record<string, unknown>).content;
        if (typeof content === "string" && content.length > 0) {
          messages.push(content);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              (part as Record<string, unknown>).type === "input_text"
            ) {
              const text = (part as Record<string, unknown>).text;
              if (typeof text === "string" && text.length > 0) {
                messages.push(text);
              }
            }
          }
        }
      }
    }
    return messages;
  }

  return messages;
}

/**
 * Extract output text from a non-streaming model call result.
 * Handles OpenAI chat completions format ({ choices: [{ message: { content } }] })
 * and responses API format ({ output: [{ content: [{ text }] }] }).
 */
function extractOutputFromResult(result: unknown): string[] {
  if (typeof result !== "object" || result === null) {
    return [];
  }
  const obj = result as Record<string, unknown>;
  const messages: string[] = [];

  // OpenAI chat completions: { choices: [{ message: { content: "..." } }] }
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown>)?.message;
    if (typeof message === "object" && message !== null) {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string" && content.length > 0) {
        messages.push(content);
      }
    }
    return messages;
  }

  // OpenAI responses API: { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
  const output = obj.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === "object" && item !== null) {
        const content = (item as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              (part as Record<string, unknown>).type === "output_text"
            ) {
              const text = (part as Record<string, unknown>).text;
              if (typeof text === "string" && text.length > 0) {
                messages.push(text);
              }
            }
          }
        }
      }
    }
    return messages;
  }

  return messages;
}

function modelCallSizeTimingFields(state: ModelCallObservationState): ModelCallSizeTimingFields {
  return {
    ...(state.requestPayloadBytes !== undefined
      ? { requestPayloadBytes: state.requestPayloadBytes }
      : {}),
    ...(state.responseStreamBytes > 0 ? { responseStreamBytes: state.responseStreamBytes } : {}),
    ...(state.timeToFirstByteMs !== undefined
      ? { timeToFirstByteMs: state.timeToFirstByteMs }
      : {}),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

function asyncIteratorFactory(value: unknown): (() => AsyncIterator<unknown>) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof asyncIterator !== "function") {
      return undefined;
    }
    return () => asyncIterator.call(value) as AsyncIterator<unknown>;
  } catch {
    return undefined;
  }
}

function baseModelCallEvent(
  ctx: ModelCallDiagnosticContext,
  callId: string,
  trace: DiagnosticTraceContext,
): ModelCallEventBase {
  return {
    runId: ctx.runId,
    callId,
    ...(ctx.sessionKey && { sessionKey: ctx.sessionKey }),
    ...(ctx.sessionId && { sessionId: ctx.sessionId }),
    provider: ctx.provider,
    model: ctx.model,
    ...(ctx.api && { api: ctx.api }),
    ...(ctx.transport && { transport: ctx.transport }),
    trace,
  };
}

function modelCallErrorFields(err: unknown): ModelCallErrorFields {
  const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
  const failureKind = diagnosticErrorFailureKind(err);
  return {
    errorCategory: diagnosticErrorCategory(err),
    ...(failureKind ? { failureKind, memory: processMemoryUsageSnapshot() } : {}),
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
}

function processMemoryUsageSnapshot(): DiagnosticMemoryUsage | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };
  } catch {
    return undefined;
  }
}

function modelCallHookEventBase(eventBase: ModelCallEventBase): PluginHookModelCallStartedEvent {
  return {
    runId: eventBase.runId,
    callId: eventBase.callId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    provider: eventBase.provider,
    model: eventBase.model,
    ...(eventBase.api ? { api: eventBase.api } : {}),
    ...(eventBase.transport ? { transport: eventBase.transport } : {}),
  };
}

function modelCallHookContext(eventBase: ModelCallEventBase): PluginHookAgentContext {
  return Object.freeze({
    runId: eventBase.runId,
    trace: eventBase.trace,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    modelProviderId: eventBase.provider,
    modelId: eventBase.model,
  }) as PluginHookAgentContext;
}

function dispatchModelCallStartedHook(eventBase: ModelCallEventBase): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("model_call_started")) {
    return;
  }
  const event = Object.freeze(modelCallHookEventBase(eventBase)) as PluginHookModelCallStartedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallStarted(event, hookCtx),
    "model_call_started plugin hook failed",
  );
}

function dispatchModelCallEndedHook(
  eventBase: ModelCallEventBase,
  fields: ModelCallEndedHookFields,
): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("model_call_ended")) {
    return;
  }
  const event = Object.freeze({
    ...modelCallHookEventBase(eventBase),
    ...fields,
  }) as PluginHookModelCallEndedEvent;
  const hookCtx = modelCallHookContext(eventBase);
  fireAndForgetBoundedHook(
    () => hookRunner.runModelCallEnded(event, hookCtx),
    "model_call_ended plugin hook failed",
  );
}

function emitModelCallStarted(eventBase: ModelCallEventBase): void {
  emitTrustedDiagnosticEvent({
    type: "model.call.started",
    ...eventBase,
  });
  dispatchModelCallStartedHook(eventBase);
}

function emitModelCallCompleted(
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  contentCapture: ModelCallContentCapturePolicy,
): void {
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = modelCallSizeTimingFields(state);
  emitTrustedDiagnosticEvent({
    type: "model.call.completed",
    ...eventBase,
    durationMs,
    ...sizeTimingFields,
    ...(contentCapture.outputMessages && state.outputTextChunks.length > 0
      ? { outputMessages: [state.outputTextChunks.join("")] }
      : {}),
    ...(contentCapture.inputMessages && state.inputMessages && state.inputMessages.length > 0
      ? { inputMessages: state.inputMessages }
      : {}),
  });
  dispatchModelCallEndedHook(eventBase, {
    durationMs,
    outcome: "completed",
    ...sizeTimingFields,
  });
}

function emitModelCallError(
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  fields: ModelCallErrorFields,
  contentCapture: ModelCallContentCapturePolicy,
): void {
  const durationMs = Date.now() - startedAt;
  const sizeTimingFields = modelCallSizeTimingFields(state);
  emitTrustedDiagnosticEvent({
    type: "model.call.error",
    ...eventBase,
    durationMs,
    ...sizeTimingFields,
    ...fields,
    // Include partial content captured before the error, gated by policy.
    ...(contentCapture.inputMessages && state.inputMessages && state.inputMessages.length > 0
      ? { inputMessages: state.inputMessages }
      : {}),
    ...(contentCapture.outputMessages && state.outputTextChunks.length > 0
      ? { outputMessages: [state.outputTextChunks.join("")] }
      : {}),
  });
  dispatchModelCallEndedHook(eventBase, {
    durationMs,
    outcome: "error",
    ...sizeTimingFields,
    ...fields,
  });
}

function withDiagnosticTraceparentHeader(
  options: ModelCallStreamOptions,
  trace: DiagnosticTraceContext,
  state: ModelCallObservationState,
  contentCapture: ModelCallContentCapturePolicy,
): ModelCallStreamOptions {
  const traceparent = formatDiagnosticTraceparent(trace);
  const originalOnPayload = options?.onPayload;
  const onPayload: NonNullable<ModelCallStreamOptions>["onPayload"] = (payload, model) => {
    // Extract input messages from the final request payload (not the model descriptor).
    // The onPayload callback receives the actual request after provider wrappers have
    // mutated it, so this is the correct seam for content capture.
    if (contentCapture.inputMessages) {
      const messages = extractInputMessages(payload);
      if (messages.length > 0) {
        state.inputMessages = messages;
      }
    }
    if (!originalOnPayload) {
      assignRequestPayloadBytes(state, payload);
      return undefined;
    }
    const result = originalOnPayload(payload, model);
    if (isPromiseLike(result)) {
      return result.then((replacement) => {
        // If the original onPayload mutated the payload, re-extract input messages
        // from the replacement to capture the final form.
        if (contentCapture.inputMessages) {
          const messages = extractInputMessages(replacement ?? payload);
          if (messages.length > 0) {
            state.inputMessages = messages;
          }
        }
        assignRequestPayloadBytes(state, replacement ?? payload);
        return replacement;
      });
    }
    // Re-extract from the mutated payload if the hook returned a replacement.
    if (contentCapture.inputMessages && result !== undefined) {
      const messages = extractInputMessages(result);
      if (messages.length > 0) {
        state.inputMessages = messages;
      }
    }
    assignRequestPayloadBytes(state, result ?? payload);
    return result;
  };

  if (!traceparent) {
    return {
      ...options,
      onPayload,
    };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (key.toLowerCase() === TRACEPARENT_HEADER_NAME) {
      continue;
    }
    headers[key] = value;
  }
  headers[TRACEPARENT_HEADER_NAME] = traceparent;
  return {
    ...options,
    headers,
    onPayload,
  };
}

async function safeReturnIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  let returnResult: unknown;
  try {
    returnResult = iterator.return?.();
  } catch {
    return;
  }
  if (!returnResult) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(returnResult).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, MODEL_CALL_STREAM_RETURN_TIMEOUT_MS);
        const unref =
          typeof timeout === "object" && timeout
            ? (timeout as { unref?: () => void }).unref
            : undefined;
        if (unref) {
          unref.call(timeout);
        }
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function* observeModelCallIterator<T>(
  iterator: AsyncIterator<T>,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  contentCapture: ModelCallContentCapturePolicy,
): AsyncIterable<T> {
  let terminalEmitted = false;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      observeResponseChunk(state, startedAt, next.value, contentCapture);
      yield next.value;
    }
    terminalEmitted = true;
    emitModelCallCompleted(eventBase, startedAt, state, contentCapture);
  } catch (err) {
    terminalEmitted = true;
    emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err), contentCapture);
    throw err;
  } finally {
    if (!terminalEmitted) {
      await safeReturnIterator(iterator);
      emitModelCallCompleted(eventBase, startedAt, state, contentCapture);
    }
  }
}

function observeModelCallStream<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  contentCapture: ModelCallContentCapturePolicy,
): T {
  const observedIterator = () =>
    observeModelCallIterator(createIterator(), eventBase, startedAt, state, contentCapture)[
      Symbol.asyncIterator
    ]();
  let hasNonConfigurableIterator = false;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
    } as T;
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeModelCallResult(
  result: unknown,
  eventBase: ModelCallEventBase,
  startedAt: number,
  state: ModelCallObservationState,
  contentCapture: ModelCallContentCapturePolicy,
): unknown {
  const createIterator = asyncIteratorFactory(result);
  if (createIterator) {
    return observeModelCallStream(
      result as AsyncIterable<unknown>,
      createIterator,
      eventBase,
      startedAt,
      state,
      contentCapture,
    );
  }
  // Non-streaming response: extract output text from the result object
  if (contentCapture.outputMessages) {
    const outputMessages = extractOutputFromResult(result);
    if (outputMessages.length > 0) {
      state.outputTextChunks = outputMessages;
    }
  }
  emitModelCallCompleted(eventBase, startedAt, state, contentCapture);
  return result;
}

export function wrapStreamFnWithDiagnosticModelCallEvents(
  streamFn: StreamFn,
  ctx: ModelCallDiagnosticContext,
): StreamFn {
  return ((model, streamContext, options) => {
    const callId = ctx.nextCallId();
    const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace));
    const eventBase = baseModelCallEvent(ctx, callId, trace);
    const contentCapture = ctx.contentCapture;

    emitModelCallStarted(eventBase);
    ctx.onStarted?.();
    const startedAt = Date.now();
    const state: ModelCallObservationState = { responseStreamBytes: 0, outputTextChunks: [] };
    const propagatedOptions = withDiagnosticTraceparentHeader(
      options,
      trace,
      state,
      contentCapture,
    );

    try {
      const result = streamFn(model, streamContext, propagatedOptions);
      if (isPromiseLike(result)) {
        return result.then(
          (resolved) =>
            observeModelCallResult(resolved, eventBase, startedAt, state, contentCapture),
          (err) => {
            emitModelCallError(
              eventBase,
              startedAt,
              state,
              modelCallErrorFields(err),
              contentCapture,
            );
            throw err;
          },
        );
      }
      return observeModelCallResult(result, eventBase, startedAt, state, contentCapture);
    } catch (err) {
      emitModelCallError(eventBase, startedAt, state, modelCallErrorFields(err), contentCapture);
      throw err;
    }
  }) as StreamFn;
}
