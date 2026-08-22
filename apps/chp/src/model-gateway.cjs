const DEFAULTS = {
  protocol: 'openai',
  base_url: 'http://127.0.0.1:11434/v1',
  api_key: '',
  model: '',
  auth_scheme: 'bearer',
  temperature: 0.7,
  max_tokens: 4096,
  system_prompt: 'You are chp, a practical desktop AI assistant. Be useful, concise, careful with user files, and ask before destructive actions.',
};

const normalizeConfig = (input = {}) => {
  const merged = { ...DEFAULTS, ...input };
  if (input.endpoint && !input.base_url) merged.base_url = input.endpoint;
  if (input.provider === 'openai-compatible' && !input.protocol) merged.protocol = 'openai';
  if (input.systemPrompt && !input.system_prompt) merged.system_prompt = input.systemPrompt;
  merged.protocol = String(merged.protocol || 'openai').toLowerCase();
  merged.auth_scheme = String(merged.auth_scheme || 'bearer').toLowerCase();
  merged.base_url = String(merged.base_url || '').trim().replace(/\/+$/, '');
  merged.model = String(merged.model || '').trim();
  merged.api_key = String(merged.api_key || '');
  merged.temperature = Number.isFinite(Number(merged.temperature)) ? Number(merged.temperature) : 0.7;
  merged.max_tokens = Number.isFinite(Number(merged.max_tokens)) ? Number(merged.max_tokens) : 4096;
  merged.system_prompt = String(merged.system_prompt || '');
  if (!['openai', 'anthropic'].includes(merged.protocol)) throw new Error('protocol must be "openai" or "anthropic".');
  if (!merged.base_url) throw new Error('base_url is required.');
  const url = new URL(merged.base_url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http/https model endpoints are supported.');
  return merged;
};

const endpointFor = (cfg) => {
  const base = cfg.base_url.replace(/\/+$/, '');
  if (cfg.protocol === 'anthropic') {
    if (/\/v1\/messages$/i.test(base)) return base;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
};

const headersFor = (cfg) => {
  const headers = { 'content-type': 'application/json' };
  if (cfg.api_key) {
    if (cfg.auth_scheme === 'x-api-key') headers['x-api-key'] = cfg.api_key;
    else headers.authorization = `Bearer ${cfg.api_key}`;
  }
  if (cfg.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
};

const openAiBody = (cfg, messages, stream) => ({
  model: cfg.model,
  messages: [
    ...(cfg.system_prompt ? [{ role: 'system', content: cfg.system_prompt }] : []),
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ],
  temperature: cfg.temperature,
  max_tokens: cfg.max_tokens,
  stream,
});

const anthropicBody = (cfg, messages, stream) => ({
  model: cfg.model,
  max_tokens: cfg.max_tokens,
  temperature: cfg.temperature,
  stream,
  ...(cfg.system_prompt ? { system: cfg.system_prompt } : {}),
  messages: messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
});

async function readSse(response, onEvent, signal) {
  if (!response.body) throw new Error('Model returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      let eventName = '';
      const dataLines = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const data = dataLines.join('\n');
      if (data === '[DONE]') continue;
      try { onEvent(eventName, JSON.parse(data)); } catch {}
    }
  }
}

async function streamChat({ config, messages, signal, onDelta, onToolDelta, onUsage }) {
  const cfg = normalizeConfig(config);
  if (!cfg.model) throw new Error('Model name is required.');
  const url = endpointFor(cfg);
  const body = cfg.protocol === 'anthropic' ? anthropicBody(cfg, messages, true) : openAiBody(cfg, messages, true);
  const response = await fetch(url, {
    method: 'POST',
    headers: headersFor(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 3000);
    throw new Error(`${cfg.protocol} HTTP ${response.status}: ${text || response.statusText}`);
  }

  if (cfg.protocol === 'openai') {
    await readSse(response, (_eventName, evt) => {
      const choice = evt?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string' && delta.content) onDelta?.(delta.content);
      if (Array.isArray(delta?.tool_calls)) onToolDelta?.(delta.tool_calls);
      if (evt?.usage) onUsage?.(evt.usage);
    }, signal);
    return;
  }

  await readSse(response, (eventName, evt) => {
    const type = evt?.type || eventName;
    if (type === 'content_block_delta') {
      if (evt?.delta?.type === 'text_delta' && evt.delta.text) onDelta?.(evt.delta.text);
      if (evt?.delta?.type === 'input_json_delta') onToolDelta?.([{ index: evt.index, arguments: evt.delta.partial_json || '' }]);
    }
    if (type === 'message_delta' && evt?.usage) onUsage?.(evt.usage);
  }, signal);
}

async function testConnection(config) {
  const cfg = normalizeConfig(config);
  if (!cfg.model) throw new Error('Model name is required.');
  const url = endpointFor(cfg);
  const messages = [{ role: 'user', content: 'Reply with exactly: CHP_OK' }];
  const body = cfg.protocol === 'anthropic' ? anthropicBody(cfg, messages, false) : openAiBody(cfg, messages, false);
  const response = await fetch(url, {
    method: 'POST',
    headers: headersFor(cfg),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${cfg.protocol} HTTP ${response.status}: ${text.slice(0, 2000)}`);
  let output = text;
  try {
    const json = JSON.parse(text);
    output = cfg.protocol === 'anthropic'
      ? (json?.content || []).map((x) => x?.text || '').join('')
      : json?.choices?.[0]?.message?.content || text;
  } catch {}
  return { ok: true, protocol: cfg.protocol, endpoint: url, model: cfg.model, output: String(output).slice(0, 500) };
}

module.exports = { DEFAULTS, normalizeConfig, streamChat, testConnection };
