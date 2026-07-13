import assert from 'node:assert/strict';
import {
  buildThemeVariables,
  getCodeThemeSeed,
} from '../../src/ui/theme/themes';

function variablesFor(codeThemeId: string, variant: 'light' | 'dark') {
  return buildThemeVariables(
    {
      codeThemeId,
      theme: getCodeThemeSeed(codeThemeId, variant),
    },
    variant,
    '',
    ''
  );
}

const codexLight = variablesFor('codex', 'light');
const absolutelyLight = variablesFor('absolutely', 'light');
const linearLight = variablesFor('linear', 'light');
const codexDark = variablesFor('codex', 'dark');
const absolutelyDark = variablesFor('absolutely', 'dark');

assert.notEqual(
  codexLight['--app-sidebar-surface'],
  absolutelyLight['--app-sidebar-surface'],
  'light sidebar surfaces should follow each theme surface'
);
assert.match(
  codexLight['--app-sidebar-surface'],
  /^color-mix\(in srgb, #[0-9a-f]{6} 72%, transparent\)$/i,
  'translucent themes should preserve the window material in the sidebar'
);
assert.match(
  linearLight['--app-sidebar-surface'],
  /^#[0-9a-f]{6}$/i,
  'opaque themes should use an opaque derived sidebar surface'
);
assert.notEqual(
  codexLight['--sidebar-item-hover'],
  absolutelyLight['--sidebar-item-hover'],
  'light sidebar interactions should follow each theme ink color'
);
assert.notEqual(
  codexDark['--app-sidebar-surface'],
  absolutelyDark['--app-sidebar-surface'],
  'dark sidebar surfaces should follow each theme surface'
);
assert.notEqual(
  codexDark['--sidebar-item-active'],
  absolutelyDark['--sidebar-item-active'],
  'dark sidebar interactions should follow each theme ink color'
);

console.log('theme variables: checks passed');
