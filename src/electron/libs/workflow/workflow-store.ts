// Persistence for app-level workflows in the app's SQLite database (plan §7.1).
// State tables are the source of truth; workflow_events is an audit log only.

import type Database from 'better-sqlite3';
import { getDatabase } from '../session-store';
import type { InstanceRecord, InstanceStore } from '../../../workflow-engine/engine/engine';
import type { WorkflowSpec } from '../../../workflow-engine/spec/workflow-spec';
import type { ValidationReport } from '../../../workflow-engine/validate/spec-validator';
import { CURRENT_SESSION_AGENT, type WorkflowLocation, type WorkflowNeedsInput, type WorkflowParent, type WorkflowRunStatus } from '../../../shared/workflow';

let initialized = false;

function db(): Database.Database {
  const database = getDatabase();
  if (!initialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        client_request_id TEXT UNIQUE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        cwd TEXT NOT NULL,
        project_cwd TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT 'current',
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        spec_json TEXT,
        planned_raw TEXT,
        report_json TEXT,
        planner_agent TEXT,
        planner_session_id TEXT,
        baseline_version TEXT,
        final_version TEXT,
        needs_input_json TEXT,
        error TEXT,
        options_json TEXT NOT NULL DEFAULT '{}',
        acceptance_json TEXT,
        app_generation TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_members (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        role TEXT NOT NULL,
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        focus TEXT,
        source TEXT NOT NULL,
        permission_mode TEXT,
        permission_default INTEGER NOT NULL DEFAULT 0,
        read_only_mechanism TEXT,
        degraded_json TEXT NOT NULL DEFAULT '[]',
        unverified INTEGER NOT NULL DEFAULT 0,
        current_session_id TEXT,
        PRIMARY KEY (run_id, key)
      );
      CREATE TABLE IF NOT EXISTS workflow_instances (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        step_id TEXT NOT NULL,
        state TEXT NOT NULL,
        seq INTEGER,
        session_id TEXT,
        record_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, key)
      );
      CREATE TABLE IF NOT EXISTS workflow_resources (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        pid INTEGER,
        started_at INTEGER,
        app_generation TEXT,
        state TEXT NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_instances_session ON workflow_instances(session_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_members_session ON workflow_members(current_session_id);
    `);
    initialized = true;
  }
  return database;
}

export type RunOptions = {
  permissionModes: Record<string, string>;
  extraIterations: Record<string, number>;
  rerunInstances: string[];
  waivers: string[];
  approvedChecks: string[][];
  /** Versions the user chose to adopt in place of the expected one after a gate found drift. */
  adoptions: Record<string, string>;
  /** Extra agent-step budget granted after a budget stop. */
  extraAgentSteps: number;
  availableAgents: string[];
  isolated?: { repoRoot: string; worktreePath: string; branch: string; baseRef: string } | null;
  /** The user adopted their own edits into the workflow at a gate. */
  includesUserChanges?: boolean;
  /** Steps skipped by their condition, for the UI. */
  skipped?: string[];
  /** Manual acceptance items the user checked and confirmed. */
  manualVerified?: string[];
  /** The final version passed G4 (as opposed to a run the user finished early). */
  verifiedFinal?: boolean;
  planOnly?: boolean;
  /** The chat session that started the run (plan §8: in-chat entry). */
  parent?: WorkflowParent | null;
  /** Tree reviewers diff against when the change predates the run (HEAD for "review my changes"). */
  diffBase?: string | null;
  /** The parent session has been told how the run ended. */
  reported?: boolean;
};

export type RunRow = {
  id: string;
  clientRequestId: string | null;
  title: string;
  goal: string;
  cwd: string;
  projectCwd: string;
  location: WorkflowLocation;
  status: WorkflowRunStatus;
  revision: number;
  spec: WorkflowSpec | null;
  plannedRaw: string | null;
  report: ValidationReport | null;
  plannerAgent: string | null;
  plannerSessionId: string | null;
  baselineVersion: string | null;
  finalVersion: string | null;
  needsInput: WorkflowNeedsInput | null;
  error: string | null;
  options: RunOptions;
  acceptance: Array<{ id: string; status: string }> | null;
  appGeneration: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MemberRow = {
  runId: string;
  key: string;
  role: 'implementer' | 'reviewer' | 'advisor';
  agent: string;
  provider: string;
  model: string | null;
  focus: string | null;
  source: 'user' | 'template' | 'inferred';
  permissionMode: string | null;
  permissionDefault: boolean;
  readOnlyMechanism: string | null;
  degraded: string[];
  unverified: boolean;
  currentSessionId: string | null;
};

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const DEFAULT_OPTIONS: RunOptions = {
  permissionModes: {},
  extraIterations: {},
  rerunInstances: [],
  waivers: [],
  approvedChecks: [],
  adoptions: {},
  extraAgentSteps: 0,
  availableAgents: [],
};

function toRun(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    clientRequestId: (row.client_request_id as string) ?? null,
    title: row.title as string,
    goal: row.goal as string,
    cwd: row.cwd as string,
    projectCwd: row.project_cwd as string,
    location: row.location as WorkflowLocation,
    status: row.status as WorkflowRunStatus,
    revision: row.revision as number,
    spec: parse<WorkflowSpec | null>(row.spec_json as string, null),
    plannedRaw: (row.planned_raw as string) ?? null,
    report: parse<ValidationReport | null>(row.report_json as string, null),
    plannerAgent: (row.planner_agent as string) ?? null,
    plannerSessionId: (row.planner_session_id as string) ?? null,
    baselineVersion: (row.baseline_version as string) ?? null,
    finalVersion: (row.final_version as string) ?? null,
    needsInput: parse<WorkflowNeedsInput | null>(row.needs_input_json as string, null),
    error: (row.error as string) ?? null,
    options: { ...DEFAULT_OPTIONS, ...parse<Partial<RunOptions>>(row.options_json as string, {}) },
    acceptance: parse(row.acceptance_json as string, null),
    appGeneration: (row.app_generation as string) ?? null,
    archived: row.archived === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function findRunByRequestId(clientRequestId: string): RunRow | null {
  const row = db().prepare('SELECT * FROM workflow_runs WHERE client_request_id = ?').get(clientRequestId);
  return row ? toRun(row as Record<string, unknown>) : null;
}

export function createRun(input: {
  id: string;
  clientRequestId: string;
  title: string;
  goal: string;
  cwd: string;
  projectCwd: string;
  location: WorkflowLocation;
  status: WorkflowRunStatus;
  options: RunOptions;
  plannerAgent: string | null;
  appGeneration: string;
}): RunRow {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO workflow_runs (id, client_request_id, title, goal, cwd, project_cwd, location, status, revision,
        options_json, planner_agent, app_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.clientRequestId,
      input.title,
      input.goal,
      input.cwd,
      input.projectCwd,
      input.location,
      input.status,
      JSON.stringify(input.options),
      input.plannerAgent,
      input.appGeneration,
      now,
      now,
    );
  return getRun(input.id)!;
}

export function getRun(id: string): RunRow | null {
  const row = db().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
  return row ? toRun(row as Record<string, unknown>) : null;
}

export function listRuns(includeArchived = false): RunRow[] {
  const rows = db()
    .prepare(`SELECT * FROM workflow_runs ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC LIMIT 200`)
    .all();
  return rows.map((row) => toRun(row as Record<string, unknown>));
}

export function listUnfinishedRuns(): RunRow[] {
  const rows = db()
    .prepare(
      `SELECT * FROM workflow_runs WHERE status IN ('planning', 'running', 'pausing', 'cancelling') AND archived = 0`,
    )
    .all();
  return rows.map((row) => toRun(row as Record<string, unknown>));
}

type RunPatch = Partial<{
  title: string;
  cwd: string;
  location: WorkflowLocation;
  status: WorkflowRunStatus;
  spec: WorkflowSpec | null;
  plannedRaw: string | null;
  report: ValidationReport | null;
  plannerSessionId: string | null;
  baselineVersion: string | null;
  finalVersion: string | null;
  needsInput: WorkflowNeedsInput | null;
  error: string | null;
  options: RunOptions;
  acceptance: Array<{ id: string; status: string }> | null;
  appGeneration: string;
  archived: boolean;
}>;

const COLUMN: Record<keyof RunPatch, [string, (v: never) => unknown]> = {
  title: ['title', (v) => v],
  cwd: ['cwd', (v) => v],
  location: ['location', (v) => v],
  status: ['status', (v) => v],
  spec: ['spec_json', (v) => (v === null ? null : JSON.stringify(v))],
  plannedRaw: ['planned_raw', (v) => v],
  report: ['report_json', (v) => (v === null ? null : JSON.stringify(v))],
  plannerSessionId: ['planner_session_id', (v) => v],
  baselineVersion: ['baseline_version', (v) => v],
  finalVersion: ['final_version', (v) => v],
  needsInput: ['needs_input_json', (v) => (v === null ? null : JSON.stringify(v))],
  error: ['error', (v) => v],
  options: ['options_json', (v) => JSON.stringify(v)],
  acceptance: ['acceptance_json', (v) => (v === null ? null : JSON.stringify(v))],
  appGeneration: ['app_generation', (v) => v],
  archived: ['archived', (v) => ((v as boolean) ? 1 : 0)],
};

/** Every update bumps the revision used for optimistic control-command checks. */
export function updateRun(id: string, patch: RunPatch): RunRow {
  const sets: string[] = ['revision = revision + 1', 'updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [key, value] of Object.entries(patch) as Array<[keyof RunPatch, never]>) {
    if (value === undefined) continue;
    const [column, encode] = COLUMN[key];
    sets.push(`${column} = ?`);
    values.push(encode(value));
  }
  db().prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return getRun(id)!;
}

export function replaceMembers(runId: string, members: Omit<MemberRow, 'runId'>[]): void {
  const database = db();
  const insert = database.prepare(
    `INSERT INTO workflow_members (run_id, key, role, agent, provider, model, focus, source, permission_mode,
      permission_default, read_only_mechanism, degraded_json, unverified, current_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.transaction(() => {
    database.prepare('DELETE FROM workflow_members WHERE run_id = ?').run(runId);
    for (const m of members) {
      insert.run(
        runId,
        m.key,
        m.role,
        m.agent,
        m.provider,
        m.model,
        m.focus,
        m.source,
        m.permissionMode,
        m.permissionDefault ? 1 : 0,
        m.readOnlyMechanism,
        JSON.stringify(m.degraded),
        m.unverified ? 1 : 0,
        m.currentSessionId,
      );
    }
  })();
}

export function listMembers(runId: string): MemberRow[] {
  const rows = db().prepare('SELECT * FROM workflow_members WHERE run_id = ? ORDER BY rowid').all(runId) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    runId,
    key: row.key as string,
    role: row.role as MemberRow['role'],
    agent: row.agent as string,
    provider: row.provider as string,
    model: (row.model as string) ?? null,
    focus: (row.focus as string) ?? null,
    source: row.source as MemberRow['source'],
    permissionMode: (row.permission_mode as string) ?? null,
    permissionDefault: row.permission_default === 1,
    readOnlyMechanism: (row.read_only_mechanism as string) ?? null,
    degraded: parse<string[]>(row.degraded_json as string, []),
    unverified: row.unverified === 1,
    currentSessionId: (row.current_session_id as string) ?? null,
  }));
}

