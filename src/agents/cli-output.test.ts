import { describe, expect, it } from "vitest";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliJson,
  parseCliJsonl,
  type CliToolResultDelta,
  type CliToolUseStartDelta,
} from "./cli-output.js";
import { sanitizeToolArgs, sanitizeToolResult } from "./pi-embedded-subscribe.tools.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

describe("parseCliJson", () => {
  it("recovers mixed-output Claude session metadata from embedded JSON objects", () => {
    const result = parseCliJson(
      [
        "Claude Code starting...",
        '{"type":"init","session_id":"session-789"}',
        '{"type":"result","result":"Claude says hi","usage":{"input_tokens":9,"output_tokens":4}}',
      ].join("\n"),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Claude says hi",
      sessionId: "session-789",
      usage: {
        input: 9,
        output: 4,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses Gemini CLI response text and stats payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-123",
        response: "Gemini says hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session-123",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 8,
        cacheWrite: undefined,
        total: 21,
      },
    });
  });

  it("falls back to input_tokens minus cached when Gemini stats omit input", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-456",
        response: "Hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result?.usage?.input).toBe(5);
    expect(result?.usage?.cacheRead).toBe(8);
  });

  it("falls back to Gemini stats when usage exists without token fields", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-789",
        response: "Gemini says hello",
        usage: {},
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session-789",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 8,
        cacheWrite: undefined,
        total: 21,
      },
    });
  });

  it("unwraps nested Claude result JSON from JSON output", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "session-nested-json",
        result: JSON.stringify({
          type: "result",
          result: JSON.stringify({
            type: "result",
            subtype: "success",
            result: "actual response text",
          }),
        }),
      }),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "actual response text",
      sessionId: "session-nested-json",
      usage: undefined,
    });
  });

  it("does not unwrap nested result-shaped JSON for non-claude json backends", () => {
    const nestedResult = JSON.stringify({
      type: "result",
      result: JSON.stringify({
        type: "result",
        result: "actual response text",
      }),
    });
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-nested-json",
        result: nestedResult,
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "gemini",
    );

    expect(result).toEqual({
      text: nestedResult,
      sessionId: "gemini-session-nested-json",
      usage: undefined,
    });
  });

  it("parses nested OpenAI-style cached token details from CLI json payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "openai-session-123",
        response: "OpenAI says hello",
        usage: {
          input_tokens: 15,
          output_tokens: 4,
          input_tokens_details: {
            cached_tokens: 6,
          },
        },
      }),
      {
        command: "codex",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "OpenAI says hello",
      sessionId: "openai-session-123",
      usage: {
        input: 9,
        output: 4,
        cacheRead: 6,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });
});

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses Claude stream-json result events for an explicit backend dialect", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-dialect" }),
        JSON.stringify({
          type: "result",
          session_id: "session-dialect",
          result: "dialect says hello",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ].join("\n"),
      {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "local-cli",
    );

    expect(result).toEqual({
      text: "dialect says hello",
      sessionId: "session-dialect",
      usage: {
        input: 5,
        output: 2,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("preserves Claude cache creation tokens instead of flattening them to zero", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-cache-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-cache-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 7,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-cache-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: 7,
        total: undefined,
      },
    });
  });

  it("preserves Claude session metadata even when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-456" }),
        JSON.stringify({
          type: "result",
          session_id: "session-456",
          result: "   ",
          usage: {
            input_tokens: 18,
            output_tokens: 0,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-456",
      usage: {
        input: 18,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("unwraps nested Claude agent result JSON from stream-json output", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-nested-jsonl" }),
        JSON.stringify({
          type: "result",
          session_id: "session-nested-jsonl",
          result: JSON.stringify({
            type: "result",
            result: JSON.stringify({
              type: "result",
              subtype: "success",
              result: "actual response text",
            }),
          }),
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "actual response text",
      sessionId: "session-nested-jsonl",
      usage: undefined,
    });
  });

  it("parses multiple JSON objects embedded on the same line", () => {
    const result = parseCliJsonl(
      '{"type":"init","session_id":"session-999"} {"type":"result","session_id":"session-999","result":"done"}',
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "done",
      sessionId: "session-999",
      usage: undefined,
    });
  });

  it("extracts nested Claude API errors from failed stream-json output", () => {
    const { message, jsonl } = createClaudeApiErrorFixture();
    const result = extractCliErrorMessage(jsonl);

    expect(result).toBe(message);
  });
});

