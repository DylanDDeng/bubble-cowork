// Render model for the SwiftUI session view. Mirrors what the React phone UI
// drew (SessionView + Trace) from the same desktop
// helpers, flattened into JSON so Swift only lays it out.
import type { RemoteMessage } from "../../../src/shared/remote/protocol";
import type { StreamMessage } from "../../../src/ui/types";
import { getMessageContentBlocks } from "../../../src/ui/utils/message-content";
import type { TimelineWorkGroup } from "../../../src/ui/utils/transcript-timeline";
import {
  createBatchWorkstreamModel,
  getDelegateAgentFromBlock,
  getToolResultOutputContent,
  type WorkstreamEntry,
} from "../../../src/ui/utils/workstream";
import {
  formatWorkstreamStageSummary,
  getWorkstreamStageActivityKind,
  summarizeWorkstreamEntries,
  type WorkstreamStage,
} from "../../../src/ui/utils/workstream-stages";
import type { ChangeRecord } from "../../../src/ui/utils/change-records";
import { buildTurnChangeContext } from "../../../src/ui/utils/turn-change-records";
import { buildTranscript, type Transcript } from "./transcript";
import { parsePatch } from "./patch";

export interface Lane {
  id: string;
  provider: string | null;
  label: string;
  status: "running" | "finished" | "failed" | "interrupted";
}
export interface Stage {
  id: string;
  kind: "row" | "subagents";
  icon: string;
  status: string;
  title: string;
  active: boolean;
  expandable: boolean;
  defaultOpen: boolean;
  addedLines: number;
  removedLines: number;
  /** Edit stages: the change record diff per file (hunks, sometimes with headers). */
  files: { id: string; name: string; path: string; addedLines: number; removedLines: number; diff: string | null }[];
  commands: { id: string; text: string; isError: boolean }[];
  genericText: string;
  /** One lane, or a board of parallel subagents. */
  lanes: Lane[];
  board: { title: string; meta: string } | null;
}
export type WorkGroup =
  | { kind: "note"; id: string; markdown: string; streaming: boolean }
  | { kind: "thinking"; id: string; label: string; active: boolean; text: string }
  | { kind: "compaction"; id: string; inProgress: boolean; label: string }
  | {
      kind: "stages";
      id: string;
      showHeader: boolean;
      headerLabel: string;
      headerIcon: string | null;
      headerActive: boolean;
      failed: number;
      defaultOpen: boolean;
      thinking: boolean;
      stages: Stage[];
    };
export interface WorkBlock {
  /** "Worked for 1m 12s" / "3 previous messages"; null when the block can't collapse. */
  label: string | null;
  stoppedLabel: string | null;
  defaultExpanded: boolean;
  groups: WorkGroup[];
  working: boolean;
}
export type SessionItem =
  | { kind: "user"; id: string; prompt: string; attachments: { id: string; name: string; image: boolean }[] }
  | { kind: "answer"; id: string; markdown: string; streaming: boolean }
  | { kind: "plan"; id: string; markdown: string }
  | { kind: "changes"; id: string; files: { path: string; additions: number; deletions: number }[] }
  | { kind: "work"; id: string; work: WorkBlock }
  | { kind: "activity"; id: string; steps: { id: string; detail: string }[] }
  | { kind: "working"; id: string; label: string };
