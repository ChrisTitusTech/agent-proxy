#!/usr/bin/env node

const webuiBase = process.env.OPEN_WEBUI_BASE_URL?.replace(/\/$/, '');
const proxyBase = process.env.AGENT_PROXY_BASE_URL?.replace(/\/$/, '');
const adminToken = process.env.AGENT_PROXY_ADMIN_TOKEN;
const allowBoundedDetach = process.env.OPEN_WEBUI_ALLOW_BOUNDED_DETACH === 'true';
const selectedCases = new Set((process.env.OPEN_WEBUI_CASES ?? '').split(',').filter(Boolean));
const aliases = (process.env.OPEN_WEBUI_MODELS ?? 'gpt-5.6-sol,grok-build')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!webuiBase || !proxyBase || selectedCases.size === 0) {
  throw new Error('OPEN_WEBUI_BASE_URL, AGENT_PROXY_BASE_URL, and OPEN_WEBUI_CASES are required.');
}

const knownCases = new Set([
  'discovery',
  'nonstream',
  'stream',
  'isolation',
  'tools',
  'cancel',
  'accounting',
]);
for (const requestedCase of selectedCases) {
  if (!knownCases.has(requestedCase)) {
    throw new Error(`Unknown OPEN_WEBUI_CASES entry: ${requestedCase}`);
  }
}

