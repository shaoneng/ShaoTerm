const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');

// 使用用户数据目录存储配置
const configPath = path.join(app.getPath('userData'), 'config.json');
const ENCRYPTED_API_KEY_PREFIX = 'enc:v1:';

let apiKey = '';
let baseUrl = '';
let aiCommand = 'codex';
let client = null;
let configLoaded = false;
const HEARTBEAT_MAX_CONTEXT_CHARS = 2600;
const DEFAULT_HEARTBEAT_ENABLED = true;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_PREFER_SESSION_AI = false;
const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const HEARTBEAT_ERROR_PATTERN = /\b(error|failed|failure|exception|traceback|fatal|panic)\b|失败|错误|异常/i;
const HEARTBEAT_SUCCESS_PATTERN = /\b(done|success|completed|finished)\b|成功|完成|已完成/i;
const HEARTBEAT_WAITING_PATTERN = /\b(waiting|awaiting|confirm|proceed|yes\/no|y\/n)\b|是否继续|请确认|确认\?/i;
let heartbeatEnabled = DEFAULT_HEARTBEAT_ENABLED;
let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
let heartbeatPreferSessionAi = DEFAULT_HEARTBEAT_PREFER_SESSION_AI;
const DEFAULT_OPENAI_HEARTBEAT_MODEL = 'gpt-5.1-codex';
const OPENAI_CHAT_COMPLETIONS_SUFFIX = '/v1/chat/completions';
const OPENAI_REQUEST_TIMEOUT_MS = 30000;
const ANALYSIS_BACKEND = {
  ANTHROPIC: 'anthropic',
  OPENAI_COMPAT: 'openai_compat'
};

function normalizeAiCommand(value) {
  const normalized = (value || '').trim();
  return normalized || 'codex';
}

function normalizeHeartbeatEnabled(value) {
  return value !== false;
}

function normalizeHeartbeatIntervalMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.round(n)));
}

function normalizeHeartbeatPreferSessionAi(value) {
  return value === true;
}

function normalizeBaseUrlForRequests(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const prefixed = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return prefixed.replace(/\/+$/, '');
}

