const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldLogArchiveMetrics } = require('../main/archive-metrics');

test('returns true when runtime setting enabled', () => {
  const result = shouldLogArchiveMetrics({
    settingsEnabled: true,
    env: {}
  });
  assert.equal(result, true);
});

test('returns true when env SHAOTERM_ARCHIVE_METRICS=1', () => {
  const result = shouldLogArchiveMetrics({
    settingsEnabled: false,
    env: { SHAOTERM_ARCHIVE_METRICS: '1' }
  });
  assert.equal(result, true);
});

test('returns true when env SHAOTERM_DEBUG=1', () => {
  const result = shouldLogArchiveMetrics({
    settingsEnabled: false,
    env: { SHAOTERM_DEBUG: '1' }
  });
  assert.equal(result, true);
});

test('returns false by default', () => {
  const result = shouldLogArchiveMetrics({
    settingsEnabled: false,
    env: {}
  });
  assert.equal(result, false);
});
