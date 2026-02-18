const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isConfirmPending,
  getConfirmPendingTabIds,
  formatConfirmQueueLabel,
  pickNextConfirmTabId
} = require('../renderer/confirm-hint');

test('isConfirmPending checks explicit confirmation flag', () => {
  assert.equal(isConfirmPending({ confirmPending: true }), true);
  assert.equal(isConfirmPending({ confirmPending: false }), false);
  assert.equal(isConfirmPending({}), false);
  assert.equal(isConfirmPending(null), false);
});

test('getConfirmPendingTabIds returns queued ids in tab order', () => {
  const tabs = [
    { id: 'tab-1', confirmPending: false },
    { id: 'tab-2', confirmPending: true },
    { id: 'tab-3', confirmPending: true },
    { id: 'tab-4', confirmPending: false }
  ];
  assert.deepEqual(getConfirmPendingTabIds(tabs), ['tab-2', 'tab-3']);
});

test('formatConfirmQueueLabel formats visible counter label', () => {
  assert.equal(formatConfirmQueueLabel(0), '');
  assert.equal(formatConfirmQueueLabel(1), '待确认 1');
  assert.equal(formatConfirmQueueLabel(7), '待确认 7');
  assert.equal(formatConfirmQueueLabel(11), '待确认 9+');
});

test('pickNextConfirmTabId picks next pending tab in cycle', () => {
  const tabs = [
    { id: 'tab-1', confirmPending: false },
    { id: 'tab-2', confirmPending: true },
    { id: 'tab-3', confirmPending: true }
  ];

  assert.equal(pickNextConfirmTabId(tabs, 'tab-1'), 'tab-2');
  assert.equal(pickNextConfirmTabId(tabs, 'tab-2'), 'tab-3');
  assert.equal(pickNextConfirmTabId(tabs, 'tab-3'), 'tab-2');
  assert.equal(pickNextConfirmTabId(tabs, 'tab-x'), 'tab-2');
  assert.equal(pickNextConfirmTabId([], 'tab-1'), '');
});