function parseAiModelFromCommand(commandValue) {
  const command = String(commandValue || '').trim();
  if (!command) return '';

  const modelFlagMatch = command.match(/(?:^|\s)(?:-m|--model)\s+([^\s]+)/i);
  if (modelFlagMatch && modelFlagMatch[1]) {
    return modelFlagMatch[1].trim();
  }

  const modelTokenPatterns = [
    /\b(gpt-[a-z0-9.\-_]+)\b/i,
    /\b(claude-[a-z0-9.\-_]+)\b/i,
    /\b(gemini-[a-z0-9.\-_]+)\b/i,
    /\b(qwen[-a-z0-9.\-_]+)\b/i,
    /\b(deepseek[-a-z0-9.\-_]+)\b/i
  ];

  for (const pattern of modelTokenPatterns) {
    const match = command.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return '';
}

function inferProviderFromAiCommand(commandValue) {
  const lower = String(commandValue || '').toLowerCase();
  if (!lower) return 'unknown';
  if (/\bcodex\b|\bgpt-[a-z0-9.\-_]*/.test(lower) || lower.includes('openai')) return 'openai';
  if (/\bclaude\b|\banthropic\b/.test(lower)) return 'anthropic';
  if (/\bgemini\b|\bgoogle-ai\b/.test(lower)) return 'google';
  if (/\bqwen\b|\bdashscope\b/.test(lower)) return 'qwen';
  if (/\bdeepseek\b/.test(lower)) return 'deepseek';
  return 'unknown';
}

function normalizeAnalysisContext(context = {}) {
  const source = context && typeof context === 'object' ? context : {};
  const sessionProfile = source.sessionProfile && typeof source.sessionProfile === 'object'
    ? source.sessionProfile
    : {};
  const commandHint = String(source.aiCommand || source.command || '').trim();
  const profileCommandHint = String(sessionProfile.aiCommand || '').trim();
  const effectiveCommand = commandHint || profileCommandHint || aiCommand;
  const provider = String(source.provider || sessionProfile.provider || inferProviderFromAiCommand(effectiveCommand)).trim() || 'unknown';
  const model = String(source.model || sessionProfile.model || parseAiModelFromCommand(effectiveCommand)).trim();
  const resolvedBaseUrl = source.baseUrl !== undefined ? String(source.baseUrl || '').trim() : baseUrl;

  return {
    provider,
    model,
    aiCommand: effectiveCommand,
    baseUrl: resolvedBaseUrl
  };
}

function isLikelyVibeProxyUrl(parsedUrl) {
  if (!parsedUrl) return false;
  const host = String(parsedUrl.hostname || '').toLowerCase();
  const port = String(parsedUrl.port || '');
  if (!(host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0')) return false;
  return port === '8317' || port === '8318';
}

function resolveAnalysisBackend(context = {}) {
  const normalizedContext = normalizeAnalysisContext(context);
  const providerHint = normalizedContext.provider || inferProviderFromAiCommand(normalizedContext.aiCommand);
  const normalizedBaseUrl = normalizeBaseUrlForRequests(normalizedContext.baseUrl);

  if (!normalizedBaseUrl) {
    return ANALYSIS_BACKEND.ANTHROPIC;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedBaseUrl);
  } catch (err) {
    return ANALYSIS_BACKEND.ANTHROPIC;
  }

  const host = String(parsedUrl.hostname || '').toLowerCase();
  if (host.includes('anthropic')) return ANALYSIS_BACKEND.ANTHROPIC;
  if (host.includes('openai')) return ANALYSIS_BACKEND.OPENAI_COMPAT;
  if (isLikelyVibeProxyUrl(parsedUrl)) {
    return providerHint === 'anthropic'
      ? ANALYSIS_BACKEND.ANTHROPIC
      : ANALYSIS_BACKEND.OPENAI_COMPAT;
  }

  if (heartbeatPreferSessionAi && providerHint === 'openai') {
    return ANALYSIS_BACKEND.OPENAI_COMPAT;
  }

  return ANALYSIS_BACKEND.ANTHROPIC;
}

function resolveOpenAIHeartbeatModel(context = {}) {
  const normalizedContext = normalizeAnalysisContext(context);
  return normalizedContext.model || parseAiModelFromCommand(normalizedContext.aiCommand) || DEFAULT_OPENAI_HEARTBEAT_MODEL;
}

function buildOpenAIChatCompletionsUrl(base) {
  if (!base) return '';
  if (base.endsWith('/v1')) {
    return `${base}/chat/completions`;
  }
  return `${base}${OPENAI_CHAT_COMPLETIONS_SUFFIX}`;
}

function extractOpenAIMessageText(payload) {
  const choice = payload && payload.choices && payload.choices[0] ? payload.choices[0] : null;
  if (!choice || !choice.message) return '';
  const content = choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch (err) {
      return '';
    }
  }
  return '';
}

async function createOpenAICompatibleCompletion(messages, maxTokens = 180, context = {}) {
  const normalizedContext = normalizeAnalysisContext(context);
  const normalizedBaseUrl = normalizeBaseUrlForRequests(normalizedContext.baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error('Missing base URL for OpenAI-compatible heartbeat backend');
  }
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable in current runtime');
  }

  const requestUrl = buildOpenAIChatCompletionsUrl(normalizedBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: resolveOpenAIHeartbeatModel(normalizedContext),
        max_tokens: maxTokens,
        temperature: 0.2,
        messages
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI-compatible request failed (${response.status}): ${errorBody.slice(0, 240)}`);
    }

    const payload = await response.json();
    return extractOpenAIMessageText(payload);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTopicText(raw) {
  const compact = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '新对话';
  const cleaned = compact
    .replace(/^["'“”`]+|["'“”`]+$/g, '')
    .replace(/[。！!?,，；;：:]/g, '')
    .trim();
  if (!cleaned) return '新对话';
  return cleaned.slice(0, 12);
}

function isSafeStorageAvailable() {
  try {
    return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  } catch (err) {
    return false;
  }
}

function encodeApiKeyForStorage(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (!isSafeStorageAvailable()) return value;
  try {
    const encrypted = safeStorage.encryptString(value).toString('base64');
    return `${ENCRYPTED_API_KEY_PREFIX}${encrypted}`;
  } catch (err) {
    console.warn('Failed to encrypt API key, using plain text fallback:', err.message);
    return value;
  }
}

function decodeApiKeyFromStorage(storedValue) {
  const value = String(storedValue || '').trim();
  if (!value) return '';
  if (!value.startsWith(ENCRYPTED_API_KEY_PREFIX)) return value;
  if (!isSafeStorageAvailable()) return '';
  try {
    const base64Payload = value.slice(ENCRYPTED_API_KEY_PREFIX.length);
    const decrypted = safeStorage.decryptString(Buffer.from(base64Payload, 'base64'));
    return String(decrypted || '').trim();
  } catch (err) {
    console.warn('Failed to decrypt API key from config:', err.message);
    return '';
  }
}

// 加载配置
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      const rawStoredApiKey = String(config.apiKey || '').trim();
      apiKey = decodeApiKeyFromStorage(rawStoredApiKey);
      baseUrl = config.baseUrl || '';
      aiCommand = normalizeAiCommand(config.aiCommand);
      heartbeatEnabled = normalizeHeartbeatEnabled(config.heartbeatEnabled);
      heartbeatIntervalMs = normalizeHeartbeatIntervalMs(config.heartbeatIntervalMs);
      heartbeatPreferSessionAi = normalizeHeartbeatPreferSessionAi(config.heartbeatPreferSessionAi);
      if (rawStoredApiKey && !rawStoredApiKey.startsWith(ENCRYPTED_API_KEY_PREFIX) && isSafeStorageAvailable()) {
        saveConfig();
      }
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// 保存配置
function saveConfig() {
  try {
    const config = {
      apiKey: encodeApiKeyForStorage(apiKey),
      baseUrl,
      aiCommand,
      heartbeatEnabled,
      heartbeatIntervalMs,
      heartbeatPreferSessionAi
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

function ensureConfigLoaded() {
  if (configLoaded) return;
  loadConfig();
  configLoaded = true;
}

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x09\x0B-\x1F]/g, '');
}

function configure(newApiKey, newBaseUrl, newAiCommand, heartbeatConfig = {}) {
  ensureConfigLoaded();
  apiKey = newApiKey;
  baseUrl = newBaseUrl;
  aiCommand = normalizeAiCommand(newAiCommand);
  heartbeatEnabled = normalizeHeartbeatEnabled(heartbeatConfig.heartbeatEnabled);
  heartbeatIntervalMs = normalizeHeartbeatIntervalMs(heartbeatConfig.heartbeatIntervalMs);
  heartbeatPreferSessionAi = normalizeHeartbeatPreferSessionAi(heartbeatConfig.heartbeatPreferSessionAi);
  client = null;
  saveConfig();
}

function getConfig() {
  ensureConfigLoaded();
  return {
    apiKey,
    baseUrl,
    aiCommand,
    heartbeatEnabled,
    heartbeatIntervalMs,
    heartbeatPreferSessionAi
  };
}

function getClient() {
  ensureConfigLoaded();
  if (!client) {
    const opts = { apiKey };
    if (baseUrl) opts.baseURL = baseUrl;
    client = new Anthropic(opts);
  }
  return client;
}

function inferHeartbeatStatus(cleaned) {
  if (HEARTBEAT_ERROR_PATTERN.test(cleaned)) return '异常';
  if (HEARTBEAT_WAITING_PATTERN.test(cleaned)) return '待输入';
  if (HEARTBEAT_SUCCESS_PATTERN.test(cleaned)) return '阶段完成';
  return '进行中';
}

async function detectTopic(bufferContent, context = {}) {
  ensureConfigLoaded();
  const cleaned = stripAnsi(bufferContent).trim();
  if (!cleaned || cleaned.length < 50) {
    return '新对话';
  }

  async function detectTopicViaOpenAICompat() {
    const text = await createOpenAICompatibleCompletion([
      {
        role: 'system',
        content: '你是终端主题提取助手。只输出3-5个中文字主题词，不要解释，不要标点。无法判断时输出"新对话"。'
      },
      {
        role: 'user',
        content: cleaned.slice(-2000)
      }
    ], 40, context);
    return normalizeTopicText(text);
  }

  const backend = resolveAnalysisBackend(context);
  if (backend === ANALYSIS_BACKEND.OPENAI_COMPAT) {
    try {
      return await detectTopicViaOpenAICompat();
    } catch (err) {
      console.warn('OpenAI-compatible topic detection failed, fallback to Anthropic:', err.message);
      if (!apiKey) return '新对话';
    }
  }

  if (!apiKey) {
    const fallbackBaseUrl = normalizeBaseUrlForRequests(normalizeAnalysisContext(context).baseUrl);
    if (fallbackBaseUrl) {
      try {
        return await detectTopicViaOpenAICompat();
      } catch (fallbackErr) {
        console.warn('OpenAI-compatible fallback for topic detection failed:', fallbackErr.message);
      }
    }
    return '新对话';
  }

  try {
    const anthropic = getClient();
    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `请用3-5个中文字总结以下终端对话的主题。只输出主题词，不要任何解释或标点符号。如果内容不足以判断主题，请输出"新对话"。\n\n${cleaned.slice(-2000)}`
      }]
    });

    return normalizeTopicText(message.content[0].text);
  } catch (err) {
    console.warn('Anthropic topic detection failed:', err.message);
    return '新对话';
  }
}

