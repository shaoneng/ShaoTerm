const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// 使用用户数据目录存储配置
const configPath = path.join(app.getPath('userData'), 'config.json');

let apiKey = '';
let baseUrl = '';
let aiCommand = 'codex';
let client = null;
const HEARTBEAT_MAX_CONTEXT_CHARS = 2600;
const DEFAULT_HEARTBEAT_ENABLED = true;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_HEARTBEAT_PREFER_SESSION_AI = false;
const MIN_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const MAX_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
let heartbeatEnabled = DEFAULT_HEARTBEAT_ENABLED;
let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
let heartbeatPreferSessionAi = DEFAULT_HEARTBEAT_PREFER_SESSION_AI;

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

// 加载配置
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      apiKey = config.apiKey || '';
      baseUrl = config.baseUrl || '';
      aiCommand = normalizeAiCommand(config.aiCommand);
      heartbeatEnabled = normalizeHeartbeatEnabled(config.heartbeatEnabled);
      heartbeatIntervalMs = normalizeHeartbeatIntervalMs(config.heartbeatIntervalMs);
      heartbeatPreferSessionAi = normalizeHeartbeatPreferSessionAi(config.heartbeatPreferSessionAi);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// 保存配置
function saveConfig() {
  try {
    const config = {
      apiKey,
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

// 初始化时加载配置
loadConfig();

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x09\x0B-\x1F]/g, '');
}

function configure(newApiKey, newBaseUrl, newAiCommand, heartbeatConfig = {}) {
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
  if (!client) {
    const opts = { apiKey };
    if (baseUrl) opts.baseURL = baseUrl;
    client = new Anthropic(opts);
  }
  return client;
}

async function detectTopic(bufferContent) {
  const cleaned = stripAnsi(bufferContent).trim();
  if (!cleaned || cleaned.length < 50) {
    return '新对话';
  }

  const anthropic = getClient();
  const message = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 30,
    messages: [{
      role: 'user',
      content: `请用3-5个中文字总结以下终端对话的主题。只输出主题词，不要任何解释或标点符号。如果内容不足以判断主题，请输出"新对话"。\n\n${cleaned.slice(-2000)}`
    }]
  });

  return message.content[0].text.trim();
}

function createFallbackHeartbeat(cleaned) {
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = (lines.slice(-4).join(' | ').slice(0, 80) || '会话进行中').replace(/\s+/g, ' ');

  let status = '进行中';
  if (/\b(error|failed|exception|traceback|fatal)\b|失败|错误|异常/i.test(cleaned)) {
    status = '出现异常';
  } else if (/\b(done|success|completed|finished)\b|完成|已完成|成功/i.test(cleaned)) {
    status = '阶段完成';
  }

  return {
    summary,
    analysis: `状态：${status}。建议继续查看最新输出并决定下一步。`
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
      summary: summary.slice(0, 120),
      analysis: analysis.slice(0, 200)
    };
  } catch (err) {
    return fallback;
  }
}

async function analyzeHeartbeat(bufferContent) {
  const cleaned = stripAnsi(bufferContent).trim();
  if (!cleaned) {
    return {
      summary: '会话暂时无输出',
      analysis: '状态：等待新内容。'
    };
  }

  const fallback = createFallbackHeartbeat(cleaned);
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
        content: `你是终端会话分析助手。请阅读以下终端日志，输出 JSON：
{"summary":"一句话总结，不超过30字","analysis":"一句话分析与下一步建议，不超过60字"}
只输出 JSON，不要输出其他内容。

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
  const results = await Promise.allSettled(
    tabBuffers.map(async ({ tabId, buffer }) => {
      const topic = await detectTopic(buffer);
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
