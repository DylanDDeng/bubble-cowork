// The composer's "/" and "$" menus, built with the desktop composer's helpers
// (useComposerCapabilityMenu + ClaudeSkillMenu) from the list the Mac sends.
import type { RemoteCapabilities } from "../../../src/shared/remote/protocol";
import type { ClaudeSkillSummary } from "../../../src/ui/types";
import type { ClaudeSlashCommand } from "../../../src/ui/utils/claude-slash";
import { removeSelectedSlashCommandPrompt } from "../../../src/ui/utils/claude-slash";
import { buildComposerCapabilitySuggestions } from "../../../src/ui/utils/composer-capabilities";
import { detectComposerTrigger, replaceComposerTriggerText } from "../../../src/ui/utils/composer-triggers";
import {
  commandGlyph,
  commandTitle,
  groupSuggestions,
  skillScopeLabel,
} from "../../../src/ui/utils/slash-menu";

export interface ComposerMenuItem {
  id: string;
  kind: "command" | "skill";
  title: string;
  detail: string | null;
  /** "/compact" for a command, the scope ("Project") for a skill. */
  meta: string;
  /** A slash-menu glyph for commands; "skill" or "plugin" for skills. */
  glyph: string;
  /** The draft after picking this item. */
  draft: string;
  /** Send the new draft right away (the desktop's submit-on-select commands). */
  submit: boolean;
  /** Handled by the app instead of sent: "plan" turns on Plan first, "model" opens the picker. */
  action: "plan" | "model" | null;
}

export interface ComposerMenu {
  title: string;
  emptyMessage: string;
  groups: { id: string; label: string | null; items: ComposerMenuItem[] }[];
}

/** Providers whose "/" menu lists skills too, and their skill prefix on "/". */
const SLASH_SKILLS: Record<string, "/" | "$"> = { claude: "/", codex: "$", bubble: "/" };
const PLAN_COMMAND = new Set(["claude", "codex", "bubble"]);

export function composerMenu({
  provider,
  draft,
  capabilities,
  supportsPlan,
}: {
  provider: string;
  draft: string;
  capabilities: RemoteCapabilities | null;
  supportsPlan: boolean;
}): ComposerMenu | null {
  // The phone edits at the end of the draft; a capability token only counts at its start.
  const trigger = detectComposerTrigger(draft, draft.length);
  if (!trigger) return null;

  if (trigger.kind === "slash-model") {
    const item: ComposerMenuItem = {
      id: "local:model",
      kind: "command",
      title: "Model",
      detail: "Choose the model and reasoning",
      meta: "/model",
      glyph: "brain",
      draft: replaceComposerTriggerText(draft, trigger, "").prompt.trimStart(),
      submit: false,
      action: "model",
    };
    return { title: "Models", emptyMessage: "No matching models.", groups: [{ id: "built-in", label: null, items: [item] }] };
  }

  const commands: ClaudeSlashCommand[] = (capabilities?.commands ?? []).map((c) => ({
    name: c.name,
    title: `/${c.name}`,
    description: c.description,
    source: c.source,
    submitOnSelect: c.submitOnSelect,
    inputHint: c.inputHint,
  }));
  // Paths stay on the Mac; the menu only needs names.
  const skills: ClaudeSkillSummary[] = (capabilities?.skills ?? []).map((s) => ({ ...s, path: "" }));
  const slashSkills = SLASH_SKILLS[provider];
  const suggestions = buildComposerCapabilitySuggestions({
    enabled: true,
    query: trigger.query,
    triggerKind: trigger.kind,
    availableCommands: commands,
    availableSkills: skills,
    includeCommands: trigger.kind !== "skill",
    includeSkills: trigger.kind === "skill" || !!slashSkills,
    skillLimit: provider === "codex" || provider === "bubble" ? 80 : undefined,
  });

  const items = new Map<object, ComposerMenuItem>();
  for (const suggestion of suggestions) {
    if (suggestion.kind === "command") {
      const { command } = suggestion;
      const replaced = replaceComposerTriggerText(draft, trigger, `/${command.name} `).prompt;
      const plan = command.name === "plan" && PLAN_COMMAND.has(provider) && supportsPlan;
      items.set(suggestion, {
        id: `command:${command.name}`,
        kind: "command",
        title: commandTitle(command),
        detail: command.description || command.inputHint || null,
        meta: `/${command.name}`,
        glyph: commandGlyph(command),
        draft: plan ? removeSelectedSlashCommandPrompt(replaced, command.name).prompt : replaced,
        submit: !plan && command.submitOnSelect === true,
        action: plan ? "plan" : null,
      });
    } else {
      const { skill } = suggestion;
      // Same text the desktop inserts, whichever key opened the menu: Claude and
      // Bubble run `/name`, Codex `$name`; spaced names are hyphenated.
      const prefix = slashSkills ?? "$";
      const name = skill.name.replace(/^[/$\s]+/, "").replace(/\s+/g, "-");
      items.set(suggestion, {
        id: `skill:${skill.source}:${skill.name}`,
        kind: "skill",
        title: skill.title || skill.name,
        detail: skill.description || null,
        meta: skillScopeLabel(skill.source),
        glyph: skill.source === "plugin" ? "plugin" : "skill",
        draft: replaceComposerTriggerText(draft, trigger, `${prefix}${name} `).prompt,
        submit: false,
        action: null,
      });
    }
  }

  const skillsOnly = trigger.kind === "skill";
  return {
    title: skillsOnly ? "Skills" : slashSkills ? "Commands & Skills" : "Commands",
    emptyMessage: skillsOnly
      ? "No matching skills."
      : slashSkills
        ? "No matching commands or skills."
        : "No matching commands.",
    groups: groupSuggestions(suggestions).map((group) => ({
      id: group.id,
      label: group.label,
      items: group.suggestions.map(({ suggestion }) => items.get(suggestion)!),
    })),
  };
}
