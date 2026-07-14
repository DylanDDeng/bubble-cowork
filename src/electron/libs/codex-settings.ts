import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  CodexModelConfig,
  CodexReasoningEffort,
  CodexReasoningLevelOption,
} from '../../shared/types';
import {
  expandCodexModelFamilies,
  seedLabelForCodexModel,
  seedPriorityForCodexModel,
  unionCodexModelNames,
} from '../../shared/codex-model-catalog';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CODEX_MODELS_CACHE_PATH = join(homedir(), '.codex', 'models_cache.json');

// Authoritative model catalog pushed by the codex app-server (model/list),
// keyed by model slug. Empty until a live process exists — getCodexModelConfig
// falls back to the models_cache heuristic for the first frame (P0-3).
const runtimeModelCatalog = new Map<string, { supportsFastMode: boolean; fastTierName?: string }>();

/**
 * Ingest a `model_catalog_updated` push. Fast eligibility: exactly one
 * non-default serviceTier (provisional heuristic — the protocol carries no
 * speed semantics on tiers, so we surface the tier name for transparency).
 */
export function setCodexRuntimeModelCatalog(models: unknown[]): void {
  runtimeModelCatalog.clear();
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      model?: unknown;
      id?: unknown;
      serviceTiers?: unknown;
      defaultServiceTier?: unknown;
    };
    const slug =
      (typeof entry.model === 'string' && entry.model) ||
      (typeof entry.id === 'string' && entry.id) ||
      '';
    if (!slug) continue;
    const tiers = Array.isArray(entry.serviceTiers) ? entry.serviceTiers : [];
    const defaultTier = typeof entry.defaultServiceTier === 'string' ? entry.defaultServiceTier : null;
    const nonDefault = tiers.filter(
      (tier): tier is { id: string; name?: string } =>
        !!tier && typeof tier === 'object' && typeof (tier as { id?: unknown }).id === 'string' &&
        (tier as { id: string }).id !== defaultTier
    );
    runtimeModelCatalog.set(slug, {
      supportsFastMode: nonDefault.length === 1,
      ...(nonDefault.length === 1 && typeof nonDefault[0].name === 'string'
        ? { fastTierName: nonDefault[0].name }
        : {}),
    });
  }
}
const CODEX_MODEL_VISIBILITY_PATH = () => join(app.getPath('userData'), 'codex-model-visibility.json');
/** Sticky union of catalog models so incomplete online refreshes cannot shrink the picker. */
const CODEX_MODEL_CATALOG_MEMORY_PATH = () =>
  join(app.getPath('userData'), 'codex-model-catalog-memory.json');

type CodexCachedModel = {
  slug?: string;
  /** Codex uses "list" / "hide" (not always "hidden"). */
  visibility?: string;
  display_name?: string;
  name?: string;
  default_reasoning_level?: string;
  supported_in_api?: boolean;
  priority?: number;
  upgrade?: unknown;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
};

type CodexModelsCache = {
  models?: CodexCachedModel[];
};

type CodexModelVisibilityConfig = {
  hiddenModels?: string[];
};

type CodexCatalogMemoryEntry = {
  name: string;
  label?: string;
  priority?: number | null;
  defaultReasoningEffort?: string | null;
  supportedReasoningLevels?: Array<{
    effort?: string;
    description?: string;
  }>;
  supportsFastMode?: boolean;
};

type CodexCatalogMemory = {
  models?: CodexCatalogMemoryEntry[];
  updatedAt?: number;
};

function readCodexConfigText(): string {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) {
      return '';
    }
    return readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch (error) {
    console.warn('Failed to read Codex config:', error);
    return '';
  }
}

function readCodexModelsCache(): CodexModelsCache {
  try {
    if (!existsSync(CODEX_MODELS_CACHE_PATH)) {
      return {};
    }
    return JSON.parse(readFileSync(CODEX_MODELS_CACHE_PATH, 'utf-8')) as CodexModelsCache;
  } catch (error) {
    console.warn('Failed to read Codex models cache:', error);
    return {};
  }
}

function readCodexModelVisibility(): CodexModelVisibilityConfig {
  try {
    const visibilityPath = CODEX_MODEL_VISIBILITY_PATH();
    if (!existsSync(visibilityPath)) {
      return {};
    }

    return JSON.parse(readFileSync(visibilityPath, 'utf-8')) as CodexModelVisibilityConfig;
  } catch (error) {
    console.warn('Failed to read Codex model visibility config:', error);
    return {};
  }
}

