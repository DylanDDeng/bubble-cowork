// CardKit 2.0 JSON for the bridge: the per-turn progress card, approval /
// question cards, and small command cards. Pure functions; tokens for buttons
// are minted by the caller.
import type { PermissionRequestPayload } from "../../shared/types";
import { deriveReadableToolDisplay, formatReadableToolSummary } from "../../ui/utils/tool-summary";
import type { TurnBlock, TurnState } from "./turn";

/** Characters of answer kept in the card; the rest is sent as follow-up messages. */
export const CARD_ANSWER_LIMIT = 24000;

type El = Record<string, unknown>;

/** Feishu's tenant audit rejects messages containing email addresses (230028). */
export function maskEmails<T>(value: T): T {
  if (typeof value === "string") return value.replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1[at]$2") as T;
  if (Array.isArray(value)) return value.map(maskEmails) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskEmails(v);
    return out as T;
  }
  return value;
}

export const markdown = (content: string, notation = false): El => ({
  tag: "markdown",
  content,
  ...(notation ? { text_size: "notation" } : {}),
});

/**
 * Button callback value. The channel SDK dedupes clicks by the first 128
 * characters of the serialized value, and our signed tokens share a long
 * prefix within a card, so a per-button key goes first.
 */
export const callbackValue = (token: string) => ({ k: token.slice(-16), t: token });

export function button(label: string, token: string, type: "primary" | "danger" | "default" = "default"): El {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value: callbackValue(token) }],
  };
}

export const buttonRow = (buttons: El[]): El => ({
  tag: "column_set",
  flex_mode: "flow",
  horizontal_spacing: "8px",
  columns: buttons.map((b) => ({ tag: "column", width: "auto", elements: [b] })),
});

