function shouldLogArchiveMetrics(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  if (options.settingsEnabled === true) return true;
  if (String(env.SHAOTERM_ARCHIVE_METRICS || '').trim() === '1') return true;
  if (String(env.SHAOTERM_DEBUG || '').trim() === '1') return true;
  return false;
}

module.exports = {
  shouldLogArchiveMetrics
};
