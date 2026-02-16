const { createMemoryArchiveIndex } = require('./memory-index');
const { createJsonlStore } = require('./jsonl-store');

function createArchiveStore(options = {}) {
  const driver = String(options.driver || 'jsonl').trim().toLowerCase();
  if (driver !== 'jsonl') {
    throw new Error(`Unsupported archive driver: ${driver}`);
  }

  const index = createMemoryArchiveIndex();
  return createJsonlStore({
    ...options,
    index
  });
}

module.exports = {
  createArchiveStore
};
