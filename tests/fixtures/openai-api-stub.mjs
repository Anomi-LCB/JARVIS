import { createServer } from 'node:http';

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const content = JSON.stringify({
        method: request.method,
        authorization: request.headers.authorization ?? null,
        model: payload.model ?? null,
        prompt: payload.messages?.[0]?.content ?? null,
        reasoningEffort: payload.reasoning_effort ?? null,
        responseFormat: payload.response_format?.type ?? null
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }), () => server.close());
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }), () => server.close());
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});

server.on('close', () => process.exit(0));
