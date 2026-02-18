(function bootstrapConfirmHint(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.ConfirmHintUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createConfirmHintUtils() {
  const LABEL_MAX_VISIBLE = 9;

  function isConfirmPending(tabData) {
    return !!(tabData && tabData.confirmPending === true);
  }

  function getConfirmPendingTabIds(tabs) {
    if (!Array.isArray(tabs)) return [];
    return tabs
      .filter((tab) => isConfirmPending(tab))
      .map((tab) => String((tab && tab.id) || '').trim())
      .filter(Boolean);
  }

  function formatConfirmQueueLabel(count) {
    const normalized = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
    if (normalized <= 0) return '';
    if (normalized > LABEL_MAX_VISIBLE) return `待确认 ${LABEL_MAX_VISIBLE}+`;
    return `待确认 ${normalized}`;
  }

  function pickNextConfirmTabId(tabs, activeTabId) {
    const ids = getConfirmPendingTabIds(tabs);
    if (ids.length === 0) return '';

    const active = String(activeTabId || '').trim();
    const activeIndex = ids.indexOf(active);
    if (activeIndex < 0) return ids[0];
    return ids[(activeIndex + 1) % ids.length] || ids[0];
  }

  return {
    isConfirmPending,
    getConfirmPendingTabIds,
    formatConfirmQueueLabel,
    pickNextConfirmTabId
  };
});