async function jsonRequest(path, init = {}, timeoutMs = 30_000) {
  const controller = init.signal ? null : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response;
  try {
    response = await fetch(`${webuiBase}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error(`${path} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${body.detail ?? body.error?.message ?? 'request failed'}`);
  }
  return body;
}

const unique = `${Date.now()}-${process.pid}`;
const auth = await jsonRequest('/api/v1/auths/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Phase 3 compatibility',
    email: `phase3-${unique}@example.invalid`,
    password: `Phase3-${unique}-local-only`,
  }),
});
if (typeof auth.token !== 'string' || auth.token.length === 0) {
  throw new Error('Open WebUI signup did not return a local session token.');
}
const headers = {
  authorization: `Bearer ${auth.token}`,
  'content-type': 'application/json',
};

async function connectBrowserSocket() {
  const socketUrl = `${webuiBase.replace(/^http/, 'ws')}/ws/socket.io/?EIO=4&transport=websocket`;
  const socket = new WebSocket(socketUrl);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Open WebUI browser socket connection timed out.'));
    }, 10_000);

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Open WebUI browser socket connection failed.'));
    }, { once: true });

    socket.addEventListener('message', (event) => {
      const message = String(event.data);
      if (message.startsWith('0')) {
        socket.send(`40${JSON.stringify({ token: auth.token })}`);
        return;
      }
      if (message === '2') {
        socket.send('3');
        return;
      }
      if (message.startsWith('40')) {
        clearTimeout(timeout);
        const payload = message.length > 2 ? JSON.parse(message.slice(2)) : {};
        if (typeof payload.sid !== 'string' || payload.sid.length === 0) {
          socket.close();
          reject(new Error('Open WebUI browser socket did not return a session ID.'));
          return;
        }
        resolve({ socket, sessionId: payload.sid });
      }
    });
  });
}

async function chat(model, marker, extra = {}) {
  return jsonRequest('/openai/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `Reply with exactly ${marker}.` }],
      stream: false,
      ...extra,
    }),
  });
}

function responseText(body) {
  return body.choices?.[0]?.message?.content ?? '';
}

async function proxyRequestCount() {
  if (!adminToken) {
    throw new Error('AGENT_PROXY_ADMIN_TOKEN is required for the accounting check.');
  }
  const response = await fetch(`${proxyBase}/admin/dashboard?days=1`, {
    headers: { 'x-admin-token': adminToken },
  });
  const body = await response.json();
  if (!response.ok || typeof body.overview?.totalRequests !== 'number') {
    throw new Error('agent-proxy accounting could not be read.');
  }
  return body.overview.totalRequests;
}

async function waitForProxyIdle(timeoutMs = 200_000) {
  if (!adminToken) {
    throw new Error('AGENT_PROXY_ADMIN_TOKEN is required to inspect active requests.');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${proxyBase}/admin/active-requests`, {
      headers: { 'x-admin-token': adminToken },
    });
    const body = await response.json();
    if (!response.ok || typeof body.count !== 'number') {
      throw new Error('agent-proxy active request state could not be read.');
    }
    if (body.count === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('agent-proxy did not become idle before the compatibility assertion.');
}

if (selectedCases.has('discovery')) {
  const models = await jsonRequest('/api/models', { headers });
  const ids = new Set((models.data ?? []).map((model) => model.id));
  for (const alias of aliases) {
    if (!ids.has(alias)) throw new Error(`Open WebUI did not discover model alias ${alias}.`);
  }
  console.log(`PASS discovery (${aliases.join(', ')})`);
}

if (selectedCases.has('nonstream')) {
  for (const [index, model] of aliases.entries()) {
    const marker = `OPENWEBUI_NONSTREAM_${index}_OK`;
    const result = await chat(model, marker);
    if (!responseText(result).includes(marker)) {
      throw new Error(
        `Non-streaming response from ${model} did not contain the marker: ${
          JSON.stringify(result).slice(0, 160)
        }`,
      );
    }
  }
  console.log('PASS nonstream');
}

if (selectedCases.has('stream')) {
  const marker = 'OPENWEBUI_STREAM_OK';
  const response = await fetch(`${webuiBase}/openai/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: aliases[0],
      messages: [{ role: 'user', content: `Reply with exactly ${marker}.` }],
      stream: true,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Streaming request returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  const dataEvents = text.split('\n').filter((line) => line.startsWith('data: '));
  if (dataEvents.length < 2 || !text.includes(marker) || !text.includes('[DONE]')) {
    throw new Error('Open WebUI did not relay a complete incremental SSE response.');
  }
  console.log('PASS stream');
}

if (selectedCases.has('isolation')) {
  const [alpha, beta] = await Promise.all([
    chat(aliases[0], 'OPENWEBUI_ISOLATION_ALPHA'),
    chat(aliases[0], 'OPENWEBUI_ISOLATION_BETA'),
  ]);
  const alphaText = responseText(alpha);
  const betaText = responseText(beta);
  if (
    !alphaText.includes('OPENWEBUI_ISOLATION_ALPHA')
    || alphaText.includes('OPENWEBUI_ISOLATION_BETA')
    || !betaText.includes('OPENWEBUI_ISOLATION_BETA')
    || betaText.includes('OPENWEBUI_ISOLATION_ALPHA')
  ) {
    throw new Error('Concurrent Open WebUI chats were not isolated.');
  }
  console.log('PASS isolation');
}

if (selectedCases.has('tools')) {
  const first = await chat(aliases[0], 'unused', {
    messages: [{
      role: 'user',
      content: 'Call the phase3_marker tool once with value OPENWEBUI_TOOL_OK. Do not answer directly.',
    }],
    tools: [{
      type: 'function',
      function: {
        name: 'phase3_marker',
        description: 'Returns the supplied compatibility marker.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'phase3_marker' } },
  });
  const toolCall = first.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.name !== 'phase3_marker' || typeof toolCall.id !== 'string') {
    throw new Error('Open WebUI did not relay the expected function call.');
  }
  const second = await jsonRequest('/openai/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: aliases[0],
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'Call the phase3_marker tool and then report its result.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
        },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'OPENWEBUI_TOOL_RESULT_OK',
        },
      ],
    }),
  });
  if (!responseText(second).includes('OPENWEBUI_TOOL_RESULT_OK')) {
    throw new Error(
      `Open WebUI tool-result round trip did not complete: ${JSON.stringify(second).slice(0, 160)}`,
    );
  }
  console.log('PASS tools');
}

if (selectedCases.has('cancel')) {
  if (!adminToken) {
    throw new Error('AGENT_PROXY_ADMIN_TOKEN is required for the cancellation check.');
  }
  const browser = await connectBrowserSocket();
  let cancellationMode = 'provider terminated';
  const userMessageId = `phase3-user-${unique}`;
  const assistantMessageId = `phase3-assistant-${unique}`;
  try {
    const started = await jsonRequest('/api/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: aliases[0],
        session_id: browser.sessionId,
        parent_id: null,
        id: assistantMessageId,
        user_message: {
          id: userMessageId,
          parentId: null,
          childrenIds: [assistantMessageId],
          role: 'user',
          content: 'Produce a detailed response for at least thirty seconds for a cancellation test.',
        },
        messages: [{
          role: 'user',
          content: 'Produce a detailed response for at least thirty seconds for a cancellation test.',
        }],
        stream: true,
        params: {},
        features: {},
        variables: {},
        background_tasks: {
          title_generation: false,
          tags_generation: false,
          follow_up_generation: false,
        },
      }),
    });
    const taskId = started.task_ids?.[0] ?? started.task_id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new Error('Open WebUI did not create a cancellable browser chat task.');
    }

    let activeCount = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const active = await fetch(`${proxyBase}/admin/active-requests`, {
        headers: { 'x-admin-token': adminToken },
      });
      const state = await active.json();
      if (!active.ok || typeof state.count !== 'number') {
        throw new Error('agent-proxy active request state could not be read.');
      }
      activeCount = state.count;
      if (activeCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (activeCount === 0) {
      throw new Error('Open WebUI browser chat did not start provider work.');
    }

    const stopped = await jsonRequest(`/api/tasks/stop/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      headers,
    });
    if (stopped.status !== true) {
      throw new Error('Open WebUI did not accept browser chat cancellation.');
    }

    activeCount = -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const active = await fetch(`${proxyBase}/admin/active-requests`, {
        headers: { 'x-admin-token': adminToken },
      });
      const state = await active.json();
      if (!active.ok || typeof state.count !== 'number') {
        throw new Error('agent-proxy active request state could not be read.');
      }
      activeCount = state.count;
      if (activeCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (activeCount !== 0) {
      if (!allowBoundedDetach) {
        throw new Error('Cancelled Open WebUI request left provider work active.');
      }
      cancellationMode = 'UI task detached; provider remains bounded by agent-proxy timeout';
    }
  } finally {
    browser.socket.close();
  }
  console.log(`PASS cancel (${cancellationMode})`);
}

if (selectedCases.has('accounting')) {
  await waitForProxyIdle();
  const before = await proxyRequestCount();
  const marker = 'OPENWEBUI_ACCOUNTING_OK';
  const result = await chat(aliases[0], marker);
  if (!responseText(result).includes(marker)) {
    throw new Error('Accounting fixture chat did not complete.');
  }
  await waitForProxyIdle();
  let after = before;
  for (let attempt = 0; attempt < 20 && after === before; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await proxyRequestCount();
  }
  if (after !== before + 1) {
    throw new Error(`One Open WebUI chat produced ${after - before} accounted proxy requests.`);
  }
  console.log('PASS accounting (one chat, one provider request)');
}