export function setMemberSession(runId: string, key: string, sessionId: string): void {
  db().prepare('UPDATE workflow_members SET current_session_id = ? WHERE run_id = ? AND key = ?').run(sessionId, runId, key);
}

/** Session ids that belong to any workflow (members and planners), for list filtering and policy lookups. */
export function findMemberBySession(sessionId: string): { runId: string; key: string; role: string } | null {
  const row = db()
    .prepare('SELECT run_id, key, role FROM workflow_members WHERE current_session_id = ? AND agent != ?')
    .get(sessionId, CURRENT_SESSION_AGENT) as { run_id: string; key: string; role: string } | undefined;
  return row ? { runId: row.run_id, key: row.key, role: row.role } : null;
}

/** Instance records for one run, cached in memory and written through to SQLite. */
export class SqliteInstanceStore implements InstanceStore {
  private readonly cache = new Map<string, InstanceRecord & { sessionId?: string }>();

  constructor(private readonly runId: string) {
    const rows = db()
      .prepare('SELECT record_json FROM workflow_instances WHERE run_id = ?')
      .all(runId) as Array<{ record_json: string }>;
    for (const row of rows) {
      const record = parse<InstanceRecord | null>(row.record_json, null);
      if (record) this.cache.set(record.key, record);
    }
  }

