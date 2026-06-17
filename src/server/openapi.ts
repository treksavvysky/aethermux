/**
 * OpenAPI 3 description of the orchestrator's session-management HTTP API. The
 * authoritative TypeScript shapes live in `api-types.ts` (imported by the
 * frontend); this spec mirrors them for tooling/docs.
 */
export const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'AetherMux Orchestrator API',
    version: '0.2.0',
    description:
      'Single-process orchestrator: create / list / terminate agent sessions. ' +
      'All routes except /healthz require the shared bearer token (fail-closed). ' +
      'All errors are { error: string }.',
  },
  components: {
    securitySchemes: {
      bearerToken: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      AttentionState: {
        type: 'string',
        enum: ['running', 'awaiting-input', 'exited', 'error'],
        description: 'Ring state derived from real agent lifecycle (never heuristics).',
      },
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      CreateSessionRequest: {
        type: 'object',
        required: ['command'],
        properties: {
          repoPath: { type: 'string', nullable: true },
          command: { type: 'array', items: { type: 'string' }, minItems: 1 },
          env: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      SessionSummary: {
        type: 'object',
        required: ['sessionId', 'agentId', 'status', 'attentionState', 'createdAt', 'repoPath'],
        properties: {
          sessionId: { type: 'string' },
          agentId: { type: 'string', nullable: true },
          status: { type: 'string' },
          attentionState: { $ref: '#/components/schemas/AttentionState' },
          createdAt: { type: 'string', format: 'date-time' },
          repoPath: { type: 'string', nullable: true },
        },
      },
      TerminateResponse: {
        type: 'object',
        required: ['terminated', 'sessionId'],
        properties: {
          terminated: { type: 'boolean', enum: [true] },
          sessionId: { type: 'string' },
        },
      },
    },
  },
  security: [{ bearerToken: [] }],
  paths: {
    '/healthz': {
      get: {
        summary: 'Liveness probe (unauthenticated)',
        security: [],
        responses: { '200': { description: 'Service is up' } },
      },
    },
    '/sessions': {
      get: {
        summary: 'List active sessions with attention state',
        responses: {
          '200': {
            description: 'Active sessions',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/SessionSummary' } },
              },
            },
          },
          '401': { description: 'Unauthorized', content: errorContent() },
        },
      },
      post: {
        summary: 'Create a session (provision sandbox, spawn agent, persist state)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSessionRequest' } } },
        },
        responses: {
          '201': {
            description: 'Session created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionSummary' } } },
          },
          '400': { description: 'Invalid request body', content: errorContent() },
          '401': { description: 'Unauthorized', content: errorContent() },
        },
      },
    },
    '/sessions/{id}': {
      get: {
        summary: 'Get a session graph (session + sandboxes + agents)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Session graph' },
          '404': { description: 'Not found', content: errorContent() },
        },
      },
      delete: {
        summary: 'Terminate a session (SIGTERM → SIGKILL after timeout) and remove it',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Terminated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TerminateResponse' } } },
          },
          '404': { description: 'Not found', content: errorContent() },
        },
      },
    },
  },
} as const;

function errorContent() {
  return { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };
}
