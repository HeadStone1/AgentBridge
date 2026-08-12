import { createHash, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { createRequire } from 'node:module';
import type {
  Discussion,
  Message,
  Decision,
  AuditEvent,
  DiscussionStatus,
  DispatchState,
  AgentType,
  MessageRole,
  AgentSession,
  SessionStatus,
  DiscussionError,
  DiscussionStopReason,
} from '@agentbridge/protocol';
import { canTransition, resolveProjectPath, SessionBusyError } from '@agentbridge/protocol';

export type { StoragePort } from './port.js';
export {
  ensureProjectMetadata,
  readProjectRegistry,
  registerProject,
  registryPath,
  registryRoot,
  unregisterProject,
} from './registry.js';
export type { RegisteredProject } from './registry.js';

const DEFAULT_MAX_TURNS = 12;
const MAX_ALLOWED_TURNS = 50;
const MAX_TEXT_LENGTH = 100_000;
const SQLITE_STARTUP_TIMEOUT_MS = 5_000;
const SQLITE_RETRY_DELAY_MS = 25;
const SQLITE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

type SqliteStatement = {
  all(...values: any[]): any[];
  get(...values: any[]): any;
  run(...values: any[]): { changes: number };
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  dispatch_state TEXT,
  waiting_for TEXT,
  driver TEXT NOT NULL,
  peer TEXT,
  current_turn INTEGER NOT NULL DEFAULT 0,
  round_count INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL DEFAULT 12,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  conclusion TEXT,
  project_path TEXT,
  trace_id TEXT NOT NULL
  ,stop_reason TEXT
  ,last_error TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parent_message_id TEXT,
  correlation_id TEXT NOT NULL,
  git_commit TEXT,
  git_branch TEXT,
  project_path TEXT,
  provider_session_id TEXT,
  FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  changes TEXT NOT NULL, -- JSON array
  decision_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  agreed_by TEXT NOT NULL, -- JSON array
  FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);

CREATE TABLE IF NOT EXISTS agreements (
  discussion_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (discussion_id, agent),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);

CREATE TABLE IF NOT EXISTS session_leases (
  provider TEXT NOT NULL,
  project_path TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (provider, project_path)
);

CREATE TABLE IF NOT EXISTS discussion_leases (
  discussion_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (discussion_id) REFERENCES discussions(id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_discussion_hash
  ON decisions(discussion_id, decision_hash);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  discussion_id TEXT,
  action TEXT NOT NULL,
  agent TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT NOT NULL -- JSON object
);

CREATE INDEX IF NOT EXISTS idx_messages_discussion_id ON messages(discussion_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_discussion_id ON audit_events(discussion_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status);
CREATE INDEX IF NOT EXISTS idx_discussions_project_path ON discussions(project_path);
`;

export class Storage {
  private db: SqliteDatabase;

  constructor(dbPath = process.env.AGENTBRIDGE_DB_PATH ?? join(resolveProjectPath(), '.agentbridge', 'agentbridge.sqlite')) {
    if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    try {
      // Wait for an existing writer with a write-lock probe before attempting
      // journal_mode. Keep SQLite's own busy handler disabled for this probe:
      // waiting inside BEGIN IMMEDIATE can retain a shared lock and prevent the
      // existing writer from committing on newer SQLite builds.
      this.db.exec('PRAGMA busy_timeout = 0;');
      retrySqliteBusy(() => this.db.exec('BEGIN IMMEDIATE; ROLLBACK;'));
      // Normal operations can use SQLite's native busy handler once startup
      // ownership is established.
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_STARTUP_TIMEOUT_MS};`);
      this.db.exec('PRAGMA foreign_keys = ON;');
      retrySqliteBusy(() => this.db.exec('PRAGMA journal_mode = WAL;'));
      retrySqliteBusy(() => this.db.exec(SCHEMA));
      this.ensureSchemaCompatibility();
    } catch (error) {
      try { this.db.close(); } catch { /* preserve the initialization error */ }
      throw error;
    }
  }

  private ensureSchemaCompatibility(): void {
    this.ensureColumn('discussions', 'peer', 'ALTER TABLE discussions ADD COLUMN peer TEXT');
    this.ensureColumn('discussions', 'dispatch_state', 'ALTER TABLE discussions ADD COLUMN dispatch_state TEXT');
    this.ensureColumn('discussions', 'waiting_for', 'ALTER TABLE discussions ADD COLUMN waiting_for TEXT');
    this.ensureColumn('discussions', 'retry_count', 'ALTER TABLE discussions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('discussions', 'max_retries', 'ALTER TABLE discussions ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 2');
    this.ensureColumn('discussions', 'round_count', 'ALTER TABLE discussions ADD COLUMN round_count INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('discussions', 'stop_reason', 'ALTER TABLE discussions ADD COLUMN stop_reason TEXT');
    this.ensureColumn('discussions', 'last_error', 'ALTER TABLE discussions ADD COLUMN last_error TEXT');
    this.ensureColumn('messages', 'provider_session_id', 'ALTER TABLE messages ADD COLUMN provider_session_id TEXT');
  }

  private ensureColumn(table: string, columnName: string, alterSql: string): void {
    const hasColumn = () => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .some((column) => column.name === columnName);
    if (hasColumn()) return;

    try {
      retrySqliteBusy(() => this.db.exec(alterSql));
    } catch (error) {
      // A second process may have completed the same migration after our
      // initial table_info check. Only suppress the error if the column now exists.
      if (!hasColumn()) throw error;
    }
  }

  close() {
    this.db.close();
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  // --- Discussions ---
  createDiscussion(data: {
    topic: string;
    driver: AgentType;
    projectPath?: string;
    peer?: AgentType;
    traceId: string;
    maxTurns?: number;
    maxRetries?: number;
  }): Discussion {
    const id = `dsc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const maxTurns = data.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxRetries = data.maxRetries ?? 2;
    const peer = data.peer ?? (data.driver === 'claude' ? 'codex' : 'claude');

    assertText(data.topic, 'topic');
    assertText(data.traceId, 'traceId');
    assertTurns(maxTurns);
    assertRetries(maxRetries);

    this.db
      .prepare(
        `INSERT INTO discussions (id, topic, status, driver, peer, current_turn, round_count, max_turns, retry_count, max_retries, created_at, updated_at, project_path, trace_id)
         VALUES (?, ?, 'CREATED', ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.topic, data.driver, peer, maxTurns, maxRetries, now, now, data.projectPath ?? resolveProjectPath(), data.traceId);

    return this.getDiscussion(id)!;
  }

  getDiscussion(id: string): Discussion | null {
    const row = this.db.prepare('SELECT * FROM discussions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToDiscussion(row);
  }

  updateDiscussionStatus(id: string, status: DiscussionStatus, extra?: Partial<Discussion>): void {
    const current = this.getDiscussion(id);
    if (!current) throw new Error(`Discussion ${id} not found`);
    if (current.status !== status && !canTransition(current.status, status)) {
      throw new Error(`Invalid discussion transition: ${current.status} -> ${status}`);
    }

    const now = new Date().toISOString();
    const fields: Record<string, unknown> = { status, updated_at: now };
    if (extra?.currentTurn !== undefined) fields.current_turn = extra.currentTurn;
    if (extra?.conclusion !== undefined) fields.conclusion = extra.conclusion;
    if (extra?.endedAt !== undefined) fields.ended_at = extra.endedAt;

    const setClauses = Object.keys(fields)
      .map((k) => `${k} = ?`)
      .join(', ');
    const values = [...Object.values(fields), id];
    this.db.prepare(`UPDATE discussions SET ${setClauses} WHERE id = ?`).run(...values);
  }

  updateDiscussionDispatch(id: string, state: DispatchState | null, waitingFor: AgentType | null = null): void {
    if (!this.getDiscussion(id)) throw new Error(`Discussion ${id} not found`);
    this.db
      .prepare('UPDATE discussions SET dispatch_state = ?, waiting_for = ?, updated_at = ? WHERE id = ?')
      .run(state, waitingFor, new Date().toISOString(), id);
  }

  updateDiscussionDiagnostic(
    id: string,
    stopReason: DiscussionStopReason | null,
    lastError: DiscussionError | null = null,
  ): void {
    if (!this.getDiscussion(id)) throw new Error(`Discussion ${id} not found`);
    this.db.prepare('UPDATE discussions SET stop_reason = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(stopReason, lastError ? JSON.stringify(lastError) : null, new Date().toISOString(), id);
  }

  incrementDiscussionRound(id: string): Discussion {
    const current = this.getDiscussion(id);
    if (!current) throw new Error(`Discussion ${id} not found`);
    this.db
      .prepare('UPDATE discussions SET round_count = round_count + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return this.getDiscussion(id)!;
  }

  incrementRetry(id: string): Discussion {
    const current = this.getDiscussion(id);
    if (!current) throw new Error(`Discussion ${id} not found`);
    const retryCount = current.retryCount + 1;
    this.db
      .prepare('UPDATE discussions SET retry_count = ?, updated_at = ? WHERE id = ?')
      .run(retryCount, new Date().toISOString(), id);
    const nextStatus: DiscussionStatus = retryCount >= current.maxRetries
      ? 'NEEDS_USER_DECISION'
      : 'FAILED';
    this.updateDiscussionStatus(id, nextStatus);
    return this.getDiscussion(id)!;
  }

  listDiscussions(projectPath?: string): Discussion[] {
    const query = projectPath
      ? 'SELECT * FROM discussions WHERE project_path = ? ORDER BY created_at DESC'
      : 'SELECT * FROM discussions ORDER BY created_at DESC';
    const rows = (projectPath ? this.db.prepare(query).all(projectPath) : this.db.prepare(query).all()) as Record<string, unknown>[];
    return rows.map(rowToDiscussion);
  }

  cleanupDiscussions(olderThanDays: number, execute = false): {
    cutoff: string;
    count: number;
    discussionIds: string[];
    deleted: boolean;
  } {
    if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
      throw new Error('olderThanDays must be an integer between 1 and 3650');
    }
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1_000).toISOString();
    const rows = this.db.prepare(
      `SELECT id FROM discussions
       WHERE status IN ('COMPLETED', 'CANCELLED')
         AND COALESCE(ended_at, updated_at) <= ?
       ORDER BY COALESCE(ended_at, updated_at) ASC`,
    ).all(cutoff) as Array<{ id: string }>;
    const discussionIds = rows.map((row) => row.id);
    if (execute && discussionIds.length > 0) {
      this.transaction(() => {
        const remove = (table: string) => {
          const statement = this.db.prepare(`DELETE FROM ${table} WHERE discussion_id = ?`);
          for (const id of discussionIds) statement.run(id);
        };
        remove('audit_events');
        remove('agreements');
        remove('decisions');
        remove('messages');
        remove('discussion_leases');
        const statement = this.db.prepare('DELETE FROM discussions WHERE id = ?');
        for (const id of discussionIds) statement.run(id);
      });
    }
    return { cutoff, count: discussionIds.length, discussionIds, deleted: execute };
  }

  recoverStaleDiscussions(maxAgeMs = 30 * 60 * 1_000): Discussion[] {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error('maxAgeMs must be an integer between 1000 and 604800000');
    }
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM discussions
         WHERE status IN ('CREATED', 'DISCUSSING', 'PEER_BUSY') AND updated_at <= ?
         ORDER BY updated_at ASC`,
      )
      .all(cutoff) as Record<string, unknown>[];
    if (rows.length === 0) return [];

    const now = new Date().toISOString();
    this.transaction(() => {
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE discussions
             SET status = 'NEEDS_USER_DECISION', dispatch_state = 'FAILED', waiting_for = NULL,
                 ended_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('CREATED', 'DISCUSSING', 'PEER_BUSY')`,
          )
          .run(now, now, row.id);
        this.db.prepare('DELETE FROM session_leases WHERE owner_id = ?').run(row.id);
      }
    });

    return rows
      .map((row) => this.getDiscussion(String(row.id)))
      .filter((discussion): discussion is Discussion => discussion !== null);
  }

  // --- Messages ---
  createMessage(data: {
    discussionId: string;
    sender: AgentType;
    receiver: AgentType;
    role: MessageRole;
    content: string;
    parentMessageId?: string | null;
    correlationId?: string;
    gitCommit?: string;
    gitBranch?: string;
    projectPath?: string;
    providerSessionId?: string;
  }): Message {
    const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const discussion = this.getDiscussion(data.discussionId);
    if (!discussion) throw new Error(`Discussion ${data.discussionId} not found`);
    assertText(data.content, 'message content');
    if (![discussion.driver, discussion.peer].includes(data.sender)) {
      throw new Error(`Agent ${data.sender} is not a participant in discussion ${data.discussionId}`);
    }
    if (![discussion.driver, discussion.peer].includes(data.receiver) || data.sender === data.receiver) {
      throw new Error('Message sender and receiver must be distinct discussion participants');
    }

    const insertMessage = () => {
      this.db
        .prepare(
          `INSERT INTO messages (id, discussion_id, sender, receiver, role, content, created_at, parent_message_id, correlation_id, git_commit, git_branch, project_path, provider_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          data.discussionId,
          data.sender,
          data.receiver,
          data.role,
          data.content,
          now,
          data.parentMessageId ?? null,
          data.correlationId ?? randomUUID(),
          data.gitCommit ?? null,
          data.gitBranch ?? null,
          data.projectPath ?? discussion.projectPath,
          data.providerSessionId ?? null,
        );

      this.db
        .prepare('UPDATE discussions SET current_turn = current_turn + 1, updated_at = ? WHERE id = ?')
        .run(now, data.discussionId);
    };
    this.transaction(insertMessage);

    return this.getMessage(id)!;
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToMessage(row);
  }

  getMessages(discussionId: string, afterId?: string): Message[] {
    let rows: Record<string, unknown>[];
    if (afterId) {
      const cursor = this.db
        .prepare('SELECT rowid FROM messages WHERE discussion_id = ? AND id = ?')
        .get(discussionId, afterId) as { rowid: number } | undefined;
      if (!cursor) return [];
      rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE discussion_id = ? AND rowid > ?
           ORDER BY rowid ASC`,
        )
        .all(discussionId, cursor.rowid) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM messages WHERE discussion_id = ? ORDER BY rowid ASC')
        .all(discussionId) as Record<string, unknown>[];
    }
    return rows.map(rowToMessage);
  }

  // --- Decisions ---
  createDecision(data: {
    discussionId: string;
    summary: string;
    changes: string[];
    agreedBy: AgentType[];
  }): Decision {
    assertText(data.summary, 'decision summary');
    if (data.changes.length > MAX_ALLOWED_TURNS * 10) {
      throw new Error('Too many decision changes');
    }
    const id = `dec_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const hash = hashDecision(data.summary, data.changes);
    const existing = this.db
      .prepare('SELECT * FROM decisions WHERE discussion_id = ? AND decision_hash = ? LIMIT 1')
      .get(data.discussionId, hash) as Record<string, unknown> | undefined;
    if (existing) return rowToDecision(existing);

    this.db
      .prepare(
        `INSERT INTO decisions (id, discussion_id, summary, changes, decision_hash, created_at, agreed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.discussionId, data.summary, JSON.stringify(data.changes), hash, now, JSON.stringify(data.agreedBy));

    return this.getDecision(id)!;
  }

  getDecision(id: string): Decision | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToDecision(row);
  }

  getDecisionByHash(hash: string): Decision | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE decision_hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToDecision(row);
  }

  getDecisionByDiscussion(discussionId: string): Decision | null {
    const row = this.db
      .prepare('SELECT * FROM decisions WHERE discussion_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(discussionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToDecision(row);
  }

  recordAgreement(data: {
    discussionId: string;
    agent: AgentType;
    summary: string;
    changes?: string[];
  }): { decisionHash: string; agreedBy: AgentType[] } {
    assertText(data.summary, 'agreement summary');
    const hash = hashDecision(data.summary, data.changes ?? []);
    const existing = this.db
      .prepare('SELECT decision_hash FROM agreements WHERE discussion_id = ? AND agent = ?')
      .get(data.discussionId, data.agent) as { decision_hash: string } | undefined;
    const otherAgreement = this.db
      .prepare('SELECT decision_hash FROM agreements WHERE discussion_id = ? AND agent <> ? LIMIT 1')
      .get(data.discussionId, data.agent) as { decision_hash: string } | undefined;
    if (otherAgreement && otherAgreement.decision_hash !== hash) {
      throw new Error('Agreement changed; both agents must accept the same decision hash');
    }

    this.db
      .prepare(
        `INSERT INTO agreements (discussion_id, agent, decision_hash, summary, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(discussion_id, agent) DO UPDATE SET decision_hash = excluded.decision_hash, summary = excluded.summary`,
      )
      .run(data.discussionId, data.agent, hash, data.summary, new Date().toISOString());

    const rows = this.db
      .prepare('SELECT agent FROM agreements WHERE discussion_id = ? ORDER BY agent')
      .all(data.discussionId) as { agent: AgentType }[];
    return { decisionHash: hash, agreedBy: rows.map((row) => row.agent) };
  }

  acquireSessionLease(data: {
    provider: AgentType;
    projectPath: string;
    ownerId: string;
    ttlMs?: number;
  }): void {
    if (!data.projectPath || !data.ownerId) throw new Error('Session lease requires projectPath and ownerId');
    const ttlMs = data.ttlMs ?? 120_000;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 600_000) {
      throw new Error('Session lease ttlMs must be between 1000 and 600000');
    }
    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + ttlMs);

    try {
      this.transaction(() => {
        this.db.prepare('DELETE FROM session_leases WHERE expires_at <= ?').run(acquiredAt.toISOString());
        this.db
          .prepare(
            `INSERT INTO session_leases (provider, project_path, owner_id, acquired_at, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(data.provider, data.projectPath, data.ownerId, acquiredAt.toISOString(), expiresAt.toISOString());
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new SessionBusyError(`Session for ${data.provider} is already leased for project ${data.projectPath}`);
      }
      throw error;
    }
  }

  releaseSessionLease(provider: AgentType, projectPath: string, ownerId: string): void {
    this.db
      .prepare('DELETE FROM session_leases WHERE provider = ? AND project_path = ? AND owner_id = ?')
      .run(provider, projectPath, ownerId);
  }

  renewSessionLease(provider: AgentType, projectPath: string, ownerId: string, ttlMs = 120_000): boolean {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 600_000) {
      throw new Error('Session lease ttlMs must be between 1000 and 600000');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const result = this.db
      .prepare(
        `UPDATE session_leases
         SET expires_at = ?
         WHERE provider = ? AND project_path = ? AND owner_id = ? AND expires_at > ?`,
      )
      .run(expiresAt.toISOString(), provider, projectPath, ownerId, now.toISOString());
    return result.changes === 1;
  }

  acquireDiscussionLease(data: {
    discussionId: string;
    projectPath: string;
    ownerId: string;
    ttlMs?: number;
  }): void {
    if (!data.discussionId || !data.projectPath || !data.ownerId) {
      throw new Error('Discussion lease requires discussionId, projectPath, and ownerId');
    }
    const ttlMs = data.ttlMs ?? 120_000;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 600_000) {
      throw new Error('Discussion lease ttlMs must be between 1000 and 600000');
    }
    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + ttlMs);
    try {
      this.transaction(() => {
        this.db.prepare('DELETE FROM discussion_leases WHERE expires_at <= ?').run(acquiredAt.toISOString());
        this.db.prepare(
          `INSERT INTO discussion_leases (discussion_id, project_path, owner_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(data.discussionId, data.projectPath, data.ownerId, acquiredAt.toISOString(), expiresAt.toISOString());
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new SessionBusyError(`Discussion ${data.discussionId} is already being operated on`);
      }
      throw error;
    }
  }

  releaseDiscussionLease(discussionId: string, ownerId: string): void {
    this.db.prepare('DELETE FROM discussion_leases WHERE discussion_id = ? AND owner_id = ?').run(discussionId, ownerId);
  }

  renewDiscussionLease(discussionId: string, ownerId: string, ttlMs = 120_000): boolean {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 600_000) {
      throw new Error('Discussion lease ttlMs must be between 1000 and 600000');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const result = this.db.prepare(
      `UPDATE discussion_leases
       SET expires_at = ?
       WHERE discussion_id = ? AND owner_id = ? AND expires_at > ?`,
    ).run(expiresAt.toISOString(), discussionId, ownerId, now.toISOString());
    return result.changes === 1;
  }

  hasDiscussionLease(discussionId: string, ownerId?: string): boolean {
    const now = new Date().toISOString();
    const row = ownerId
      ? this.db.prepare(
        `SELECT 1 FROM discussion_leases
         WHERE discussion_id = ? AND owner_id = ? AND expires_at > ? LIMIT 1`,
      ).get(discussionId, ownerId, now)
      : this.db.prepare(
        `SELECT 1 FROM discussion_leases
         WHERE discussion_id = ? AND expires_at > ? LIMIT 1`,
      ).get(discussionId, now);
    return Boolean(row);
  }

  hasSessionLease(provider: AgentType, projectPath: string, ownerId?: string): boolean {
    const now = new Date().toISOString();
    const row = ownerId
      ? this.db.prepare(
        `SELECT 1 FROM session_leases
         WHERE provider = ? AND project_path = ? AND owner_id = ? AND expires_at > ?
         LIMIT 1`,
      ).get(provider, projectPath, ownerId, now)
      : this.db.prepare(
        `SELECT 1 FROM session_leases
         WHERE provider = ? AND project_path = ? AND expires_at > ?
         LIMIT 1`,
      ).get(provider, projectPath, now);
    return Boolean(row);
  }

  recoverExpiredSessionLeases(now = new Date()): number {
    const result = this.db
      .prepare('DELETE FROM session_leases WHERE expires_at <= ?')
      .run(now.toISOString());
    return result.changes;
  }

  // --- Provider session registry ---
  registerSession(data: {
    provider: AgentType;
    sessionId: string;
    projectPath: string;
    status?: SessionStatus;
    metadata?: Record<string, unknown>;
  }): AgentSession {
    assertText(data.sessionId, 'sessionId');
    assertText(data.projectPath, 'projectPath');
    const now = new Date().toISOString();
    const status = data.status ?? 'UNKNOWN';
    const metadata = data.metadata ?? {};
    this.db
      .prepare(
        `INSERT INTO agent_sessions (provider, session_id, project_path, status, metadata, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, session_id) DO UPDATE SET
           project_path = excluded.project_path,
           status = excluded.status,
           metadata = excluded.metadata,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(data.provider, data.sessionId, data.projectPath, status, JSON.stringify(metadata), now, now);
    return this.getSession(data.provider, data.sessionId)!;
  }

  getSession(provider: AgentType, sessionId: string): AgentSession | null {
    const row = this.db
      .prepare('SELECT * FROM agent_sessions WHERE provider = ? AND session_id = ?')
      .get(provider, sessionId) as Record<string, unknown> | undefined;
    return row ? rowToAgentSession(row) : null;
  }

  getSessionForDiscussion(
    provider: AgentType,
    discussionId: string,
    projectPath: string,
  ): AgentSession | null {
    const row = this.db
      .prepare(
        `SELECT sessions.* FROM messages
         JOIN agent_sessions AS sessions
           ON sessions.provider = messages.sender
          AND sessions.session_id = messages.provider_session_id
         WHERE messages.discussion_id = ?
           AND messages.sender = ?
           AND sessions.project_path = ?
           AND messages.provider_session_id IS NOT NULL
         ORDER BY messages.rowid DESC
         LIMIT 1`,
      )
      .get(discussionId, provider, projectPath) as Record<string, unknown> | undefined;
    if (row) {
      const session = rowToAgentSession(row);
      if (isReusableBridgeSession(session)) return session;
    }

    // Compatibility fallback for sessions registered by hooks or older
    // versions before provider_session_id was attached to messages.
    const legacyRows = this.db
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE provider = ? AND project_path = ?
         ORDER BY last_seen_at DESC`,
      )
      .all(provider, projectPath) as Record<string, unknown>[];
    for (const legacyRow of legacyRows) {
      const session = rowToAgentSession(legacyRow);
      if (session.metadata.discussionId === discussionId && isReusableBridgeSession(session)) return session;
    }
    return null;
  }

  pruneSessions(maxAgeMs = 30 * 24 * 60 * 60 * 1_000): number {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new Error('maxAgeMs must be an integer between 1000 and 31536000000');
    }
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db.prepare(
      `DELETE FROM agent_sessions
       WHERE last_seen_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_sessions newer
           WHERE newer.provider = agent_sessions.provider
             AND newer.project_path = agent_sessions.project_path
             AND newer.last_seen_at > agent_sessions.last_seen_at
         )`,
    ).run(cutoff);
    return result.changes;
  }

  listSessions(projectPath?: string): AgentSession[] {
    const rows = projectPath
      ? this.db.prepare('SELECT * FROM agent_sessions WHERE project_path = ? ORDER BY last_seen_at DESC').all(projectPath)
      : this.db.prepare('SELECT * FROM agent_sessions ORDER BY last_seen_at DESC').all();
    return (rows as Record<string, unknown>[]).map(rowToAgentSession);
  }

  listSessionsForDiscussion(discussionId: string): AgentSession[] {
    return this.listSessions().filter((session) => session.metadata.discussionId === discussionId);
  }

  updateSessionStatus(
    provider: AgentType,
    sessionId: string,
    status: SessionStatus,
    metadata?: Record<string, unknown>,
  ): AgentSession {
    const current = this.getSession(provider, sessionId);
    if (!current) throw new Error(`Session ${provider}/${sessionId} not found`);
    this.db
      .prepare('UPDATE agent_sessions SET status = ?, metadata = ?, last_seen_at = ? WHERE provider = ? AND session_id = ?')
      .run(status, JSON.stringify(metadata ?? current.metadata), new Date().toISOString(), provider, sessionId);
    return this.getSession(provider, sessionId)!;
  }

  unregisterSession(provider: AgentType, sessionId: string): void {
    this.db.prepare('DELETE FROM agent_sessions WHERE provider = ? AND session_id = ?').run(provider, sessionId);
  }

  // --- Audit (append-only) ---
  appendAudit(event: Omit<AuditEvent, 'id' | 'timestamp'>): AuditEvent {
    const id = `aud_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO audit_events (id, trace_id, discussion_id, action, agent, timestamp, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, event.traceId, event.discussionId ?? null, event.action, event.agent, now, JSON.stringify(event.metadata));

    return { id, ...event, timestamp: now };
  }

  getAuditLog(discussionId?: string, limit = 100): AuditEvent[] {
    const query = discussionId
      ? 'SELECT * FROM audit_events WHERE discussion_id = ? ORDER BY timestamp DESC LIMIT ?'
      : 'SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?';
    const rows = (discussionId
      ? this.db.prepare(query).all(discussionId, limit)
      : this.db.prepare(query).all(limit)) as Record<string, unknown>[];
    return rows.map(rowToAuditEvent);
  }
}

// --- Row mappers ---
function rowToDiscussion(row: Record<string, unknown>): Discussion {
  const driver = row.driver as AgentType;
  return {
    id: row.id as string,
    topic: row.topic as string,
    status: row.status as DiscussionStatus,
    driver,
    peer: (row.peer as AgentType | null) ?? (driver === 'claude' ? 'codex' : 'claude'),
    currentTurn: row.current_turn as number,
    roundCount: Number(row.round_count ?? 0),
    maxTurns: row.max_turns as number,
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 2),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    conclusion: (row.conclusion as string | null) ?? null,
    projectPath: (row.project_path as string | undefined) ?? resolveProjectPath(),
    traceId: row.trace_id as string,
    dispatchState: (row.dispatch_state as DispatchState | null) ?? null,
    waitingFor: (row.waiting_for as AgentType | null) ?? null,
    stopReason: (row.stop_reason as DiscussionStopReason | null) ?? null,
    lastError: parseJsonObject(row.last_error) as unknown as DiscussionError | null,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    discussionId: row.discussion_id as string,
    sender: row.sender as AgentType,
    receiver: row.receiver as AgentType,
    role: row.role as MessageRole,
    content: row.content as string,
    createdAt: row.created_at as string,
    parentMessageId: (row.parent_message_id as string | null) ?? null,
    correlationId: row.correlation_id as string,
    gitCommit: (row.git_commit as string | undefined) ?? undefined,
    gitBranch: (row.git_branch as string | undefined) ?? undefined,
    projectPath: (row.project_path as string | undefined) ?? undefined,
    providerSessionId: (row.provider_session_id as string | undefined) ?? undefined,
  };
}

function rowToDecision(row: Record<string, unknown>): Decision {
  return {
    id: row.id as string,
    discussionId: row.discussion_id as string,
    summary: row.summary as string,
    changes: JSON.parse(row.changes as string),
    decisionHash: row.decision_hash as string,
    createdAt: row.created_at as string,
    agreedBy: JSON.parse(row.agreed_by as string),
  };
}

function rowToAgentSession(row: Record<string, unknown>): AgentSession {
  return {
    provider: row.provider as AgentType,
    sessionId: row.session_id as string,
    projectPath: row.project_path as string,
    status: row.status as SessionStatus,
    metadata: JSON.parse(row.metadata as string),
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string,
  };
}

function isReusableBridgeSession(session: AgentSession): boolean {
  return (session.status === 'IDLE' || session.status === 'BRIDGE_OWNED')
    && session.metadata.bridgeOwned === true
    && typeof session.metadata.supersededBy !== 'string';
}

function rowToAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: row.id as string,
    traceId: row.trace_id as string,
    discussionId: (row.discussion_id as string | null) ?? null,
    action: row.action as string,
    agent: row.agent as AgentType | 'system',
    timestamp: row.timestamp as string,
    metadata: JSON.parse(row.metadata as string),
  };
}

function hashDecision(summary: string, changes: string[]): string {
  // Simple deterministic hash for decision deduplication
  const canonical = JSON.stringify({ summary, changes: [...changes].sort() });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function assertText(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label} exceeds the ${MAX_TEXT_LENGTH}-character limit`);
  }
}

function assertTurns(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ALLOWED_TURNS) {
    throw new Error(`maxTurns must be an integer between 1 and ${MAX_ALLOWED_TURNS}`);
  }
}

function assertRetries(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error('maxRetries must be an integer between 0 and 10');
  }
}

function retrySqliteBusy(action: () => void, timeoutMs = SQLITE_STARTUP_TIMEOUT_MS): void {
  const deadline = Date.now() + timeoutMs;
  let delayMs = SQLITE_RETRY_DELAY_MS;
  while (true) {
    try {
      action();
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(SQLITE_RETRY_BUFFER, 0, 0, Math.min(delayMs, deadline - Date.now()));
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const sqliteError = error as { errcode?: unknown; message?: unknown };
  if (sqliteError.errcode === 5) return true;
  const message = typeof sqliteError.message === 'string' ? sqliteError.message.toLowerCase() : '';
  return message.includes('database is locked') || message.includes('database is busy');
}
