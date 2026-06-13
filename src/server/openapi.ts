/** A minimal OpenAPI 3 description of the orchestrator's HTTP API. */
export const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'AetherMux Orchestrator API',
    version: '0.1.0',
    description: 'Phase 1 single-process orchestrator: create sessions, inspect state.',
  },
  paths: {
    '/healthz': {
      get: {
        summary: 'Liveness probe',
        responses: { '200': { description: 'Service is up' } },
      },
    },
    '/sessions': {
      get: {
        summary: 'List active sessions',
        responses: { '200': { description: 'Active sessions' } },
      },
      post: {
        summary: 'Create a session (provision sandbox, spawn agent, persist state)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['command'],
                properties: {
                  repoPath: { type: 'string', nullable: true },
                  command: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  env: { type: 'object', additionalProperties: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Session created' },
          '400': { description: 'Invalid request body' },
        },
      },
    },
    '/sessions/{id}': {
      get: {
        summary: 'Get a session graph',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Session graph' }, '404': { description: 'Not found' } },
      },
      delete: {
        summary: 'Destroy a session and its sandboxes',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Destroyed' }, '404': { description: 'Not found' } },
      },
    },
  },
} as const;