function writeCodexModelVisibility(hiddenModels: string[]): void {
  try {
    writeFileSync(
      CODEX_MODEL_VISIBILITY_PATH(),
      JSON.stringify({ hiddenModels }, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.warn('Failed to save Codex model visibility config:', error);
  }
}

function readCodexCatalogMemory(): CodexCatalogMemory {
  try {
    const path = CODEX_MODEL_CATALOG_MEMORY_PATH();
    if (!existsSync(path)) {
      return {};
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as CodexCatalogMemory;
  } catch (error) {
    console.warn('Failed to read Codex model catalog memory:', error);
    return {};
  }
}

function writeCodexCatalogMemory(models: CodexCatalogMemoryEntry[]): void {
  try {
    writeFileSync(
      CODEX_MODEL_CATALOG_MEMORY_PATH(),
      JSON.stringify({ models, updatedAt: Date.now() } satisfies CodexCatalogMemory, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.warn('Failed to save Codex model catalog memory:', error);
  }
}

function isCodexModelVisibleInCache(model: CodexCachedModel): boolean {
  const visibility = (model.visibility || 'list').trim().toLowerCase();
  // Codex cache uses "list" for picker entries and "hide" for internal-only
  // models (e.g. codex-auto-review). Older builds sometimes used "hidden".
  return visibility !== 'hide' && visibility !== 'hidden';
}

function sortCodexModelsByPriority(
  names: string[],
  priorityByName: Map<string, number | null | undefined>
): string[] {
  return names.slice().sort((left, right) => {
    const leftPriority =
      typeof priorityByName.get(left) === 'number'
        ? (priorityByName.get(left) as number)
        : Number.MAX_SAFE_INTEGER;
    const rightPriority =
      typeof priorityByName.get(right) === 'number'
        ? (priorityByName.get(right) as number)
        : Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.localeCompare(right);
  });
}

function getDetectedCodexModels(
  defaultModel: string | null,
  priorityByName: Map<string, number | null | undefined>
): string[] {
  const cache = readCodexModelsCache();
  const listed = (cache.models || [])
    .filter(isCodexModelVisibleInCache)
    .map((model) => model.slug?.trim())
    .filter((slug): slug is string => Boolean(slug));

  const remembered = (readCodexCatalogMemory().models || [])
    .map((model) => model.name?.trim())
    .filter((name): name is string => Boolean(name));

  // Union: config default + live cache + sticky memory, then expand known families.
  // We intentionally never shrink on incomplete online refreshes.
  const merged = expandCodexModelFamilies(
    unionCodexModelNames(
      [defaultModel || ''].filter(Boolean),
      unionCodexModelNames(listed, remembered)
    )
  );

  return sortCodexModelsByPriority(merged, priorityByName);
}

function normalizeCodexReasoningEffort(
  value?: string | null
): CodexReasoningEffort | null {
  // Open vocabulary: the valid set is model-specific and comes from
  // models_cache `supported_reasoning_levels`, so pass any non-empty slug
  // through (a whitelist here silently dropped config "ultra"/"max").
  const normalized = (value || '').trim().toLowerCase();
  return normalized || null;
}

function normalizeSupportedReasoningLevels(
  levels?: CodexCachedModel['supported_reasoning_levels']
): CodexReasoningLevelOption[] {
  return (levels || [])
    .map((level) => {
      const effort = normalizeCodexReasoningEffort(level?.effort);
      if (!effort) {
        return null;
      }

      return {
        effort,
        description: level?.description?.trim() || effort,
      } satisfies CodexReasoningLevelOption;
    })
    .filter((level): level is CodexReasoningLevelOption => Boolean(level));
}

export function getCodexModelConfig(): CodexModelConfig {
  const configText = readCodexConfigText();
  const defaultModelMatch = configText.match(/^model\s*=\s*"([^"]+)"/m);
  const defaultModel = defaultModelMatch?.[1]?.trim() || null;
  const defaultReasoningEffortMatch = configText.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
  const defaultReasoningEffort = normalizeCodexReasoningEffort(defaultReasoningEffortMatch?.[1] || null);
  const cache = readCodexModelsCache();
  const memoryEntries = readCodexCatalogMemory().models || [];
  const localHidden = new Set(
    (readCodexModelVisibility().hiddenModels || [])
      .map((model) => model.trim())
      .filter(Boolean)
  );

  const cachedModelsBySlug = new Map(
    (cache.models || [])
      .map((model) => [model.slug?.trim(), model] as const)
      .filter((entry): entry is [string, CodexCachedModel] => Boolean(entry[0]))
  );
  const memoryByName = new Map(
    memoryEntries
      .map((entry) => [entry.name?.trim(), entry] as const)
      .filter((entry): entry is [string, CodexCatalogMemoryEntry] => Boolean(entry[0]))
  );

  const priorityByName = new Map<string, number | null | undefined>();
  for (const [slug, cached] of cachedModelsBySlug) {
    priorityByName.set(slug, typeof cached.priority === 'number' ? cached.priority : null);
  }
  for (const [name, remembered] of memoryByName) {
    if (!priorityByName.has(name) && typeof remembered.priority === 'number') {
      priorityByName.set(name, remembered.priority);
    }
  }
  for (const seedName of expandCodexModelFamilies(defaultModel ? [defaultModel] : [])) {
    if (!priorityByName.has(seedName)) {
      priorityByName.set(seedName, seedPriorityForCodexModel(seedName));
    }
  }

  const detectedModels = getDetectedCodexModels(defaultModel, priorityByName);

  const availableModels = detectedModels.map((name) => {
    const cached = cachedModelsBySlug.get(name);
    const remembered = memoryByName.get(name);
    const displayName =
      cached?.display_name?.trim() ||
      cached?.name?.trim() ||
      remembered?.label?.trim() ||
      seedLabelForCodexModel(name) ||
      null;
    const cachedReasoningLevels = normalizeSupportedReasoningLevels(
      cached?.supported_reasoning_levels
    );
    const rememberedReasoningLevels = normalizeSupportedReasoningLevels(
      remembered?.supportedReasoningLevels
    );
    const supportedReasoningLevels =
      cachedReasoningLevels.length > 0 ? cachedReasoningLevels : rememberedReasoningLevels;
    const priority =
      (typeof cached?.priority === 'number' ? cached.priority : null) ??
      (typeof remembered?.priority === 'number' ? remembered.priority : null) ??
      seedPriorityForCodexModel(name);
    // Fast-mode eligibility: the app-server `model/list` catalog is
    // authoritative (a model is fast-eligible iff it has exactly one
    // non-default serviceTier — P0-3). The models_cache priority heuristic
    // below is only the first-frame fallback until a live process pushes the
    // real catalog.
    const runtimeEntry = runtimeModelCatalog.get(name);
    const supportsFastMode = runtimeEntry
      ? runtimeEntry.supportsFastMode
      : cached?.supported_in_api === true &&
          typeof cached?.priority === 'number' &&
          cached.priority === 1 &&
          !cached?.upgrade
        ? true
        : remembered?.supportsFastMode === true;

    return {
      name,
      label: displayName || undefined,
      enabled: !localHidden.has(name),
      isDefault: defaultModel === name,
      defaultReasoningEffort:
        normalizeCodexReasoningEffort(cached?.default_reasoning_level) ||
        normalizeCodexReasoningEffort(remembered?.defaultReasoningEffort) ||
        defaultReasoningEffort,
      supportedReasoningLevels,
      supportsFastMode,
      priority,
    };
  });

  // Persist sticky union so a later incomplete models_cache rewrite cannot
  // drop Sol/Terra/Luna (or any other model we have already observed).
  writeCodexCatalogMemory(
    availableModels.map((model) => ({
      name: model.name,
      label: model.label,
      priority: model.priority ?? null,
      defaultReasoningEffort: model.defaultReasoningEffort || null,
      supportedReasoningLevels: (model.supportedReasoningLevels || []).map((level) => ({
        effort: level.effort,
        description: level.description,
      })),
      supportsFastMode: model.supportsFastMode === true,
    }))
  );

  // Picker options only include models the user has not hidden in Aegis.
  const options = availableModels.filter((model) => model.enabled).map((model) => model.name);

  return { defaultModel, defaultReasoningEffort, options, availableModels };
}

export function saveCodexModelVisibility(enabledModels: string[]): CodexModelConfig {
  const nextEnabledModels = new Set(
    enabledModels
      .map((model) => model.trim())
      .filter((model) => model.length > 0)
  );
  const current = getCodexModelConfig();
  const detectedModels = current.availableModels.map((model) => model.name);
  const hiddenModels = detectedModels.filter((model) => !nextEnabledModels.has(model));
  writeCodexModelVisibility(hiddenModels);
  return getCodexModelConfig();
}
