// Rebuilds the desktop transcript structure from the host's stream messages,
// using the same pure helpers the desktop ChatPane uses, so the phone shows the
// same turns, work groups and stage summaries.
import type { RemoteMessage } from "../../../src/shared/remote/protocol";
import type { StreamMessage, ToolStatus } from "../../../src/ui/types";
import {
  deriveTranscriptTimelineItems,
  type TranscriptTimelineItem,
} from "../../../src/ui/utils/transcript-timeline";
import {
  getMessageContentBlocks,
  normalizeToolResultBlock,
  normalizeToolUseBlock,
} from "../../../src/ui/utils/message-content";
import {
  groupSubagentMessagesByParent,
  type ToolResultBlock,
} from "../../../src/ui/utils/workstream";

export interface Transcript {
  /** False when the host predates stream-message sync; render text only. */
  structured: boolean;
  messages: StreamMessage[];
  items: TranscriptTimelineItem[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  subagentMessagesByParent: Map<string, StreamMessage[]>;
  /** Live streamed text that hasn't been committed to history yet. */
  partialText: string;
  activeTurnStartedAt?: number;
}

export function buildTranscript(remote: RemoteMessage[], running: boolean): Transcript {
  const messages: StreamMessage[] = [];
  let partialText = "";
  let structured = false;
  for (const m of remote) {
    if (m.raw && typeof m.raw === "object") {
      structured = true;
      messages.push(m.raw as StreamMessage);
    } else if (m.streaming && m.role === "assistant") partialText = m.text;
  }

  const toolStatusMap = new Map<string, ToolStatus>();
  const toolResultsMap = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    if (msg.type !== "assistant" && msg.type !== "user") continue;
    for (const block of getMessageContentBlocks(msg)) {
      const use = normalizeToolUseBlock(block);
      if (use) {
        if (!toolStatusMap.has(use.id)) toolStatusMap.set(use.id, "pending");
        continue;
      }
      const result = normalizeToolResultBlock(block);
      if (result) {
        toolStatusMap.set(result.tool_use_id, result.is_error ? "error" : "success");
        toolResultsMap.set(result.tool_use_id, {
          type: "tool_result",
          tool_use_id: result.tool_use_id,
          content: result.content,
          displayContent: result.displayContent,
          is_error: result.is_error,
          execution: {
            ...(msg.createdAt != null ? { completedAt: msg.createdAt } : {}),
            ...result.execution,
          },
        });
      }
    }
  }

  let lastPrompt = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].type === "user_prompt") {
      lastPrompt = i;
      break;
    }
  const startedAt = lastPrompt >= 0 ? messages[lastPrompt].createdAt : undefined;

  return {
    structured,
    messages,
    items: structured
      ? deriveTranscriptTimelineItems(messages, { activeTurnStartIndex: lastPrompt, sessionRunning: running })
      : [],
    toolStatusMap,
    toolResultsMap,
    subagentMessagesByParent: groupSubagentMessagesByParent(messages),
    partialText,
    activeTurnStartedAt: typeof startedAt === "number" ? startedAt : undefined,
  };
}
