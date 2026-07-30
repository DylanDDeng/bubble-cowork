import assert from 'node:assert/strict';
import {
  buildProviderSlashCommands,
  parseSelectedSlashCommandPrompt,
  removeSelectedSlashCommandPrompt,
  shouldAutoSubmitSlashCommand,
} from '../../src/ui/utils/claude-slash.ts';
import { normalizeClaudePermissionMode } from '../../src/ui/utils/claude-permission.ts';

function testPlanIsAlwaysAvailableForClaude() {
  const runtimeCommands = [
    {
      name: 'compact',
      title: '/compact',
      description: 'Compact context',
      source: 'session' as const,
    },
  ];
  const commands = buildProviderSlashCommands('claude', runtimeCommands);
  const plan = commands.find((command) => command.name === 'plan');

  assert.ok(plan, 'Claude should advertise the local /plan command');
  assert.equal(plan?.title, '/plan');
  assert.equal(plan?.description, 'Switch into planning mode');
  assert.equal(shouldAutoSubmitSlashCommand(plan!), false);
}

function testPlanTokenIsRemovedButTaskRemains() {
  assert.deepEqual(removeSelectedSlashCommandPrompt('/plan fix login', 'plan'), {
    prompt: 'fix login',
    cursorIndex: 'fix login'.length,
  });
  assert.deepEqual(removeSelectedSlashCommandPrompt('@reviewer /plan fix login', 'plan'), {
    prompt: '@reviewer fix login',
    cursorIndex: '@reviewer fix login'.length,
  });
  assert.deepEqual(removeSelectedSlashCommandPrompt('/PLAN', 'plan'), {
    prompt: '',
    cursorIndex: 0,
  });
}

function testPlanIsNotAStoredPermissionPreference() {
  assert.equal(normalizeClaudePermissionMode('plan'), 'default');
  assert.equal(normalizeClaudePermissionMode('auto'), 'auto');
}

function testCodexPlanIsAvailable() {
  const commands = buildProviderSlashCommands('codex');
  const plan = commands.find((command) => command.name === 'plan');

  assert.equal(plan?.title, '/plan');
  assert.equal(plan?.description, 'Switch into planning mode');
  assert.equal(shouldAutoSubmitSlashCommand(plan!), false);
}

function testOtherProvidersKeepTheirOwnPlanBehavior() {
  const grokCommands = buildProviderSlashCommands('grok');
  const parsed = parseSelectedSlashCommandPrompt('/plan inspect auth', grokCommands);

  assert.equal(parsed?.command.name, 'plan');
  assert.equal(parsed?.remainder, 'inspect auth');
  assert.equal(parsed?.command.description, 'Enter plan mode for the next turn');
}

testPlanIsAlwaysAvailableForClaude();
testPlanTokenIsRemovedButTaskRemains();
testPlanIsNotAStoredPermissionPreference();
testCodexPlanIsAvailable();
testOtherProvidersKeepTheirOwnPlanBehavior();
console.log('claude-plan-slash-command.test.ts: ok');
