import assert from 'node:assert/strict';
import {
  buildProviderSlashCommands,
  getSessionSlashCommands,
  parseSelectedSlashCommandPrompt,
  shouldAutoSubmitSlashCommand,
} from '../../src/ui/utils/claude-slash.ts';
import type { StreamMessage } from '../../src/shared/types.ts';

function testDefaultGrokCatalog() {
  const commands = buildProviderSlashCommands('grok');
  assert.ok(commands.length > 20, `expected a full Grok builtin catalog, got ${commands.length}`);
  const byName = new Map(commands.map((command) => [command.name, command]));

  assert.equal(byName.get('compact')?.title, '/compact');
  assert.equal(byName.get('compact')?.source, 'default');
  assert.ok(byName.get('compact')?.description?.includes('Compress'));
  assert.equal(byName.get('compact')?.inputHint, 'optional context about what to preserve');

  assert.equal(byName.get('context')?.submitOnSelect, true);
  assert.equal(byName.get('always-approve')?.title, '/always-approve');
  assert.equal(byName.get('plan')?.title, '/plan');
  assert.equal(byName.get('imagine')?.title, '/imagine');
  assert.equal(byName.get('loop')?.title, '/loop');

  // Keep the same shape other providers use: title always starts with /
  for (const command of commands) {
    assert.equal(command.title.startsWith('/'), true, `${command.name} title should start with /`);
  }
}

function testSessionAcpCommandsMergeAndEnrich() {
  const sessionMessages = [
    {
      type: 'system',
      subtype: 'available_commands_update',
      session_id: 's1',
      availableCommands: [
        {
          name: 'compact',
          description: 'Compress conversation history to save context window',
          input: { hint: 'optional context about what to preserve' },
        },
        {
          name: 'my-skill',
          description: 'A user skill advertised as a slash command',
        },
      ],
    },
  ] as StreamMessage[];

  const sessionCommands = getSessionSlashCommands(sessionMessages);
  const commands = buildProviderSlashCommands('grok', sessionCommands);
  const byName = new Map(commands.map((command) => [command.name, command]));

  // ACP skill retained
  assert.equal(byName.get('my-skill')?.source, 'acp');
  assert.equal(byName.get('my-skill')?.description, 'A user skill advertised as a slash command');

  // ACP compact enriched with static title/hint
  assert.equal(byName.get('compact')?.title, '/compact');
  assert.equal(byName.get('compact')?.inputHint, 'optional context about what to preserve');

  // Static builtins still present when ACP list is partial
  assert.ok(byName.has('session-info'));
  assert.ok(byName.has('always-approve'));
}

function testParseAndAutoSubmit() {
  const commands = buildProviderSlashCommands('grok');
  const parsed = parseSelectedSlashCommandPrompt('/context', commands);
  assert.ok(parsed);
  assert.equal(parsed?.command.name, 'context');
  assert.equal(shouldAutoSubmitSlashCommand(parsed!.command), true);

  const compact = parseSelectedSlashCommandPrompt('/compact keep auth', commands);
  assert.ok(compact);
  assert.equal(compact?.command.name, 'compact');
  assert.equal(compact?.remainder.trim(), 'keep auth');
  assert.equal(shouldAutoSubmitSlashCommand(compact!.command), false);
}

function testOtherProvidersUnchanged() {
  const claude = buildProviderSlashCommands('claude');
  assert.ok(claude.some((command) => command.name === 'compact'));
  assert.ok(claude.some((command) => command.name === 'rewind'));

  const opencode = buildProviderSlashCommands('opencode');
  assert.ok(opencode.some((command) => command.name === 'models'));
  assert.ok(!opencode.some((command) => command.name === 'always-approve'));
}

testDefaultGrokCatalog();
testSessionAcpCommandsMergeAndEnrich();
testParseAndAutoSubmit();
testOtherProvidersUnchanged();
console.log('grok-slash-commands.test.ts: ok');
