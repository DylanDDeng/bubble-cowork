import { useMemo } from 'react';
import { Plug, SkillStack, Terminal } from './icons';
import { SelectedClaudeCommandChip } from './SelectedClaudeCommandChip';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { useAppStore } from '../store/useAppStore';
import { useProviderSlashSkills } from '../hooks/useProviderSlashSkills';
import type { ClaudeSlashCommand } from '../utils/claude-slash';
import {
  buildProviderSlashCommands,
  getSessionSlashCommands,
  parseSelectedSlashCommandPrompt,
} from '../utils/claude-slash';
import {
  getSessionSkillNames,
  mergeClaudeSkills,
  normalizeSkillToken,
  parseSelectedSkillPrompt,
} from '../utils/claude-skills';
import type { ClaudeSkillSummary, SessionView } from '../types';

/**
 * How a sent prompt's leading "/" or "$" token should render: the same chip
 * the composer showed while typing. Shared by the chat transcript and the
 * board timeline so a skill looks identical on both surfaces.
 */
export type PromptPrefixDisplay =
  | { kind: 'command'; command: ClaudeSlashCommand; remainder: string }
  | { kind: 'skill'; skill: ClaudeSkillSummary; remainder: string }
  | { kind: 'generic'; name: string; prefix: '/' | '$'; remainder: string };

export function extractGenericSlashPrompt(
  prompt: string
): { name: string; prefix: '/' | '$'; remainder: string } | null {
  const trimmed = prompt.trimStart();
  const prefix = trimmed[0];
  if (prefix !== '/' && prefix !== '$') {
    return null;
  }

  const firstWhitespaceIndex = trimmed.search(/\s/);
  const name =
    firstWhitespaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, firstWhitespaceIndex);

  if (!name) {
    return null;
  }

  const remainder =
    firstWhitespaceIndex === -1 ? '' : trimmed.slice(firstWhitespaceIndex).replace(/^\s+/, '');

  return { name, prefix, remainder };
}

/** Resolve a sent prompt's leading token against the session's skills and commands. */
export function usePromptPrefixDisplay(
  prompt: string,
  session: SessionView | null | undefined
): PromptPrefixDisplay | null {
  const claudeUserSkills = useAppStore((state) => state.claudeUserSkills);
  const claudeProjectSkills = useAppStore((state) => state.claudeProjectSkills);
  const sessionMessages = session?.messages || [];
  const provider = session?.provider;
  // Same shared catalog the composer chips use (codex/kimi/qoder), so a
  // token that rendered as a skill chip while typing keeps that look after
  // sending instead of degrading to the generic command style.
  const providerSlashSkills = useProviderSlashSkills(provider, session?.cwd);
  const availableSkills = useMemo(
    () =>
      mergeClaudeSkills(
        mergeClaudeSkills(claudeUserSkills, claudeProjectSkills, getSessionSkillNames(sessionMessages)),
        providerSlashSkills
      ),
    [sessionMessages, claudeProjectSkills, claudeUserSkills, providerSlashSkills]
  );
  const availableCommands = useMemo(
    () => buildProviderSlashCommands(provider || 'claude', getSessionSlashCommands(sessionMessages)),
    [provider, sessionMessages]
  );

  return useMemo<PromptPrefixDisplay | null>(() => {
    // Kimi skill invocations are literal `/skill:<name>` tokens; render them
    // with the same skill chip the composer showed (never the generic
    // command style), even when the catalog fetch hasn't landed yet.
    const kimiToken = prompt.trimStart().match(/^\/skill:(\S+)([\s\S]*)$/);
    if (kimiToken) {
      const normalized = normalizeSkillToken(kimiToken[1]);
      const skill =
        availableSkills.find((item) => normalizeSkillToken(item.name) === normalized) ||
        ({
          name: kimiToken[1],
          title: kimiToken[1],
          path: '',
          source: 'user',
        } satisfies ClaudeSkillSummary);
      return { kind: 'skill', skill, remainder: kimiToken[2].replace(/^\s+/, '') };
    }

    const skillState = parseSelectedSkillPrompt(prompt, availableSkills, ['/', '$']);
    const commandState = parseSelectedSlashCommandPrompt(prompt, availableCommands);
    // Codex builtin commands win over same-named skills on `/` tokens —
    // mirrors the composer's routing so both surfaces show the same chip.
    const skillWins =
      skillState && !(provider === 'codex' && skillState.prefix === '/' && commandState);
    if (skillState && skillWins) {
      return { kind: 'skill', skill: skillState.skill, remainder: skillState.remainder };
    }
    if (commandState) {
      return { kind: 'command', command: commandState.command, remainder: commandState.remainder };
    }
    const genericState = extractGenericSlashPrompt(prompt);
    if (genericState) {
      return {
        kind: 'generic',
        name: genericState.name,
        prefix: genericState.prefix,
        remainder: genericState.remainder,
      };
    }
    return null;
  }, [provider, availableCommands, availableSkills, prompt]);
}

export function GenericSlashChip({
  name,
  prefix = '/',
  compact = false,
}: {
  name: string;
  prefix?: '/' | '$';
  compact?: boolean;
}) {
  const isPlugin = /^plugin:/i.test(name);
  const cleanedName = name.replace(/^plugin:/i, '').replace(/^\//, '');
  const label = prefix === '$' || compact ? cleanedName : `/${cleanedName}`;
  // `$` mentions are skills unless explicitly plugin-prefixed — match the
  // composer chip's SkillStack icon so sent messages look the same.
  const Icon = prefix === '$' ? (isPlugin ? Plug : SkillStack) : Terminal;

  return (
    <div
      className={`composer-inline-chip composer-inline-chip--message ${
        prefix === '$'
          ? isPlugin
            ? 'composer-inline-chip--plugin'
            : 'composer-inline-chip--skill'
          : 'composer-inline-chip--command'
      } ${compact ? '' : 'composer-inline-chip--large'}`}
      title={`${prefix}${name}`}
    >
      <span className="composer-inline-chip__icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="composer-inline-chip__label max-w-[180px]">{label}</span>
    </div>
  );
}

/** The chip for a resolved prefix, in the transcript's compact size. */
export function PromptPrefixChip({ display }: { display: PromptPrefixDisplay }) {
  if (display.kind === 'skill') return <SelectedClaudeSkillChip skill={display.skill} compact />;
  if (display.kind === 'command') {
    return <SelectedClaudeCommandChip command={display.command} compact />;
  }
  return <GenericSlashChip name={display.name} prefix={display.prefix} compact />;
}
