import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyComputerUseAction,
  environmentHasComputerUseSection,
  formatComputerUseGrantLabel,
  formatComputerUseLabel,
  isDeniedComputerUseTarget,
  parseMcpToolName,
} from '../../src/shared/computer-use';
import {
  buildComputerUseMcpOverrideArgs,
  ComputerUseLease,
  persistComputerUseMedia,
  resolveComputerUseArtifact,
} from '../../src/electron/libs/codex-computer-use';
import { ComputerUseGrantRegistry } from '../../src/electron/libs/codex-computer-use-grants';
import {
  buildMcpElicitationResponse,
  parseMcpToolApprovalElicitation,
  wrappedComputerUseElicitationFixture,
} from '../../src/electron/libs/codex-computer-use-elicitation';
import { classifyToolUse } from '../../src/ui/utils/tool-summary';
import { summarizeWorkstreamEntries } from '../../src/ui/utils/workstream-stages';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';

function testClassification() {
  assert.deepEqual(parseMcpToolName('mcp__aegis-computer-use__click'), {
    server: 'aegis-computer-use',
    tool: 'click',
  });

  const click = classifyComputerUseAction({
    toolName: 'mcp__aegis-computer-use__click',
    app: 'Finder',
    title: 'Open the project',
  });
  assert.equal(click?.kind, 'click');
  assert.equal(click?.mutating, true);
  assert.equal(formatComputerUseLabel(click!, 'pending'), 'Open the project');
  assert.equal(
    formatComputerUseLabel({ ...click!, title: null }, 'pending'),
    'Clicking in Finder'
  );

  const script = classifyComputerUseAction({
    toolName: 'mcp__node_repl__js',
    title: 'Inspect apps',
  });
  assert.equal(script?.kind, 'script');
  assert.equal(script?.mutating, true);

  assert.equal(classifyToolUse('mcp__aegis-computer-use__get_app_state', { app: 'Finder' }), 'computer_use');
  assert.equal(classifyToolUse('mcp__pencil__get_screenshot', {}), 'mcp_tool_call');
  assert.equal(isDeniedComputerUseTarget('com.aegis.desktop'), true);
  assert.equal(isDeniedComputerUseTarget('Finder'), false);
}

function testElicitationParser() {
  const parsed = parseMcpToolApprovalElicitation('elicitation/create', {
    message: 'Allow Computer Use to click?',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      tool_name: 'click',
      tool_title: 'Open the project',
      tool_params: { app: 'Finder', element_index: 4 },
      persist: 'session',
    },
    server: 'aegis-computer-use',
  });
  assert.ok(parsed);
  assert.equal(parsed?.toolName, 'click');
  assert.equal(parsed?.action?.kind, 'click');
  assert.equal(parsed?.persistOptions.includes('session'), true);
  assert.equal(parsed?.deniedTarget, false);

  const denied = parseMcpToolApprovalElicitation('mcpServer/elicitation/request', {
    message: 'Allow Computer Use to click?',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      tool_name: 'click',
      tool_params: { app: 'com.aegis.desktop' },
    },
    server: 'aegis-computer-use',
  });
  assert.equal(denied?.deniedTarget, true);

  const unknown = parseMcpToolApprovalElicitation('elicitation/create', {
    message: 'hello',
  });
  assert.equal(unknown, null);

  const wrapped = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-thread',
      tool: 'click',
      app: 'com.apple.finder',
      persist: 'session',
    })
  );
  assert.ok(wrapped);
  assert.equal(wrapped?.toolName, 'click');
  assert.equal(wrapped?.canonicalApp, 'com.apple.finder');
  assert.equal(wrapped?.providerThreadId, 'p-thread');
  assert.equal(wrapped?.turnId, 'turn-cu-1');
  assert.equal(wrapped?.requestType, 'form');
  assert.equal(wrapped?.grantEligible, true);
  assert.equal(wrapped?.persistOptions.includes('session'), true);

  const nodeRepl = parseMcpToolApprovalElicitation('mcpServer/elicitation/request', {
    threadId: 'p-thread',
    serverName: 'node_repl',
    request: {
      type: 'form',
      message: 'Allow node_repl?',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'js',
        tool_params: { code: 'sky.click()' },
      },
    },
  });
  assert.equal(nodeRepl?.isNodeRepl, true);
  assert.equal(nodeRepl?.grantEligible, false);

  const accept = buildMcpElicitationResponse({ allow: true, persist: 'session' });
  assert.equal(accept.action, 'accept');
  assert.deepEqual(accept._meta, { persist: 'session' });
  const decline = buildMcpElicitationResponse({ allow: false });
  assert.equal(decline.action, 'decline');
  assert.equal(decline.content, null);
  assert.equal('_meta' in decline, false);
}

