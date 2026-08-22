const DEFAULTS = {
  protocol: 'anthropic',
  base_url: 'https://ark.cn-beijing.volces.com/api/plan',
  api_key: '',
  model: '',
  auth_scheme: 'bearer',
  temperature: 0.7,
  max_tokens: 8192,
  system_prompt: 'You are chp, a capable desktop AI assistant. Chat naturally. In work mode, inspect the local workspace before making assumptions, keep edits scoped to the selected project, prefer small reversible changes, and report what you changed.',
};

function normalizeConfig(input = {}) {
  const merged = { ...DEFAULTS, ...input };
  if (input.endpoint && !input.base_url) merged.base_url = input.endpoint;
  if (input.provider === 'openai-compatible' && !input.protocol) merged.protocol = 'openai';
  if (input.systemPrompt && !input.system_prompt) merged.system_prompt = input.systemPrompt;
  merged.protocol = String(merged.protocol || 'anthropic').trim().toLowerCase();
  merged.auth_scheme = String(merged.auth_scheme || 'bearer').trim().toLowerCase();
  merged.base_url = String(merged.base_url || '').trim().replace(/\/+$/, '');
  merged.model = String(merged.model || '').trim();
  merged.api_key = String(merged.api_key || '');
  merged.temperature = Math.max(0, Math.min(2, Number(merged.temperature) || 0));
  merged.max_tokens = Math.max(256, Math.min(131072, Number(merged.max_tokens) || 8192));
  merged.system_prompt = String(merged.system_prompt || '');
  if (!['openai', 'anthropic'].includes(merged.protocol)) throw new Error('协议必须是 anthropic 或 openai。');
  if (!merged.base_url) throw new Error('Base URL 不能为空。');
  const parsed = new URL(merged.base_url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('模型接口只支持 HTTP/HTTPS。');
  return merged;
}

function endpointFor(cfg) {
  const base = cfg.base_url.replace(/\/+$/, '');
  if (cfg.protocol === 'anthropic') {
    if (/\/v1\/messages$/i.test(base)) return base;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function headersFor(cfg) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.api_key) {
    if (cfg.auth_scheme === 'x-api-key') headers['x-api-key'] = cfg.api_key;
    else headers.authorization = `Bearer ${cfg.api_key}`;
  }
  if (cfg.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
}

function genericToolsToOpenAI(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function genericToolsToAnthropic(tools = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.input_schema || { type: 'object', properties: {} },
  }));
}

function toOpenAIMessages(messages = []) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: String(message.content ?? '') });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      });
      continue;
    }
    out.push({ role: message.role, content: String(message.content ?? '') });
  }
  return out;
}

function toAnthropicMessages(messages = []) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: String(message.content ?? ''),
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((x) => x.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: String(message.content) });
      for (const call of message.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      out.push({ role: 'assistant', content });
      continue;
    }
    if (message.role === 'user' || message.role === 'assistant') out.push({ role: message.role, content: String(message.content ?? '') });
  }
  return out;
}

