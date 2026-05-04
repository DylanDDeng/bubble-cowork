export type AegisSkillScope = 'repo' | 'user' | 'system' | 'plugin' | 'legacy-claude';

export type AegisSkillSource = 'agents' | 'codex' | 'claude' | 'plugin' | 'system';

export interface AegisSkillInterface {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
}

export interface AegisSkillPolicy {
  allowImplicitInvocation?: boolean;
  products?: string[];
}

export interface AegisSkillToolDependency {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  command?: string;
  url?: string;
}

export interface AegisSkillDependencies {
  tools: AegisSkillToolDependency[];
}

export interface AegisSkillDescriptor {
  name: string;
  title?: string;
  description: string;
  shortDescription?: string;
  scope: AegisSkillScope;
  source: AegisSkillSource;
  root: string;
  path: string;
  relativePath: string;
  skillDir: string;
  interface?: AegisSkillInterface;
  policy?: AegisSkillPolicy;
  dependencies?: AegisSkillDependencies;
}

export interface AegisSkillLoadOutcome {
  skills: AegisSkillDescriptor[];
  errors: Array<{ path: string; message: string }>;
  roots: string[];
}

export interface AegisRenderedSkills {
  prompt: string;
  warning?: string;
  report: {
    totalCount: number;
    includedCount: number;
    omittedCount: number;
    truncatedDescriptionChars: number;
  };
}