export interface SessionModel {
  structured: boolean;
  items: SessionItem[];
  lastAnswerText: string | null;
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const tail = (text: string, limit = 4000) => (text.length > limit ? "…" + text.slice(-limit) : text);

const textOf = (message: StreamMessage) =>
  message.type === "user_prompt"
    ? message.prompt
    : getMessageContentBlocks(message)
        .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n\n");

const isPendingEntry = (e: WorkstreamEntry) =>
  e.type === "compaction"
    ? e.state === "inProgress"
    : e.type === "thinking"
      ? e.state === "active"
      : e.type === "approval"
        ? e.state === "waiting"
        : "status" in e && e.status === "pending";

function entryOutput(entry: WorkstreamEntry): string {
  if (!("block" in entry)) return entry.detail || "";
  const result = "result" in entry && entry.result ? getToolResultOutputContent(entry.result) : "";
  return [entry.detail, result].filter(Boolean).join("\n\n");
}

type TaskEntry = Extract<WorkstreamEntry, { type: "task" }>;

function taskDescription(entry: TaskEntry) {
  if (entry.subagent?.description) return entry.subagent.description;
  const input = (entry.block.input ?? {}) as Record<string, unknown>;
  for (const key of ["description", "prompt", "message", "task"])
    if (typeof input[key] === "string" && (input[key] as string).trim()) return (input[key] as string).trim();
  return entry.summary;
}

function lane(entry: TaskEntry): Lane {
  return {
    id: entry.id,
    provider: getDelegateAgentFromBlock(entry.block) ?? null,
    label: taskDescription(entry),
    status:
      entry.status === "pending"
        ? "running"
        : entry.status === "error"
          ? "failed"
          : entry.status === "interrupted"
            ? "interrupted"
            : "finished",
  };
}

function stageModel(stage: WorkstreamStage): Stage {
  const icon = getWorkstreamStageActivityKind(stage);
  const base = {
    id: stage.id,
    icon,
    status: stage.status,
    title: stage.title,
    active: stage.status === "pending" || stage.status === "waiting",
    defaultOpen: stage.defaultExpanded,
    addedLines: stage.addedLines,
    removedLines: stage.removedLines,
  };
  const tasks = stage.entries.filter((e): e is TaskEntry => e.type === "task");
  if (stage.kind === "task" && tasks.length) {
    const running = tasks.filter((e) => e.status === "pending").length;
    const failed = tasks.filter((e) => e.status === "error").length;
    const stopped = tasks.filter((e) => e.status === "interrupted").length;
    const done = tasks.length - running - failed - stopped;
    const meta = [
      done && `${done} done`,
      running && `${running} running`,
      failed && `${failed} failed`,
      stopped && `${stopped} stopped`,
    ].filter(Boolean);
    return {
      ...base,
      kind: "subagents",
      expandable: false,
      files: [],
      commands: [],
      genericText: "",
      lanes: tasks.map(lane),
      board: tasks.length > 1 ? { title: `${tasks.length} subagents in parallel`, meta: meta.join(" · ") } : null,
    };
  }
  const generic = stage.files.length === 0 && stage.commands.length === 0;
  const genericText = generic ? tail(stage.entries.map(entryOutput).filter(Boolean).join("\n\n")) : "";
  return {
    ...base,
    kind: "row",
    expandable: stage.files.length > 0 || stage.commands.length > 0 || !!genericText,
    files: stage.files.map((f) => ({
      id: f.id,
      name: f.fileName,
      path: f.filePath,
      addedLines: f.addedLines,
      removedLines: f.removedLines,
      diff: f.record?.diffContent ?? null,
    })),
    commands: stage.commands.map((c) => ({
      id: c.id,
      text: "$ " + c.command + (c.output ? "\n" + tail(c.output) : ""),
      isError: c.status === "error",
    })),
    genericText,
    lanes: [],
    board: null,
  };
}

type Records = Map<string, ChangeRecord[]>;

function stagesGroup(entries: WorkstreamEntry[], isLatestRunning: boolean, records: Records): WorkGroup {
  // Same inputs as the desktop AssistantWorkstream: edit stages take their
  // files and line counts from the turn's change records.
  const stages = summarizeWorkstreamEntries(entries, { changeRecordsByToolUseId: records });
  const activeStage = [...stages]
    .reverse()
    .find((s) => s.status === "pending" || s.status === "waiting" || s.entries.some((e) => "status" in e && e.status === "pending"));
  const thinking = isLatestRunning && !activeStage;
  const headerStage = activeStage || stages[0];
  return {
    kind: "stages",
    id: entries[0].id,
    showHeader: stages.length > 1,
    headerLabel: thinking ? "Thinking" : activeStage?.title || capitalize(formatWorkstreamStageSummary(stages)),
    headerIcon: !thinking && headerStage ? getWorkstreamStageActivityKind(headerStage) : null,
    headerActive: thinking || !!activeStage,
    failed: entries.filter((e) => "status" in e && e.status === "error").length,
    defaultOpen: stages.some((s) => s.defaultExpanded),
    thinking,
    stages: stages.map(stageModel),
  };
}

function workBlock(group: TimelineWorkGroup, active: boolean, running: boolean, transcript: Transcript, defaultExpanded: boolean, allowCollapse: boolean, records: Records): WorkBlock | null {
  const live = running && active;
  const model = createBatchWorkstreamModel({
    messages: group.messages,
    toolStatusMap: transcript.toolStatusMap,
    toolResultsMap: transcript.toolResultsMap,
    isSessionRunning: live,
    startedAt: live ? transcript.activeTurnStartedAt : undefined,
    durationMs: group.durationMs,
    subagentMessagesByParent: transcript.subagentMessagesByParent,
    liveTrace: live ? { partialText: transcript.partialText } : undefined,
  });
  if (!model.entries.length) return null;
  const interrupted = model.entries.some(
    (e) => (e.type === "tool" || e.type === "task" || e.type === "memory") && e.status === "interrupted",
  );
  const stopped = !live && interrupted;
  const compactionOnly = model.entries.length === 1 && model.entries[0].type === "compaction";
  const canCollapse = allowCollapse && !live && !stopped && !compactionOnly;
  const count = model.messageCount ?? model.entries.length;
  const finite = typeof model.durationMs === "number" && Number.isFinite(model.durationMs);

  // Same grouping as Trace.tsx: prose, thinking and compaction break runs of tool entries.
  type Raw = { single: WorkstreamEntry } | { run: WorkstreamEntry[] };
  const raw: Raw[] = [];
  let buffer: WorkstreamEntry[] = [];
  const flush = () => {
    if (buffer.length) raw.push({ run: buffer });
    buffer = [];
  };
  for (const entry of model.entries) {
    if (entry.type === "compaction" || entry.type === "note" || entry.type === "thinking") {
      flush();
      raw.push({ single: entry });
    } else buffer.push(entry);
  }
  flush();
  const runningModel = model.state === "running" && !model.retrying;
  const groups: WorkGroup[] = [];
  raw.forEach((g, i) => {
    if ("run" in g) {
      // Only the latest run of tools in a live turn shows the "Thinking" state.
      groups.push(stagesGroup(g.run, runningModel && i === raw.length - 1, records));
      return;
    }
    const entry = g.single;
    if (entry.type === "compaction") {
      groups.push({
        kind: "compaction",
        id: entry.id,
        inProgress: entry.state === "inProgress",
        label: entry.state === "inProgress" ? "Compacting context…" : "Context compacted",
      });
    } else if (entry.type === "note") {
      const text = entry.detail || entry.summary;
      if (text.trim()) groups.push({ kind: "note", id: entry.id, markdown: text, streaming: entry.state === "streaming" });
    } else if (entry.type === "thinking") {
      const activeThinking = entry.state === "active";
      groups.push({
        kind: "thinking",
        id: entry.id,
        label: entry.state === "interrupted" ? "Reasoning · interrupted" : activeThinking ? "Thinking" : "Reasoning",
        active: activeThinking,
        text: entry.detail || entry.summary,
      });
    }
  });
  const last = raw[raw.length - 1];
  return {
    label: canCollapse ? (finite ? `Worked for ${formatElapsed(model.durationMs!)}` : `${count} previous message${count === 1 ? "" : "s"}`) : null,
    stoppedLabel: stopped ? (model.durationMs != null ? `You stopped after ${formatElapsed(model.durationMs)}` : "You stopped") : null,
    defaultExpanded: !canCollapse || defaultExpanded,
    groups,
    working: runningModel && !(last && "run" in last) && !model.entries.some(isPendingEntry),
  };
}

export function renderSession(messages: RemoteMessage[], running: boolean, status: string): SessionModel {
  const transcript = buildTranscript(messages, running);
  const items: SessionItem[] = [];
  const used = new Set<string>();
  const unique = (id: string) => {
    let candidate = id;
    for (let n = 2; used.has(candidate); n++) candidate = `${id}#${n}`;
    used.add(candidate);
    return candidate;
  };
  const working = { kind: "working" as const, id: "working", label: status === "stopping" ? "Stopping…" : "Working" };

  if (transcript.structured) {
    const records = buildTurnChangeContext(transcript.messages).changeRecordsByToolUseId;
    transcript.items.forEach((item) => {
      if (item.type === "work") {
        const work = workBlock(item.group, item.active, running, transcript, item.defaultExpanded, item.canCollapse !== false, records);
        // Ids from the first message survive "load earlier", unlike the index-based group id.
        const first = item.group.messages[0] as { uuid?: string } | undefined;
        if (work) items.push({ kind: "work", id: unique("work:" + (first?.uuid ?? item.group.id)), work });
        return;
      }
      const m = item.message;
      const id = unique(("uuid" in m && typeof m.uuid === "string" ? m.uuid : `${m.type}:${item.originalIndex}`) + ":" + m.type);
      if (m.type === "user_prompt") {
        items.push({
          kind: "user",
          id,
          prompt: m.prompt,
          attachments: (m.attachments ?? []).map((a) => ({ id: a.id, name: a.name, image: a.kind === "image" })),
        });
      } else if (m.type === "system" && m.subtype === "turn_changes") {
        const files = parsePatch(m.turnChanges.patch);
        if (files.length)
          items.push({ kind: "changes", id: m.uuid, files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })) });
      } else if (m.type === "proposed_plan") {
        items.push({ kind: "plan", id, markdown: m.planMarkdown });
      } else if (m.type === "assistant") {
        const text = textOf(m);
        if (text.trim()) items.push({ kind: "answer", id, markdown: text, streaming: m.streaming === true });
      }
    });
    const lastItem = transcript.items[transcript.items.length - 1];
    const liveWork = lastItem?.type === "work" && lastItem.active;
    if (running && transcript.partialText && !liveWork)
      items.push({ kind: "answer", id: "partial", markdown: transcript.partialText, streaming: true });
    else if (running && !liveWork) items.push(working);
  } else {
    // Hosts without stream-message sync: text rows, tool rows folded into steps.
    let activity: Extract<SessionItem, { kind: "activity" }> | undefined;
    for (const m of messages) {
      if (m.role === "tool") {
        if (!activity) {
          activity = { kind: "activity", id: unique(m.id), steps: [] };
          items.push(activity);
        }
        activity.steps.push({ id: m.id, detail: m.text });
        continue;
      }
      activity = undefined;
      if (m.role === "user") items.push({ kind: "user", id: unique(m.id), prompt: m.text, attachments: [] });
      else if (m.role === "assistant") items.push({ kind: "answer", id: unique(m.id), markdown: m.text, streaming: m.streaming === true });
    }
    if (running) items.push(working);
  }

  const lastAnswer = [...transcript.messages].reverse().find((m) => m.type === "assistant" && textOf(m).trim());
  const lastAnswerText = lastAnswer ? textOf(lastAnswer) : [...messages].reverse().find((m) => m.role === "assistant")?.text;
  return { structured: transcript.structured, items, lastAnswerText: lastAnswerText ?? null };
}
