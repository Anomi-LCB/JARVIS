export function createRouteContract(method, path, summary, {
  public: isPublic = true,
  requestSchema = 'GenericRequest',
  responseSchema = 'JsonEnvelope',
  tags = []
} = {}) {
  return {
    method: method.toUpperCase(),
    path,
    summary,
    public: isPublic,
    requestSchema,
    responseSchema,
    tags
  };
}

export function createOpenApiSpecFromRouteContracts({
  title,
  version = '1.0.0',
  moduleId,
  routes = [],
  schemas = {}
}) {
  const paths = {};
  for (const route of routes) {
    const openApiPath = normalizePath(route.path);
    const method = route.method.toLowerCase();
    paths[openApiPath] ??= {};
    paths[openApiPath][method] = {
      summary: route.summary,
      operationId: operationIdFor(route),
      tags: route.tags?.length ? route.tags : [moduleId],
      parameters: pathParameters(openApiPath),
      responses: {
        200: {
          description: route.responseSchema,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${route.responseSchema ?? 'JsonEnvelope'}` }
            }
          }
        }
      },
      security: route.public ? [] : [{ bearerAuth: [] }]
    };
    if (route.method !== 'GET') {
      paths[openApiPath][method].requestBody = {
        required: false,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${route.requestSchema ?? 'GenericRequest'}` }
          }
        }
      };
    }
    if (paths[openApiPath][method].parameters.length === 0) {
      delete paths[openApiPath][method].parameters;
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
      'x-module-id': moduleId
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' }
      },
      schemas: {
        GenericRequest: {
          type: 'object',
          additionalProperties: true
        },
        JsonEnvelope: {
          type: 'object',
          additionalProperties: true
        },
        SuccessEnvelope: {
          type: 'object',
          additionalProperties: true
        },
        ...schemas
      }
    }
  };
}

function normalizePath(path) {
  return String(path).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParameters(path) {
  return [...String(path).matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' }
  }));
}

function operationIdFor(route) {
  const normalizedPath = normalizePath(route.path)
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, ' '))
    .flatMap((part) => part.split(/\s+/).filter(Boolean))
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
  return `${route.method.toLowerCase()}${normalizedPath || 'Root'}`;
}