function panel(title: string, elements: El[], expanded = false): El {
  return {
    tag: "collapsible_panel",
    expanded,
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    header: {
      title: { tag: "markdown", content: title },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    elements,
  };
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
const escapeInline = (text: string) => text.replace(/`/g, "ˋ").replace(/\n/g, " ");

function toolLine(block: Extract<TurnBlock, { kind: "tool" }>): string {
  const icon = block.status === "running" ? "⏳" : block.status === "error" ? "❌" : "✅";
  const display = deriveReadableToolDisplay(block.name, block.input, block.status === "running" ? "pending" : block.status === "error" ? "error" : "success");
  const summary = clip(formatReadableToolSummary(display) || block.name, 120);
  const [verb, ...rest] = summary.split(" ");
  return rest.length ? `${icon} ${verb} \`${escapeInline(rest.join(" "))}\`` : `${icon} ${summary}`;
}

export interface TurnCardOptions {
  stopToken?: string;
  /** The turn was started from the Aegis desktop, not this chat. */
  fromDesktop?: boolean;
  title?: string;
}

export const TURN_SUMMARY: Record<TurnState["status"], string> = {
  running: "Working…",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

/** The progress card for one turn; the answer is clipped to `CARD_ANSWER_LIMIT`. */
export function turnCard(turn: TurnState, options: TurnCardOptions = {}): El {
  const elements: El[] = [];
  if (options.fromDesktop) elements.push(markdown("_From Aegis desktop_", true));
  if (turn.thinking.trim()) {
    const active = turn.status === "running" && !turn.answer().trim() && !turn.blocks.some((b) => b.kind === "tool");
    elements.push(panel(active ? "💭 **Thinking**" : "💭 Thought", [markdown(clip(turn.thinking.trim(), 1500), true)], active));
  }
  // Answer text keeps its position between tool runs, like the desktop trace.
  let budget = CARD_ANSWER_LIMIT;
  const blocks: TurnBlock[] = [...turn.blocks];
  if (turn.live.trim()) blocks.push({ kind: "text", id: "live", text: turn.live });
  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i];
    if (block.kind === "text") {
      if (budget > 0) {
        const text = block.text.length > budget ? block.text.slice(0, budget) + "\n\n_… continued below_" : block.text;
        budget -= block.text.length;
        elements.push(markdown(text));
      }
      i++;
      continue;
    }
    const run: Extract<TurnBlock, { kind: "tool" }>[] = [];
    while (i < blocks.length && blocks[i].kind === "tool") run.push(blocks[i++] as Extract<TurnBlock, { kind: "tool" }>);
    if (run.length < 3) {
      elements.push(markdown(run.map(toolLine).join("\n"), true));
    } else {
      // Long runs collapse to keep the card well under Feishu's size limit.
      const running = run.filter((t) => t.status === "running").length;
      const failed = run.filter((t) => t.status === "error").length;
      const title = `🛠 ${run.length} tool calls${running ? " · running" : ""}${failed ? ` · ${failed} failed` : ""}`;
      elements.push(panel(title, [markdown(run.slice(-40).map(toolLine).join("\n"), true)]));
      const latest = run[run.length - 1];
      if (latest.status === "running") elements.push(markdown(toolLine(latest), true));
    }
  }
  if (turn.changes.length) {
    const add = turn.changes.reduce((n, f) => n + f.add, 0);
    const del = turn.changes.reduce((n, f) => n + f.del, 0);
    const list = turn.changes.slice(0, 8).map((f) => `\`${escapeInline(f.path)}\` +${f.add} −${f.del}`);
    if (turn.changes.length > 8) list.push(`and ${turn.changes.length - 8} more`);
    elements.push(panel(`📝 Changed ${turn.changes.length} ${turn.changes.length === 1 ? "file" : "files"} · +${add} −${del}`, [markdown(list.join("\n"), true)]));
  }
  if (turn.status === "running") {
    elements.push(markdown(turn.blocks.some((b) => b.kind === "tool" && b.status === "running") ? "_Running tools…_" : "_Working…_", true));
    if (options.stopToken) elements.push(button("Stop", options.stopToken, "danger"));
  } else if (turn.status === "stopped") {
    elements.push(markdown("_Stopped_", true));
  } else if (turn.status === "failed") {
    elements.push(markdown(`⚠️ ${clip(turn.error || "The agent failed.", 600)}`, true));
  } else if (!turn.hasContent()) {
    elements.push(markdown("_No reply_", true));
  }
  return maskEmails({
    schema: "2.0",
    config: { update_multi: true, summary: { content: TURN_SUMMARY[turn.status] } },
    ...(options.title ? { header: { title: { tag: "plain_text", content: clip(options.title, 80) }, template: "grey" } } : {}),
    body: { elements },
  });
}

/** A turn card left running when Aegis quit: no Stop button, marked interrupted. */
export function interruptedTurnCard(card: object): El {
  const c = structuredClone(card) as { config?: Record<string, unknown>; body?: { elements?: El[] } };
  const elements = (c.body?.elements ?? []).filter(
    (e) => e.tag !== "button" && !(e.tag === "markdown" && (e.content === "_Working…_" || e.content === "_Running tools…_")),
  );
  elements.push(markdown("_Interrupted: Aegis restarted. Send a message to continue._", true));
  return { ...c, config: { ...c.config, summary: { content: "Interrupted" } }, body: { ...c.body, elements } };
}

/** Text past the card's clip point, sent as follow-up markdown once the turn ends. */
export function answerOverflow(turn: TurnState): string {
  const text = turn.answer();
  return text.length > CARD_ANSWER_LIMIT ? text.slice(CARD_ANSWER_LIMIT) : "";
}

export function simpleCard(title: string, body: El[], template: string = "grey"): El {
  return maskEmails({
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements: body },
  });
}

// ── Approvals and questions ──────────────────────────────────────────────────

export type PromptKind = "tool" | "acp" | "question" | "desktop-only";

export function promptKind(request: PermissionRequestPayload): PromptKind {
  const input = request.input as unknown as Record<string, unknown>;
  if (input?.kind === "codex-approval") return "tool";
  if (input?.kind === "acp-permission") return "acp";
  if (Array.isArray(input?.questions)) return "question";
  return "desktop-only";
}

export interface PromptButtons {
  /** Token per action key: "once" | "session" | "deny" | `acp:<optionId>` | `q:<index>` | "submit" | "desktop". */
  token: (action: string) => string;
  /** Plan text for plan approvals (from the stream or the request). */
  plan?: string;
}