  get(key: string) {
    return this.cache.get(key);
  }

  all() {
    return [...this.cache.values()];
  }

  async put(record: InstanceRecord & { sessionId?: string }) {
    const previous = this.cache.get(record.key);
    const merged = { ...record, sessionId: record.sessionId ?? previous?.sessionId };
    this.cache.set(record.key, merged);
    db()
      .prepare(
        `INSERT INTO workflow_instances (run_id, key, step_id, state, seq, session_id, record_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, key) DO UPDATE SET step_id = excluded.step_id, state = excluded.state, seq = excluded.seq,
           session_id = excluded.session_id, record_json = excluded.record_json, updated_at = excluded.updated_at`,
      )
      .run(this.runId, record.key, record.stepId, record.state, record.seq ?? null, merged.sessionId ?? null, JSON.stringify(merged), Date.now());
  }

  /** Associates the member session that is executing an instance (for UI and recovery). */
  async attachSession(key: string, sessionId: string) {
    const record = this.cache.get(key);
    if (record) await this.put({ ...record, sessionId });
  }

  sessionOf(key: string): string | undefined {
    return this.cache.get(key)?.sessionId;
  }
}

export function recordResource(input: {
  id: string;
  runId: string;
  instanceKey: string;
  kind: 'check-process' | 'agent-session';
  pid: number | null;
  startedAt: number | null;
  appGeneration: string;
  state: 'running' | 'exited' | 'unknown';
  detail?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO workflow_resources (id, run_id, instance_key, kind, pid, started_at, app_generation, state, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.runId,
      input.instanceKey,
      input.kind,
      input.pid,
      input.startedAt,
      input.appGeneration,
      input.state,
      input.detail ?? null,
      Date.now(),
    );
}

export function listLiveResources(runId: string): Array<{
  id: string;
  instanceKey: string;
  kind: string;
  pid: number | null;
  startedAt: number | null;
  appGeneration: string | null;
  detail: string | null;
}> {
  const rows = db()
    .prepare(`SELECT * FROM workflow_resources WHERE run_id = ? AND state = 'running'`)
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    instanceKey: r.instance_key as string,
    kind: r.kind as string,
    pid: (r.pid as number) ?? null,
    startedAt: (r.started_at as number) ?? null,
    appGeneration: (r.app_generation as string) ?? null,
    detail: (r.detail as string) ?? null,
  }));
}

export function appendEvent(runId: string, event: unknown): void {
  const database = db();
  const next = database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workflow_events WHERE run_id = ?').get(runId) as {
    seq: number;
  };
  database
    .prepare('INSERT INTO workflow_events (run_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, next.seq, JSON.stringify(event), Date.now());
}
