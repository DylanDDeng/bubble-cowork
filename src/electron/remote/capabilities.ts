import type { ClaudeSkillSummary, StreamMessage } from "../../shared/types";
import type { RemoteCapabilities, RemoteProvider } from "../../shared/remote/protocol";
import { listClaudeSkills } from "../libs/claude-skills";
import { ensureProviderService } from "../libs/agent-loop";
import { getProviderService } from "../libs/provider/service";
import {
  buildProviderSlashCommands,
  getSessionSlashCommands,
  parseSelectedSlashCommandPrompt,
  type ClaudeSlashCommand,
} from "../../ui/utils/claude-slash";
import { getSessionSkillNames, mergeClaudeSkills, parseSelectedSkillPrompt } from "../../ui/utils/claude-skills";
import { buildCodexReferencePayload, type CodexReferencePayload } from "../../ui/utils/codex-composer";
import { flattenCodexPluginSlashSkills, toSlashSkills } from "../../ui/utils/provider-slash-skills";

/**
 * Commands the desktop handles in its own UI rather than sending to the agent:
 * /goal opens the goal editor and /rewind the checkpoint dialog. The phone has
 * neither, and sent as text they would reach the agent as a plain prompt.
 */
const DESKTOP_ONLY_COMMANDS = new Set(["goal", "rewind"]);

/** The desktop composer's skill catalog for a provider (paths included). */
async function providerSkills(provider: RemoteProvider, cwd: string, history: StreamMessage[]): Promise<ClaudeSkillSummary[]> {
  if (provider === "claude") {
    const { userSkills, projectSkills } = listClaudeSkills(cwd);
    return mergeClaudeSkills(userSkills, projectSkills, getSessionSkillNames(history));
  }
  if (provider === "codex") {
    ensureProviderService();
    const [skills, plugins] = await Promise.all([
      getProviderService().listSkills({ provider: "codex", cwd }),
      getProviderService().listPlugins({ provider: "codex", cwd }),
    ]);
    return mergeClaudeSkills(flattenCodexPluginSlashSkills(plugins), toSlashSkills(skills.skills));
  }
  if (provider === "bubble") {
    ensureProviderService();
    return toSlashSkills((await getProviderService().listSkills({ provider: "bubble", cwd })).skills);
  }
  // Devin and MiMo report their commands (skills included) over ACP.
  return [];
}

const skillCache = new Map<string, { at: number; skills: Promise<ClaudeSkillSummary[]> }>();
const SKILL_TTL = 30_000;

function cachedSkills(provider: RemoteProvider, cwd: string, history: StreamMessage[]) {
  // Claude's order depends on the session's own skills; the rest are per project.
  const key = `${provider} ${cwd}`;
  const hit = skillCache.get(key);
  if (provider !== "claude" && hit && Date.now() - hit.at < SKILL_TTL) return hit.skills;
  const skills = providerSkills(provider, cwd, history).catch(() => []);
  skillCache.set(key, { at: Date.now(), skills });
  return skills;
}

/** What the phone's "/" and "$" menus offer; skill paths stay on the Mac. */
export async function composerCapabilities(
  provider: RemoteProvider,
  cwd: string,
  history: StreamMessage[],
): Promise<RemoteCapabilities> {
  const commands = buildProviderSlashCommands(provider, getSessionSlashCommands(history))
    .filter((command) => !DESKTOP_ONLY_COMMANDS.has(command.name.toLowerCase()));
  const skills = await cachedSkills(provider, cwd, history);
  return {
    commands: commands.map(({ name, description, source, submitOnSelect, inputHint }) => ({
      name,
      description,
      source,
      ...(submitOnSelect ? { submitOnSelect } : {}),
      ...(inputHint ? { inputHint } : {}),
    })),
    skills: skills.map(({ name, title, description, source }) => ({
      name,
      title,
      ...(description ? { description } : {}),
      source,
    })),
  };
}

/**
 * Codex runs a skill from a reference, not from the prompt text. The desktop adds
 * it when a skill is picked; a phone prompt that leads with one gets the same here.
 */
export async function codexReferences(prompt: string, cwd: string): Promise<CodexReferencePayload> {
  // Don't hold the task up on a slow catalog; the prompt text still names the skill.
  const skills = await Promise.race([
    cachedSkills("codex", cwd, []),
    new Promise<ClaudeSkillSummary[]>((resolve) => setTimeout(() => resolve([]), 3000)),
  ]);
  const picked = parseSelectedSkillPrompt(prompt, skills, ["/", "$"]);
  if (!picked) return {};
  // A builtin like /review runs as a command, as on the desktop.
  const commands: ClaudeSlashCommand[] = buildProviderSlashCommands("codex");
  if (picked.prefix === "/" && parseSelectedSlashCommandPrompt(prompt, commands)) return {};
  return buildCodexReferencePayload(picked.skill);
}
