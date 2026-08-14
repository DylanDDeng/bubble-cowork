import { resolve } from 'node:path';

export const RESUME_NOT_FOUND_CODE = 'AEGIS_DSH_RESUME_NOT_FOUND';
export const RESUME_CWD_MISMATCH_CODE = 'AEGIS_DSH_RESUME_CWD_MISMATCH';

const PATCH_MARKER = Symbol.for('aegis.deepseek-sdk-jsonrpc-server.resume-shim');

function resumeError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

function agentOptions(server) {
  return {
    provider: server.provider,
    model: server.model,
    ...(server.maxTokens === undefined ? {} : { maxTokens: server.maxTokens }),
  };
}

/**
 * Open one SDK session with the same create-or-resume policy as the Harness
 * Web host. The rc.6 JSON-RPC server only checks its process-local map and
 * always calls agents.create() after a restart; this shim checks the durable
 * store first and uses agents.resume() when the requested identity exists.
 */
export async function openSessionWithNativeResume({
  server,
  sessionId,
  SessionId,
  createFresh,
  expectedResumeSessionId = process.env.AEGIS_DSH_RESUME_SESSION_ID,
}) {
  const id = SessionId(sessionId);
  const persistence = server.ctx.get('sessionPersistence');
  const stored = persistence === undefined
    ? undefined
    : (await persistence.list()).find((header) => header.id === id);

  if (stored === undefined) {
    if (expectedResumeSessionId === sessionId) {
      throw resumeError(
        RESUME_NOT_FOUND_CODE,
        `persisted session "${sessionId}" was not found; start a fresh session instead`,
      );
    }
    return createFresh.call(server, sessionId);
  }

  const storedCwd = stored.cwd === undefined ? undefined : resolve(stored.cwd);
  if (storedCwd !== server.cwd) {
    throw resumeError(
      RESUME_CWD_MISMATCH_CODE,
      `session "${sessionId}" belongs to "${stored.cwd ?? '<no cwd>'}", not "${server.cwd}"`,
    );
  }

  const handle = await server.ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: agentOptions(server),
  });
  const record = { handle };
  server.sessions.set(sessionId, record);
  return record;
}

/** Patch the exported rc.6 server class before Cordis boots its plugin. */
export function installDeepseekSdkResumeShim({ HarnessSdkJsonRpcServer, SessionId }) {
  const prototype = HarnessSdkJsonRpcServer.prototype;
  if (prototype[PATCH_MARKER]) return;

  const createFresh = prototype.createSession;
  Object.defineProperty(prototype, PATCH_MARKER, { value: true });
  prototype.createSession = function createOrResumeSession(sessionId) {
    return openSessionWithNativeResume({
      server: this,
      sessionId,
      SessionId,
      createFresh,
    });
  };
}
