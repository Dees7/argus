// Parser types for JSONL events

export interface RawEvent {
  type: string;
  parentUuid?: string;
  uuid: string;
  sessionId: string;
  timestamp: string;
  cwd: string;
  gitBranch: string;
  version: string;
  slug: string;
  agentId?: string;
  isSidechain: boolean;
  userType: string;

  // Assistant-specific
  message?: AssistantMessage;
  requestId?: string;
  isApiErrorMessage?: boolean;
  /**
   * What a request failed with, on a `system`/`api_error` event. A string on
   * assistant events that carry one.
   */
  error?: ApiError | string;

  // User-specific (tool results)
  toolUseResult?: any;
  sourceToolAssistantUUID?: string;

  // Set on the synthetic user event Claude Code writes when it compacts the
  // conversation: `message.content` is the hand-off summary that replaces the
  // dropped history. The only unambiguous compaction marker in a transcript.
  isCompactSummary?: boolean;

  // Marks a user event the harness generated rather than the person typing —
  // command caveats and similar bookkeeping.
  isMeta?: boolean;

  // Progress-specific
  data?: any;

  // `type: "attachment"` events. Mostly harness bookkeeping (skill listings,
  // token reminders), but `queued_command` carries a message the person typed
  // while a turn was still running — the only record of it in the transcript,
  // and `hook_blocking_error` the error a hook handed back instead of a tool's
  // result.
  attachment?: {
    type?: string;
    /** What was typed: a plain string, or content blocks when it has images. */
    prompt?: any;
    commandMode?: string;
    origin?: { kind?: string };

    // `hook_blocking_error`
    /** Which hook fired, as `<event>:<matcher>` — `PostToolUse:Bash`. */
    hookName?: string;
    hookEvent?: string;
    /** The `tool_use` block the hook fired on. */
    toolUseID?: string;
    /**
     * The refusal. An object in every transcript we have seen; the string form
     * is tolerated because the message is the part that matters and a shape
     * change should not lose it.
     */
    blockingError?: { blockingError?: string; command?: string } | string;
  };

  // System-specific
  subtype?: string;
  durationMs?: number;
  level?: string;

  // `subtype: "local_command"` — a slash command the CLI ran by itself. Two
  // events per command share the subtype and the field: the invocation, as a
  // `<command-name>/<command-message>/<command-args>` document, and its output
  // wrapped in `<local-command-stdout>`, whose `parentUuid` is the invocation.
  // Nothing was sent to the model either time, so this is the only record.
  content?: string;

  // `subtype: "stop_hook_summary"` — what the Stop hooks did when the turn
  // ended. Written after every turn whether or not anything went wrong, so most
  // are uneventful; the ones worth finding are those with a `hookErrors` entry
  // or with `preventedContinuation`, where a hook sent the model back to work.
  /** How many hooks ran; `hookInfos` has one entry each. */
  hookCount?: number;
  hookInfos?: { command?: string; durationMs?: number }[];
  /** One sentence per hook that failed. Non-blocking unless `preventedContinuation`. */
  hookErrors?: string[];
  /** Text a hook fed back into the conversation. Empty in every transcript we have. */
  hookAdditionalContext?: string[];
  /** A hook refused to let the turn end — `stopReason` is what it said. */
  preventedContinuation?: boolean;
  stopReason?: string;
  hasOutput?: boolean;

  // `subtype: "api_error"` — a request that failed and was retried. The attempt
  // that finally worked is written as an ordinary assistant message, so these
  // events are the only record that the turn cost several tries.
  /** 1-based; `maxRetries` is the budget, not how many actually happened. */
  retryAttempt?: number;
  maxRetries?: number;
  retryInMs?: number;
  /** `request_retry` / `connection_retry`. Absent on older transcripts. */
  source?: string;

  // File history snapshot
  snapshot?: any;
  isSnapshotUpdate?: boolean;
  messageId?: string;

  // Queue operation
  operation?: string;
}

/**
 * The `error` of an `api_error` event. Two shapes share the field and neither
 * is guaranteed whole, so every member is optional and the parser assembles a
 * headline from whichever ones turned up:
 *
 *  - the harness's own record — `message` ("429 {…}", "Connection error."),
 *    `formatted`, `status`, and `connection` when the socket never got through;
 *  - the SDK's `APIError` — `status`, `headers`, `requestID`, and the response
 *    body under `error`, which a proxy may have wrapped in another `error`.
 */
export interface ApiError {
  /** Usually "<status> <json body>", sometimes a bare sentence. */
  message?: string;
  formatted?: string;
  status?: number;
  /** Set when the request never reached the API — `cause` on older events. */
  connection?: { code?: string; message?: string; path?: string } | null;
  cause?: { code?: string; message?: string; path?: string; errno?: number };
  isNetworkDown?: boolean;
  rateLimits?: any;
  /** The response body, one or two `error` wrappers deep. */
  error?: any;
  type?: string | null;
  requestID?: string | null;
  headers?: Record<string, string>;
}

export interface AssistantMessage {
  model: string;
  id: string;
  type: string;
  role: string;
  content: ContentBlock[];
  stop_reason?: string;
  usage?: UsageInfo;
}

export interface ContentBlock {
  type: string;

  // thinking
  thinking?: string;
  signature?: string;

  // text
  text?: string;

  // tool_use
  id?: string;
  name?: string;
  input?: any;

  // tool_result
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  // Read-only decomposition of `output_tokens`, not an addition to it: the
  // reasoning tokens are already billed inside the output count.
  output_tokens_details?: {
    thinking_tokens?: number;
  };
}

export interface ProgressData {
  type: string;
  output?: string;
  message?: any;
  prompt?: string;
}

export interface ToolUseResultRead {
  type: string;
  file?: {
    filePath: string;
    numLines: number;
    totalLines: number;
  };
}

export interface ToolUseResultBash {
  stdout: string;
  stderr: string;
  interrupted: boolean;
}

export interface ToolUseResultWrite {
  type: string;
  filePath: string;
}

export interface ToolUseResultAgent {
  status: string;
  prompt: string;
  content: string;
  agentId: string;
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
}