describe("createCliJsonlStreamingParser", () => {
  it("streams Claude stream-json deltas for an explicit backend dialect", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
    });

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-stream" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hello" },
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "hello", delta: "hello", sessionId: "session-stream", usage: undefined },
    ]);
  });

  it("surfaces a single tool_use start with full args plus the tool_result from claude-cli stream-json", () => {
    const starts: Array<{ toolCallId: string; name: string; args: Record<string, unknown> }> = [];
    const results: Array<{ toolCallId: string; name: string; isError: boolean; result?: unknown }> =
      [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    // Sequence captured from a real claude-cli `--output-format stream-json
    // --include-partial-messages` run: streaming start → input_json_delta
    // chunks → assistant snapshot with full input → user-typed tool_result.
    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_01ABCD", name: "Bash", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"command": "ls -' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: 'la"}' },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01ABCD",
                name: "Bash",
                input: { command: "ls -la" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_01ABCD",
                type: "tool_result",
                content: "total 0\n",
                is_error: false,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      { toolCallId: "toolu_01ABCD", name: "Bash", args: { command: "ls -la" } },
    ]);
    expect(results).toEqual([
      { toolCallId: "toolu_01ABCD", name: "Bash", isError: false, result: "total 0\n" },
    ]);
  });

  it("falls back to empty-args start when content_block_stop arrives without a preceding assistant snapshot", () => {
    const starts: Array<{ toolCallId: string; name: string; args: Record<string, unknown> }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_aborted", name: "Bash", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([{ toolCallId: "toolu_aborted", name: "Bash", args: {} }]);
  });

  it("emits start exactly once when both content_block_start and the assistant snapshot announce the same tool_use", () => {
    const starts: Array<{ toolCallId: string; name: string; args: Record<string, unknown> }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_dup", name: "Read", input: {} },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_dup", name: "Read", input: { file_path: "/tmp/x" } },
            ],
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      { toolCallId: "toolu_dup", name: "Read", args: { file_path: "/tmp/x" } },
    ]);
  });

  it("flags is_error=true on tool_result events and carries the tool name from prior start", () => {
    const starts: Array<{ toolCallId: string; name: string; args: Record<string, unknown> }> = [];
    const results: Array<{ toolCallId: string; name: string; isError: boolean; result?: unknown }> =
      [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "false" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_err",
                type: "tool_result",
                content: "command failed: nope",
                is_error: true,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([{ toolCallId: "toolu_err", name: "Bash", args: { command: "false" } }]);
    expect(results).toEqual([
      { toolCallId: "toolu_err", name: "Bash", isError: true, result: "command failed: nope" },
    ]);
  });

  it("ignores tool events when no tool callbacks are subscribed", () => {
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: ({ text, delta }) => deltas.push({ text, delta }),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_silent", name: "Bash", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ok" },
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    // Pre-existing assistant text streaming behavior is preserved when only
    // onAssistantDelta is supplied; tool events silently drop.
    expect(deltas).toEqual([{ text: "ok", delta: "ok" }]);
  });

  it("surfaces tool args and results unredacted at the parser boundary; sanitization is the consumer's responsibility before bus emission", () => {
    // Locks in the privacy contract for callers: the parser is a pure
    // transform that carries claude-cli's raw `tool_use.input` and
    // `tool_result.content` through to the callback. Consumers that emit
    // these onto the shared agent-event bus (see
    // src/agents/cli-runner/execute.ts) MUST apply
    // `sanitizeToolArgs`/`sanitizeToolResult` from
    // `src/agents/pi-embedded-subscribe.tools.ts` first, matching the
    // embedded native runtime's emission contract.
    const starts: Array<CliToolUseStartDelta> = [];
    const results: Array<CliToolResultDelta> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_secret",
                name: "Bash",
                input: { command: "curl -H 'Authorization: Bearer sk-supersecret' api.example/v1" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_secret",
                type: "tool_result",
                content: '{"x_api_key":"sk-supersecret-response"}',
                is_error: false,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toHaveLength(1);
    expect(starts[0]?.args.command).toContain("sk-supersecret");
    expect(results).toHaveLength(1);
    expect(typeof results[0]?.result === "string" ? results[0].result : "").toContain(
      "sk-supersecret-response",
    );

    // Verify sanitizers, when applied at the consumer layer, redact what
    // the parser surfaces — the privacy guarantee that the cli-runner
    // emit sites rely on.
    const sanitizedArgs = sanitizeToolArgs(starts[0]?.args) as Record<string, unknown>;
    expect(typeof sanitizedArgs.command === "string" ? sanitizedArgs.command : "").not.toContain(
      "sk-supersecret",
    );
    const sanitizedResult = sanitizeToolResult(results[0]?.result);
    expect(typeof sanitizedResult === "string" ? sanitizedResult : "").not.toContain(
      "sk-supersecret-response",
    );
  });
});