function buildBody(cfg, messages, tools, stream) {
  if (cfg.protocol === 'anthropic') {
    return {
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      temperature: cfg.temperature,
      stream,
      ...(cfg.system_prompt ? { system: cfg.system_prompt } : {}),
      messages: toAnthropicMessages(messages),
      ...(tools?.length ? { tools: genericToolsToAnthropic(tools) } : {}),
    };
  }
  return {
    model: cfg.model,
    messages: [...(cfg.system_prompt ? [{ role: 'system', content: cfg.system_prompt }] : []), ...toOpenAIMessages(messages)],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    stream,
    ...(tools?.length ? { tools: genericToolsToOpenAI(tools), tool_choice: 'auto' } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

async function readSSE(response, onEvent, signal) {
  if (!response.body) throw new Error('模型接口没有返回流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (frame) => {
    let eventName = '';
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return;
    try { onEvent(eventName, JSON.parse(data)); } catch {}
  };
  while (true) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) consume(frame);
  }
  if (buffer.trim()) consume(buffer);
}

function parseJsonResponse(cfg, json) {
  if (cfg.protocol === 'anthropic') {
    const text = (json?.content || []).filter((x) => x?.type === 'text').map((x) => x.text || '').join('');
    const toolCalls = (json?.content || []).filter((x) => x?.type === 'tool_use').map((x) => ({ id: x.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: x.name || '', input: x.input || {} }));
    return { text, toolCalls, finishReason: json?.stop_reason || '', usage: json?.usage || null };
  }
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const toolCalls = (msg.tool_calls || []).map((x) => {
    let input = {};
    try { input = JSON.parse(x?.function?.arguments || '{}'); } catch { input = { _raw: x?.function?.arguments || '' }; }
    return { id: x.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: x?.function?.name || '', input };
  });
  return { text: msg.content || '', toolCalls, finishReason: choice.finish_reason || '', usage: json?.usage || null };
}

async function modelTurn({ config, messages, tools = [], signal, onDelta, onToolDelta, onUsage }) {
  const cfg = normalizeConfig(config);
  if (!cfg.model) throw new Error('请先配置模型名。');
  const url = endpointFor(cfg);
  const response = await fetch(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(buildBody(cfg, messages, tools, true)), signal });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 4000);
    throw new Error(`${cfg.protocol} HTTP ${response.status}: ${text || response.statusText}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`模型返回了无法解析的响应：${text.slice(0, 800)}`); }
    const parsed = parseJsonResponse(cfg, json);
    if (parsed.text) onDelta?.(parsed.text);
    if (parsed.toolCalls.length) onToolDelta?.(parsed.toolCalls);
    if (parsed.usage) onUsage?.(parsed.usage);
    return parsed;
  }
  let text = '';
  let finishReason = '';
  let usage = null;
  const openAiCalls = new Map();
  const anthropicCalls = new Map();
  await readSSE(response, (eventName, evt) => {
    if (cfg.protocol === 'openai') {
      const choice = evt?.choices?.[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) { text += delta.content; onDelta?.(delta.content); }
      if (Array.isArray(delta.tool_calls)) {
        for (const item of delta.tool_calls) {
          const index = Number.isInteger(item.index) ? item.index : openAiCalls.size;
          const current = openAiCalls.get(index) || { id: '', name: '', arguments: '' };
          if (item.id) current.id = item.id;
          if (item.function?.name) current.name += item.function.name;
          if (item.function?.arguments) current.arguments += item.function.arguments;
          openAiCalls.set(index, current);
          onToolDelta?.([{ index, id: current.id, name: current.name, arguments: item.function?.arguments || '' }]);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (evt?.usage) { usage = evt.usage; onUsage?.(usage); }
      return;
    }
    const type = evt?.type || eventName;
    if (type === 'content_block_start' && evt?.content_block?.type === 'tool_use') anthropicCalls.set(evt.index, { id: evt.content_block.id || `tool_${Date.now()}_${evt.index}`, name: evt.content_block.name || '', arguments: '', initial: evt.content_block.input || {} });
    if (type === 'content_block_delta') {
      if (evt?.delta?.type === 'text_delta' && evt.delta.text) { text += evt.delta.text; onDelta?.(evt.delta.text); }
      if (evt?.delta?.type === 'input_json_delta') {
        const current = anthropicCalls.get(evt.index) || { id: `tool_${Date.now()}_${evt.index}`, name: '', arguments: '', initial: {} };
        current.arguments += evt.delta.partial_json || '';
        anthropicCalls.set(evt.index, current);
        onToolDelta?.([{ index: evt.index, id: current.id, name: current.name, arguments: evt.delta.partial_json || '' }]);
      }
    }
    if (type === 'message_delta') {
      if (evt?.delta?.stop_reason) finishReason = evt.delta.stop_reason;
      if (evt?.usage) { usage = evt.usage; onUsage?.(usage); }
    }
    if (type === 'message_start' && evt?.message?.usage) { usage = evt.message.usage; onUsage?.(usage); }
  }, signal);
  const toolCalls = [];
  if (cfg.protocol === 'openai') {
    for (const [, call] of [...openAiCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input = {};
      try { input = JSON.parse(call.arguments || '{}'); } catch { input = { _raw: call.arguments || '' }; }
      toolCalls.push({ id: call.id || `tool_${Date.now()}_${toolCalls.length}`, name: call.name, input });
    }
  } else {
    for (const [, call] of [...anthropicCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input = call.initial || {};
      if (call.arguments) { try { input = JSON.parse(call.arguments); } catch { input = { ...input, _raw: call.arguments }; } }
      toolCalls.push({ id: call.id, name: call.name, input });
    }
  }
  return { text, toolCalls, finishReason, usage };
}

async function testConnection(config) {
  const cfg = normalizeConfig(config);
  if (!cfg.model) throw new Error('请先配置模型名。');
  const url = endpointFor(cfg);
  const body = buildBody(cfg, [{ role: 'user', content: 'Reply with exactly: CHP_OK' }], [], false);
  const response = await fetch(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${cfg.protocol} HTTP ${response.status}: ${text.slice(0, 2500)}`);
  let parsedText = text;
  try { parsedText = parseJsonResponse(cfg, JSON.parse(text)).text || text; } catch {}
  return { ok: true, protocol: cfg.protocol, endpoint: url, model: cfg.model, output: String(parsedText).slice(0, 500) };
}

module.exports = { DEFAULTS, normalizeConfig, endpointFor, modelTurn, testConnection };
