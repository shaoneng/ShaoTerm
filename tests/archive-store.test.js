const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createArchiveStore } = require('../main/archive-store');

function writeRecord(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function createTempArchiveContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shaoterm-archive-test-'));
  const dayStamp = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(root, dayStamp);
  fs.mkdirSync(dayDir, { recursive: true });

  return {
    root,
    dayStamp,
    dayDir,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('legacy query mode scans full files when index is stale', () => {
  const ctx = createTempArchiveContext();
  try {
    const fileA = path.join(ctx.dayDir, 'a.jsonl');
    const fileB = path.join(ctx.dayDir, 'b.jsonl');
    const baseRecord = {
      ts: new Date().toISOString(),
      sessionId: 'session-1',
      tabId: 'tab-1',
      cwd: '/tmp',
      eventType: 'heartbeat',
      status: '进行中'
    };
    const recordA = { ...baseRecord, summary: 'alpha', analysis: 'alpha analysis' };
    const recordB = { ...baseRecord, summary: 'needle-only-in-b', analysis: 'beta analysis' };

    writeRecord(fileA, recordA);

    const store = createArchiveStore({
      getArchiveRootDir: () => ctx.root,
      resolveSessionIdByTab: () => '',
      maxQueryDays: 90,
      maxQueryLimit: 200,
      defaultQueryDays: 14,
      defaultQueryLimit: 40
    });

    // Simulate stale index: only file A is indexed.
    store.append(recordA, { filePath: fileA });
    store.query({ days: 1, tabId: 'tab-1' });

    // Add a new file after the day has been marked as loaded in index.
    writeRecord(fileB, recordB);

    const autoResult = store.query({
      days: 1,
      tabId: 'tab-1',
      keyword: 'needle-only-in-b'
    });
    assert.equal(autoResult.total, 0);

    const legacyResult = store.query({
      days: 1,
      tabId: 'tab-1',
      keyword: 'needle-only-in-b',
      queryMode: 'legacy'
    });
    assert.equal(legacyResult.total, 1);
  } finally {
    ctx.dispose();
  }
});

test('query returns stats for observability', () => {
  const ctx = createTempArchiveContext();
  try {
    const filePath = path.join(ctx.dayDir, 'stats.jsonl');
    const record = {
      ts: new Date().toISOString(),
      sessionId: 'session-2',
      tabId: 'tab-2',
      cwd: '/tmp',
      eventType: 'heartbeat',
      status: '进行中',
      summary: 'stats summary',
      analysis: 'stats analysis'
    };
    writeRecord(filePath, record);

    const store = createArchiveStore({
      getArchiveRootDir: () => ctx.root,
      resolveSessionIdByTab: () => '',
      maxQueryDays: 90,
      maxQueryLimit: 200,
      defaultQueryDays: 14,
      defaultQueryLimit: 40
    });

    const result = store.query({
      days: 1,
      tabId: 'tab-2'
    });

    assert.equal(result.total, 1);
    assert.equal(result.stats.queryMode, 'auto');
    assert.equal(typeof result.stats.elapsedMs, 'number');
    assert.ok(result.stats.elapsedMs >= 0);
    assert.ok(result.stats.filesScanned >= 1);
  } finally {
    ctx.dispose();
  }
});

test('upsertSessionMeta writes and increments archive index state', () => {
  const ctx = createTempArchiveContext();
  try {
    const store = createArchiveStore({
      getArchiveRootDir: () => ctx.root,
      resolveSessionIdByTab: () => '',
      maxQueryDays: 90,
      maxQueryLimit: 200,
      defaultQueryDays: 14,
      defaultQueryLimit: 40
    });

    const startedAt = '2026-02-16T10:00:00.000Z';
    const lastAt = '2026-02-16T10:05:00.000Z';
    const endedAt = '2026-02-16T10:06:00.000Z';
    store.upsertSessionMeta({
      sessionId: 'session-meta-1',
      tabId: 'tab-meta-1',
      cwd: '/tmp/meta',
      isAiSession: true,
      cli: 'codex',
      provider: 'openai',
      model: 'gpt-5.2',
      startedAt,
      lastAt,
      archivePath: `${ctx.dayStamp}/session-meta-1.jsonl`,
      incrementEventCount: true,
      lastSummary: 'summary-1',
      lastAnalysis: 'analysis-1',
      lastStatus: '进行中'
    });

    store.upsertSessionMeta({
      sessionId: 'session-meta-1',
      incrementEventCount: true,
      endedAt,
      lastAt: endedAt,
      lastSummary: 'summary-2',
      lastAnalysis: 'analysis-2',
      lastStatus: '阶段完成'
    });

    const indexPath = path.join(ctx.root, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(index.version, 1);
    assert.equal(typeof index.updatedAt, 'string');
    assert.equal(index.updatedAt.length > 0, true);

    const session = index.sessions['session-meta-1'];
    assert.equal(session.sessionId, 'session-meta-1');
    assert.equal(session.tabId, 'tab-meta-1');
    assert.equal(session.cwd, '/tmp/meta');
    assert.equal(session.cli, 'codex');
    assert.equal(session.provider, 'openai');
    assert.equal(session.model, 'gpt-5.2');
    assert.equal(session.eventCount, 2);
    assert.equal(session.startedAt, startedAt);
    assert.equal(session.lastAt, endedAt);
    assert.equal(session.endedAt, endedAt);
    assert.equal(session.lastSummary, 'summary-2');
    assert.equal(session.lastAnalysis, 'analysis-2');
    assert.equal(session.lastStatus, '阶段完成');
  } finally {
    ctx.dispose();
  }
});