const codeBlock = (text: string) => "```\n" + clip(text, 2500).replace(/```/g, "ˋˋˋ") + "\n```";

export function promptCard(request: PermissionRequestPayload, buttons: PromptButtons): El {
  const input = request.input as unknown as Record<string, unknown>;
  const kind = promptKind(request);
  const elements: El[] = [];
  if (kind === "tool") {
    const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
    elements.push(markdown(`**${str("question") || `Allow ${request.toolName}?`}**`));
    if (str("command")) elements.push(markdown(codeBlock(str("command"))));
    if (str("filePath")) elements.push(markdown(`File: \`${escapeInline(str("filePath"))}\``, true));
    const files = Array.isArray(input.files) ? (input.files as string[]).slice(0, 8) : [];
    if (files.length) elements.push(markdown(files.map((f) => `\`${escapeInline(f)}\``).join("\n"), true));
    if (str("reason")) elements.push(markdown(clip(str("reason"), 600), true));
    if (str("cwd")) elements.push(markdown(`In \`${escapeInline(str("cwd"))}\``, true));
    const row = [button("Allow once", buttons.token("once"), "primary")];
    if (input.canAllowForSession) row.push(button("Allow for this session", buttons.token("session")));
    row.push(button("Deny", buttons.token("deny"), "danger"));
    elements.push(buttonRow(row));
    return simpleCard(`Approve ${request.toolName}`, elements, "orange");
  }
  if (kind === "acp") {
    const options = (input.options as { optionId: string; name: string; kind?: string }[]) ?? [];
    if (typeof input.title === "string") elements.push(markdown(`**${input.title}**`));
    if (typeof input.description === "string") elements.push(markdown(clip(input.description, 1200)));
    elements.push(
      buttonRow(
        options.map((o) =>
          button(o.name, buttons.token(`acp:${o.optionId}`), `${o.kind ?? ""} ${o.optionId}`.toLowerCase().includes("reject") ? "danger" : "default"),
        ),
      ),
    );
    return simpleCard(`Approve ${request.toolName}`, elements, "orange");
  }
  if (kind === "question") {
    const questions = input.questions as { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
    const plan = buttons.plan ?? (typeof input.plan === "string" ? input.plan : undefined);
    const isPlan = request.toolName === "ExitPlanMode" || !!plan;
    if (plan) elements.push(panel("📋 **Plan**", [markdown(clip(plan, 12000))], true));
    if (questions.length === 1 && !questions[0].multiSelect) {
      const q = questions[0];
      elements.push(markdown(`**${q.question}**`));
      const described = q.options.filter((o) => o.description).map((o) => `• **${o.label}**: ${o.description}`);
      if (described.length) elements.push(markdown(described.join("\n"), true));
      elements.push(buttonRow(q.options.map((o, i) => button(o.label, buttons.token(`q:${i}`), i === 0 ? "primary" : "default"))));
    } else {
      // Several questions (or multi-select) are answered together in one form.
      const fields: El[] = [];
      questions.forEach((q, i) => {
        fields.push(markdown(`**${q.question}**`));
        fields.push({
          tag: q.multiSelect ? "multi_select_static" : "select_static",
          name: `q${i}`,
          placeholder: { tag: "plain_text", content: q.multiSelect ? "Choose one or more" : "Choose one" },
          options: q.options.map((o) => ({ text: { tag: "plain_text", content: o.label }, value: o.label })),
        });
      });
      fields.push({
        tag: "button",
        text: { tag: "plain_text", content: "Submit" },
        type: "primary",
        form_action_type: "submit",
        name: "submit",
        behaviors: [{ type: "callback", value: callbackValue(buttons.token("submit")) }],
      });
      elements.push({ tag: "form", name: "answers", elements: fields });
    }
    return simpleCard(isPlan ? "Approve the plan" : "The agent has a question", elements, isPlan ? "orange" : "blue");
  }
  elements.push(markdown(`**${request.toolName}** needs approval that can only be given on the Mac.`));
  elements.push(buttonRow([button("Deny", buttons.token("deny"), "danger")]));
  return simpleCard("Approve on your Mac", elements, "orange");
}

/** A prompt card after it was answered, here or elsewhere. */
export function resolvedPromptCard(title: string, outcome: string): El {
  return simpleCard(title, [markdown(outcome, true)], "grey");
}
