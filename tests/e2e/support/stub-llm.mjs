// Deterministic OpenAI-compatible model server for the live end-to-end scenarios.
// Usage: node tests/e2e/support/stub-llm.mjs [--port 18791]
// Replies depend only on the last user message, so runs are reproducible:
//   contains the word "slow" -> streams one word every 500 ms for about 20 s
//   anything else            -> "stub reply: <text>"
//   last message is a tool result  -> "tool result: <first line of the result>"
// Tests script tool calls (credential cards) over loopback-only control routes:
//   POST /__stub/script   { match, steps: [[{ name, arguments }], ...] }: a user line containing
//                         `match` gets one batch of tool calls per model call (step n after n
//                         tool rounds), then "tool result: ..." once the steps are used up
//   GET  /__stub/requests the message lists the model received (newest last), so a test can prove
//                         a secret never reached the model
// `plan()` is the single place that decides a reply.
import { createServer } from 'node:http';

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.STUB_LLM_PORT || 18791);
const MODEL = 'stub-model';
const SLOW_WORDS = 40;
const SLOW_INTERVAL_MS = 500;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}

function lastUserText(messages) {
  const user = [...(messages ?? [])].reverse().find((m) => m?.role === 'user');
  return textOf(user?.content).trim();
}

/** Scripted tool calls by marker, registered by tests through POST /__stub/script. */
const scripts = new Map();
/** Message lists the model received, newest last; bounded so a long run cannot grow it. */
const received = [];
const MAX_RECEIVED = 500;

/** Decides the reply for a request. Extend here; keep every branch deterministic. */
export function plan(messages) {
  const list = messages ?? [];
  const lastUser = list.findLastIndex((m) => m?.role === 'user');
  const rounds = list.slice(lastUser + 1).filter((m) => m?.role === 'assistant' && m.tool_calls?.length).length;
  const text = lastUserText(list);
  for (const [match, steps] of scripts) {
    if (text.includes(match) && rounds < steps.length) return { toolCalls: steps[rounds] };
  }
  const last = list.at(-1);
  if (last?.role === 'tool') {
    const first = textOf(last.content).split('\n').find(Boolean) ?? '';
    return { words: `tool result: ${first.slice(0, 300)}`.split(/(?<= )/), intervalMs: 20 };
  }
  // Keep only the person's own last line: the gateway may prepend context to the user turn, and it
  // merges a stopped turn's unanswered message into the next one.
  const line = text.split('\n').filter(Boolean).at(-1) ?? '';
  if (/\bslow\b/i.test(line)) {
    return { words: Array.from({ length: SLOW_WORDS }, (_, i) => `slow-${i + 1}`), intervalMs: SLOW_INTERVAL_MS };
  }
  return { words: `stub reply: ${line}`.split(/(?<= )/), intervalMs: 20 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const id = () => `chatcmpl-stub-${Date.now().toString(36)}`;

function chunk(base, delta, finishReason = null) {
  return `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function toolCallList(calls, streamed = true) {
  return calls.map((call, index) => ({
    ...(streamed ? { index } : {}),
    id: `call_stub_${Date.now().toString(36)}_${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }));
}

async function stream(res, reply) {
  const base = { id: id(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(chunk(base, { role: 'assistant', content: '' }));
  if (reply.toolCalls) {
    res.write(chunk(base, { tool_calls: toolCallList(reply.toolCalls) }));
    res.write(chunk(base, {}, 'tool_calls'));
  } else {
    for (const word of reply.words) {
      if (closed) return;
      await sleep(reply.intervalMs);
      if (closed) return;
      res.write(chunk(base, { content: word }));
    }
    res.write(chunk(base, {}, 'stop'));
  }
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function complete(res, reply) {
  const message = reply.toolCalls
    ? { role: 'assistant', content: null, tool_calls: toolCallList(reply.toolCalls, false) }
    : { role: 'assistant', content: reply.words.join('') };
  json(res, 200, {
    id: id(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req, done) {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (part) => {
    raw += part;
  });
  req.on('end', () => {
    try {
      done(JSON.parse(raw));
    } catch {
      done(undefined);
    }
  });
}

const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/__stub/requests' && req.method === 'GET') {
    json(res, 200, { requests: received });
    return;
  }
  if (path === '/__stub/script' && req.method === 'POST') {
    readJson(req, (body) => {
      if (typeof body?.match !== 'string' || !body.match || !Array.isArray(body.steps) || !body.steps.every(Array.isArray)) {
        json(res, 400, { error: { message: 'match and steps are required' } });
        return;
      }
      scripts.set(body.match, body.steps);
      json(res, 200, { ok: true });
    });
    return;
  }
  if (req.method === 'GET' && path.endsWith('/models')) {
    json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'stub' }] });
    return;
  }
  if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
    json(res, 404, { error: { message: 'not found' } });
    return;
  }
  readJson(req, (body) => {
    if (!body) {
      json(res, 400, { error: { message: 'invalid json' } });
      return;
    }
    received.push(body.messages ?? []);
    if (received.length > MAX_RECEIVED) received.shift();
    const reply = plan(body.messages);
    if (body.stream) void stream(res, reply);
    else complete(res, reply);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub-llm listening on http://127.0.0.1:${PORT}/v1`);
});