function createFallbackHeartbeat(cleaned) {
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = (lines.slice(-4).join(' | ').slice(0, 80) || '会话进行中').replace(/\s+/g, ' ');
  const status = inferHeartbeatStatus(cleaned);
  const analysisByStatus = {
    '异常': '检测到异常输出，建议先定位最近报错上下文，再决定后续处理步骤。',
    '待输入': '会话当前处于等待输入状态，建议先确认上一步输出含义，再继续交互。',
    '阶段完成': '检测到阶段性完成信号，建议进行结果校验并推进下一步任务。',
    '进行中': '会话持续推进中，建议关注最新输出中的关键变化与潜在风险。'
  };

  return {
    summary,
    analysis: `状态：${status}。${analysisByStatus[status] || analysisByStatus['进行中']}`
  };
}

function parseHeartbeatFromResponse(text, fallback) {
  if (!text || typeof text !== 'string') return fallback;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const summary = String(parsed.summary || '').trim();
    const analysis = String(parsed.analysis || '').trim();
    if (!summary || !analysis) return fallback;
    return {
      summary: summary.slice(0, 140),
      analysis: analysis.slice(0, 240)
    };
  } catch (err) {
    return fallback;
  }
}

async function analyzeHeartbeat(bufferContent, context = {}) {
  ensureConfigLoaded();
  const cleaned = stripAnsi(bufferContent).trim();
  if (!cleaned) {
    return {
      summary: '会话暂时无输出',
      analysis: '状态：等待新内容。'
    };
  }

  const fallback = createFallbackHeartbeat(cleaned);
  const backend = resolveAnalysisBackend(context);

  if (backend === ANALYSIS_BACKEND.OPENAI_COMPAT) {
    try {
      const text = await createOpenAICompatibleCompletion([
        {
          role: 'system',
          content: '你是终端会话监控分析助手。严格输出 JSON：{"summary":"当前进展总结","analysis":"状态判断与后续分析"}。不要输出任何额外文字，不要输出按键级指令（如 y/yes）。'
        },
        {
          role: 'user',
          content: `请基于以下终端日志生成总结。
要求：
1) summary 20-40字，聚焦当前会话进展与关键结果。
2) analysis 40-90字，给出状态判断、风险点与下一步建议。
3) 只输出 JSON。

终端日志：
${cleaned.slice(-HEARTBEAT_MAX_CONTEXT_CHARS)}`
        }
      ], 180, context);
      return parseHeartbeatFromResponse(text, fallback);
    } catch (err) {
      console.warn('Heartbeat analysis fallback due to OpenAI-compatible API error:', err.message);
      if (!apiKey) {
        return fallback;
      }
    }
  }

  if (!apiKey) {
    return fallback;
  }

  try {
    const anthropic = getClient();
    const message = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 180,
      messages: [{
        role: 'user',
        content: `你是终端会话监控分析助手。请阅读以下终端日志，输出 JSON：
{"summary":"当前进展总结","analysis":"状态判断与后续分析"}
要求：
1) summary 20-40字，聚焦当前会话进展与关键结果。
2) analysis 40-90字，给出状态判断、风险点与下一步建议。
3) 不要输出任何按键级指令（例如 y/yes）。
4) 只输出 JSON，不要输出其他内容。

终端日志：
${cleaned.slice(-HEARTBEAT_MAX_CONTEXT_CHARS)}`
      }]
    });

    const text = message && message.content && message.content[0] ? message.content[0].text : '';
    return parseHeartbeatFromResponse(text, fallback);
  } catch (err) {
    console.warn('Heartbeat analysis fallback due to API error:', err.message);
    return fallback;
  }
}

async function detectTopics(tabBuffers) {
  ensureConfigLoaded();
  const results = await Promise.allSettled(
    tabBuffers.map(async ({ tabId, buffer, context }) => {
      const topic = await detectTopic(buffer, context || {});
      return { tabId, topic };
    })
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return { tabId: tabBuffers[i].tabId, topic: '新对话' };
  });
}

module.exports = { detectTopic, detectTopics, analyzeHeartbeat, stripAnsi, configure, getConfig };