function testOverridesAndLease() {
  const readOnly = buildComputerUseMcpOverrideArgs({
    clientPath: '/tmp/SkyComputerUseClient',
    policy: 'read-only',
    hasNodeRepl: true,
  });
  const joined = readOnly.join(' ');
  assert.equal(joined.includes('mcp_servers.computer-use.enabled=false'), true);
  assert.equal(joined.includes('mcp_servers.aegis-computer-use.default_tools_approval_mode="writes"'), true);
  assert.equal(joined.includes('"list_apps"'), true);
  assert.equal(joined.includes('"click"'), false);
  assert.equal(joined.includes('mcp_servers.node_repl.disabled_tools=["js", "js_add_node_module_dir"]'), true);

  const mutating = buildComputerUseMcpOverrideArgs({
    clientPath: '/tmp/SkyComputerUseClient',
    policy: 'mutating',
    hasNodeRepl: true,
  }).join(' ');
  assert.equal(mutating.includes('"click"'), true);
  assert.equal(mutating.includes('disabled_tools=["js_add_node_module_dir"]'), true);

  const lease = new ComputerUseLease();
  assert.equal(lease.tryAcquire('thread-a', 'call-1'), true);
  assert.equal(lease.tryAcquire('thread-b', 'call-2'), false);
  assert.equal(lease.tryAcquire('thread-a', 'call-3'), true);
  lease.release('thread-a', 'call-3');
  assert.equal(lease.tryAcquire('thread-b', 'call-4'), true);
  lease.releaseThread('thread-b');
  assert.equal(lease.tryAcquire('thread-a', 'call-5'), true);
}

function testMediaSidecar() {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-cu-media-'));
  try {
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBIVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAADBAECBQYAB//EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAhEAACAgICAwEBAAAAAAAAAAABAgADEQQSITEFQ Rig/9oACAEBAAE/AN7n/9k=',
      'base64'
    );
    const payload = [
      { type: 'text', text: 'Finder windows' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
    ];
    const persisted = persistComputerUseMedia({
      userDataDir: dir,
      sessionId: 'session-1',
      payload,
    });
    assert.equal(persisted.text, 'Finder windows');
    assert.equal(persisted.mediaRefs.length, 1);
    assert.equal(persisted.mediaRefs[0].sessionId, 'session-1');
    assert.equal(persisted.text.includes('data:image'), false);
    const resolved = resolveComputerUseArtifact(dir, 'session-1', persisted.mediaRefs[0].sha256);
    assert.ok(resolved);
    const saved = readFileSync(resolved!.path);
    assert.equal(resolveComputerUseArtifact(dir, '../escape', persisted.mediaRefs[0].sha256), null);
    assert.equal(resolveComputerUseArtifact(dir, 'session-1', 'not-a-hash'), null);
    assert.ok(saved.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testWorkstreamStage() {
  const entries: WorkstreamEntry[] = [
    {
      id: 'cu-1',
      type: 'tool',
      toolName: 'mcp__aegis-computer-use__click',
      kind: 'computer_use',
      summary: 'Clicking in Finder',
      status: 'success',
      block: {
        type: 'tool_use',
        id: 'cu-1',
        name: 'mcp__aegis-computer-use__click',
        input: { app: 'Finder' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'cu-1',
        content: 'ok',
      },
    },
  ];
  const stages = summarizeWorkstreamEntries(entries);
  assert.equal(stages[0]?.kind, 'computer_use');
  assert.equal(stages[0]?.defaultExpanded, true);
  assert.equal(stages[0]?.title, 'Clicking in Finder');
}

function testGrants() {
  const registry = new ComputerUseGrantRegistry();
  const clickFinder = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-root',
      tool: 'click',
      app: 'com.apple.finder',
    })
  );
  assert.ok(clickFinder?.grantEligible);
  const grant = registry.createFromElicitation({
    threadId: 't1',
    generation: 1,
    elicitation: clickFinder!,
  });
  assert.ok(grant);
  assert.equal(formatComputerUseGrantLabel('click', 'com.apple.finder'), 'Allow click in com.apple.finder until revoked');
  assert.ok(
    registry.match({ threadId: 't1', generation: 1, elicitation: clickFinder! }),
    'same app+tool should match'
  );

  const clickChrome = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-root',
      tool: 'click',
      app: 'com.google.Chrome',
    })
  );
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: clickChrome! }), null);

  const typeFinder = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-root',
      tool: 'type_text',
      app: 'com.apple.finder',
    })
  );
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: typeFinder! }), null);

  const descendant = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-child',
      tool: 'click',
      app: 'com.apple.finder',
    })
  );
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: descendant! }), null);
  assert.equal(registry.match({ threadId: 't1', generation: 2, elicitation: clickFinder! }), null);

  registry.revokeThread('t1');
  assert.equal(registry.match({ threadId: 't1', generation: 1, elicitation: clickFinder! }), null);
}

function testEnvironmentFilmstripVisibility() {
  assert.equal(environmentHasComputerUseSection({ frames: [], grants: [] }), false);
  assert.equal(environmentHasComputerUseSection({ frames: [{ media: null }], grants: [] }), false);
  assert.equal(
    environmentHasComputerUseSection({
      frames: [
        {
          media: { sessionId: 's1', sha256: 'abc', mimeType: 'image/png', sizeBytes: 12 },
        },
      ],
      grants: [],
    }),
    true
  );
  assert.equal(
    environmentHasComputerUseSection({
      frames: [],
      grants: [{ key: 'g1' }],
    }),
    true
  );
}

testClassification();
testElicitationParser();
testOverridesAndLease();
testMediaSidecar();
testWorkstreamStage();
testGrants();
testEnvironmentFilmstripVisibility();
console.log('codex computer-use unit tests passed');
