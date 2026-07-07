/**
 * Stable, decorative identity for a subagent (a Task tool call), derived
 * purely from its `parentToolUseId` (the backend tool_use id — the only
 * globally-stable key we have; the backend does not name subagent instances).
 *
 * Design constraints that shaped this (from design review):
 *  - The PRIMARY label is functional (`Explore · 产品视角`), built from the
 *    backend `subagent_type` + `description`, so it is self-explanatory and
 *    stays aligned with logs/search (which only carry those fields).
 *  - The persona name + color are a DECORATIVE accent for quick visual
 *    separation of parallel subagents — never the source of truth for "what
 *    this agent does".
 *  - Everything is a PURE function of the id: no session-global registry, no
 *    "first-come-first-named" reassignment. That is what makes the name and
 *    color rock-stable across streaming, rewind, and reloads — the reviewer's
 *    top correctness concern was persona names jittering mid-stream because a
 *    collision-resolution pass depended on arrival order. There is none here.
 *    A rare persona-name collision between two parallel subagents is
 *    cosmetically harmless because the functional label + color disambiguate.
 */

// A pool of mathematician/physicist surnames. Large enough that same-session
// persona collisions are rare; if two collide it's harmless (see module doc).
const PERSONA_NAMES = [
  'Banach', 'Dirac', 'Euler', 'Gauss', 'Noether', 'Riemann', 'Hilbert',
  'Poincaré', 'Turing', 'Lovelace', 'Ramanujan', 'Cantor', 'Fermat',
  'Galois', 'Fourier', 'Laplace', 'Bernoulli', 'Cauchy', 'Leibniz',
  'Maxwell', 'Planck', 'Bohr', 'Heisenberg', 'Feynman', 'Fermi',
  'Curie', 'Pauli', 'Schrödinger', 'Boltzmann', 'Kepler', 'Newton',
  'Tesla', 'Hopper', 'Shannon', 'Nash', 'Erdős', 'Chebyshev',
  'Kolmogorov', 'Markov', 'Gödel',
];

/** djb2 — small, fast, well-distributed for short ascii ids. */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Human-readable subagent type: "general-purpose" → "General-purpose". */
function formatAgentType(type: string | null | undefined): string {
  const trimmed = (type || '').trim();
  if (!trimmed) return 'Subagent';
  return capitalize(trimmed);
}

/** First line of the task description, trimmed to a chip-friendly length. */
function formatDescription(description: string | null | undefined, maxChars = 32): string {
  const firstLine = (description || '').split('\n')[0].trim();
  if (!firstLine) return '';
  if (firstLine.length <= maxChars) return firstLine;
  return `${firstLine.slice(0, maxChars).trimEnd()}…`;
}

export interface SubagentPersona {
  /** Stable key = the parentToolUseId. */
  id: string;
  /** Primary, self-explanatory label, e.g. "Explore · 产品视角". */
  functionalName: string;
  /** Decorative persona name, e.g. "Banach". Stable per id. */
  persona: string;
  /** Decorative HSL hue [0,360) for a color dot. Stable per id. */
  colorHue: number;
  /** Short id tail (last 4 chars) for absolute disambiguation when shown. */
  shortId: string;
}

export function getSubagentPersona(
  parentToolUseId: string,
  subagentType?: string | null,
  description?: string | null
): SubagentPersona {
  const id = parentToolUseId;
  const nameHash = hashString(id);
  const persona = PERSONA_NAMES[nameHash % PERSONA_NAMES.length];
  // A second, differently-seeded hash so hue is not correlated with the name
  // index (which would make same-name subagents also share a hue).
  const colorHue = hashString(`hue:${id}`) % 360;
  const typeLabel = formatAgentType(subagentType);
  const desc = formatDescription(description);
  const functionalName = desc ? `${typeLabel} · ${desc}` : typeLabel;
  const shortId = id.length > 4 ? id.slice(-4) : id;

  return { id, functionalName, persona, colorHue, shortId };
}
