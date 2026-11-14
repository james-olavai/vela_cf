#!/usr/bin/env node
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 8787);
const HOST = process.env.MOCK_LLM_HOST || '127.0.0.1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'vela-mock-llm-gateway' }));
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (tools.length > 0 && !hasToolResult && !body.stream) {
      const firstTool = tools[0]?.function?.name || 'natalWheel';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock_tool_1',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_mock_1',
                    type: 'function',
                    function: {
                      name: firstTool,
                      arguments: JSON.stringify({
                        birthDateTime: '1994-06-03T08:20',
                        latitude: 31.2304,
                        longitude: 121.4737,
                        timezone: 'Asia/Shanghai',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 45, total_tokens: 1245 },
        }),
      );
      return;
    }

    const replyText =
      '根据 **西洋本命盘** 排盘结果，你的核心配置清晰稳定，建议结合当下节奏循序推进。\n\nSUGGESTIONS:这个相位如何影响近期合作？|接下来三个月需要注意什么？';

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      const chunks = replyText.match(/.{1,16}/gs) ?? [replyText];
      for (const delta of chunks) {
        res.write(
          `data: ${JSON.stringify({
            id: 'mock_stream_1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: delta } }],
          })}\n\n`,
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'mock_stream_1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3200, completion_tokens: 180, total_tokens: 3380 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock_chat_1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: replyText },
          },
        ],
        usage: { prompt_tokens: 3200, completion_tokens: 180, total_tokens: 3380 },
      }),
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-llm-gateway] listening on http://${HOST}:${PORT}`);
});
