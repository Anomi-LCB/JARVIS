export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

export function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

export function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function routePath(request) {
  return new URL(request.url, 'http://127.0.0.1').pathname;
}

export function routeParams(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

export async function safeHandle(response, handler) {
  try {
    await handler();
  } catch (error) {
    sendJson(response, 500, {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message
      }
    });
  }
}
