// What one turn looked like, folded from the session's stream messages: the
// answer text, the tool calls with their outcome, thinking, and the files the
// turn changed. The progress card is rendered from this.
import type { StreamMessage } from "../../shared/types";
import { getMessageContentBlocks, normalizeToolResultBlock, normalizeToolUseBlock } from "../../ui/utils/message-content";

export type TurnStatus = "running" | "done" | "stopped" | "failed";

export type TurnBlock =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; status: "running" | "done" | "error" };

export interface ChangedFile {
  path: string;
  add: number;
  del: number;
}

export class TurnState {
  blocks: TurnBlock[] = [];
  thinking = "";
  /** Streaming text not yet committed as an assistant message. */
  live = "";
  status: TurnStatus = "running";
  error?: string;
  changes: ChangedFile[] = [];
  /** Plan text from the latest ExitPlanMode call, for the plan approval card. */
  plan?: string;
  startedAt = Date.now();

  /** Returns true when something visible changed. */
  ingest(message: StreamMessage): boolean {
    if (message.parentToolUseId) return false;
    const m = message as StreamMessage & Record<string, unknown>;
    if (m.type === "stream_event") {
      const delta = (m.event as { delta?: { type?: string; text?: string; thinking?: string } } | undefined)?.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.live += delta.text;
        return true;
      }
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        this.thinking += delta.thinking;
        return true;
      }
      return false;
    }
    if (m.type === "assistant") {
      const uuid = String(m.uuid ?? "");
      let changed = false;
      getMessageContentBlocks(message).forEach((block, index) => {
        const raw = block as unknown as Record<string, unknown>;
        if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim()) {
          const id = `${uuid}:${index}`;
          const existing = this.blocks.find((b) => b.kind === "text" && b.id === id);
          if (existing && existing.kind === "text") existing.text = raw.text;
          else this.blocks.push({ kind: "text", id, text: raw.text });
          changed = true;
        } else if (raw.type === "thinking" && typeof raw.thinking === "string") {
          if (raw.thinking.length >= this.thinking.length) this.thinking = raw.thinking;
          changed = true;
        } else {
          const tool = normalizeToolUseBlock(block);
          if (tool && !this.blocks.some((b) => b.kind === "tool" && b.id === tool.id)) {
            this.blocks.push({ kind: "tool", id: tool.id, name: tool.name, input: tool.input, status: "running" });
            if (tool.name === "ExitPlanMode" && typeof tool.input.plan === "string") this.plan = tool.input.plan;
            changed = true;
          }
        }
      });
      if (!m.streaming) this.live = "";
      return changed;
    }
    if (m.type === "user") {
      let changed = false;
      for (const block of getMessageContentBlocks(message)) {
        const result = normalizeToolResultBlock(block);
        if (!result) continue;
        const tool = this.blocks.find((b) => b.kind === "tool" && b.id === result.tool_use_id);
        if (tool && tool.kind === "tool") {
          tool.status = result.is_error ? "error" : "done";
          changed = true;
        }
      }
      return changed;
    }
    if (m.type === "system" && m.subtype === "turn_changes") {
      const patch = (m.turnChanges as { patch?: string } | undefined)?.patch;
      if (typeof patch === "string") {
        this.changes = summarizePatch(patch);
        return true;
      }
    }
    return false;
  }

  finish(status: Exclude<TurnStatus, "running">, error?: string) {
    this.status = status;
    if (error) this.error = error;
    for (const block of this.blocks) if (block.kind === "tool" && block.status === "running") block.status = status === "done" ? "done" : "error";
  }

  /** The answer as the agent wrote it: committed text blocks plus streaming text. */
  answer(): string {
    const parts = this.blocks.filter((b): b is Extract<TurnBlock, { kind: "text" }> => b.kind === "text").map((b) => b.text);
    if (this.live.trim()) parts.push(this.live);
    return parts.join("\n\n");
  }

  hasContent(): boolean {
    return this.blocks.length > 0 || !!this.live.trim() || !!this.thinking.trim();
  }
}

/** Per-file +/- counts from a unified diff. */
export function summarizePatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { path: match?.[1] ?? line.slice(11), add: 0, del: 0 };
      files.push(current);
    } else if (!current || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (line.startsWith("+")) current.add++;
    else if (line.startsWith("-")) current.del++;
  }
  return files;
}
