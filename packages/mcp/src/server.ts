import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Storage } from '@agentbridge/storage';
import type { CollaborationService } from '@agentbridge/collaboration';
import { DISCUSSION_MODES, TASK_TYPES, VALIDATION_MODES, type AgentType } from '@agentbridge/protocol';

export interface MCPServerOptions {
  agentType?: AgentType;
  /** Test-only lifecycle hook; production leaves this unset. */
  exitAfterToolCalls?: number;
}

export interface MCPRuntime {
  storage: Storage;
  collaboration: CollaborationService;
  projectPath?: string;
}

export type MCPRuntimeResolver = (
  requestedProjectPath: string | undefined,
  server: Server,
) => Promise<MCPRuntime>;

const text = z.string().trim().min(1).max(100_000);
const id = z.string().trim().min(1).max(256);

function opposite(agent: AgentType): AgentType {
  return agent === 'claude' ? 'codex' : 'claude';
}

function buildTools(agentType: AgentType): Tool[] {
  if (process.env.AGENTBRIDGE_PEER_INVOCATION === '1') return [];
  const peer = opposite(agentType);
  return [
    {
      name: 'ask_peer',
      description: 'Start a peer interaction. review performs one independent review; discussion and deep-discussion automatically alternate both providers and normally return after the discussion settles. Both providers must be configured. Use wait_discussion/watch_discussion only when explicit background dispatch returns nextAction=WAIT.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: { type: 'string', enum: [peer], description: 'The agent to discuss with' },
          message: { type: 'string', description: 'Proposal or question for the peer' },
          projectPath: { type: 'string', description: 'Project path; defaults to the current working directory' },
          mode: {
            type: 'string',
            enum: [...DISCUSSION_MODES],
            description: 'Depth contract: review is single-turn; discussion and deep-discussion are automatic alternating runs that converge on agreement or pause for user decision, with safety ceilings of 12 and 20 successful provider responses',
          },
          taskType: { type: 'string', enum: [...TASK_TYPES], description: 'Task category used for optional evidence validation (default: explain)' },
          validationMode: { type: 'string', enum: [...VALIDATION_MODES], description: 'Evidence gate: none (default) or evidence_required' },
          peerTemperature: { type: 'number', minimum: 0, maximum: 2, description: 'Optional connector temperature hint; retained even when a provider cannot apply it' },
          maxTurns: { type: 'integer', minimum: 1, maximum: 50, description: 'Safety ceiling for substantive provider responses; agreement confirmations do not consume it' },
          sessionPolicy: { type: 'string', enum: ['auto', 'reuse', 'fresh'], description: 'Provider session policy (default: auto)' },
        },
        required: ['peer', 'message'],
      },
    },
    {
      name: 'reply_peer',
      description: 'Continue a manual/review discussion, or provide the requested user decision after an automatic discussion pauses. Automatic runs reject concurrent replies while nextAction=WAIT.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID from ask_peer' },
          message: { type: 'string', description: 'Reply message' },
          mode: {
            type: 'string',
            enum: [...DISCUSSION_MODES],
            description: 'Optional monotonic depth upgrade: review → discussion → deep-discussion',
          },
        },
        required: ['discussionId', 'message'],
      },
    },
    {
      name: 'get_discussion',
      description: 'Retrieve discussion messages and the agreed decision, if one exists.',
      inputSchema: {
        type: 'object',
        properties: { discussionId: { type: 'string', description: 'Discussion ID' } },
        required: ['discussionId'],
      },
    },
    {
      name: 'wait_discussion',
      description: 'Wait for a queued/running discussion message. Automatic discussions may wake on intermediate messages; continue waiting while nextAction=WAIT.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Long-poll timeout in milliseconds (default: 30000)' },
          afterMessageId: { type: 'string', description: 'Wake when a newer message exists' },
        },
        required: ['discussionId'],
      },
    },
    {
      name: 'watch_discussion',
      description: 'Watch public peer runtime events with a cursor. Returns tool activity, output deltas, lifecycle changes, and permission requests without exposing private reasoning.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Long-poll timeout in milliseconds (default: 30000)' },
          afterSequence: { type: 'integer', minimum: 0, description: 'Return events after this per-discussion sequence' },
        },
        required: ['discussionId'],
      },
    },
    {
      name: 'list_discussions',
      description: 'List project discussions visible to this MCP process, including abnormal and completed states.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Optional project path filter' },
        },
      },
    },
    {
      name: 'close_discussion',
      description: 'Record this agent\'s acceptance and ask the peer to confirm. Confirmation may be queued asynchronously; inspect get_discussion for completion.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID' },
          conclusion: { type: 'string', description: 'Canonical conclusion to accept' },
        },
        required: ['discussionId', 'conclusion'],
      },
    },
    {
      name: 'cancel_discussion',
      description: 'Cancel an active discussion and release its local session leases.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID' },
        },
        required: ['discussionId'],
      },
    },
    {
      name: 'retry_discussion',
      description: 'Explicitly resume a discussion after a timeout, peer failure, or NEEDS_USER_DECISION state.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID' },
        },
        required: ['discussionId'],
      },
    },
    {
      name: 'list_permission_requests',
      description: 'List pending or resolved provider permission requests for a discussion.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID' },
          includeResolved: { type: 'boolean', description: 'Include already resolved requests' },
        },
        required: ['discussionId'],
      },
    },
    {
      name: 'resolve_permission',
      description: 'Approve or deny one provider action. Approve only when the action and scope are understood.',
      inputSchema: {
        type: 'object',
        properties: {
          permissionId: { type: 'string', description: 'Permission request ID' },
          decision: { type: 'string', enum: ['approve', 'deny'] },
        },
        required: ['permissionId', 'decision'],
      },
    },
  ];
}

export function createMCPServer(
  storage: Storage,
  collaboration: CollaborationService,
  options: MCPServerOptions = {},
) {
  return createServer(async () => ({ storage, collaboration }), options);
}

/** Create a server that binds to its project lazily after MCP initialization. */
export function createDynamicMCPServer(
  resolveRuntime: MCPRuntimeResolver,
  options: MCPServerOptions = {},
) {
  return createServer(resolveRuntime, options);
}

function createServer(resolveRuntime: MCPRuntimeResolver, options: MCPServerOptions) {
  const agentType = options.agentType ?? 'claude';
  let toolCallCount = 0;
  const schemas = {
    ask: z.object({
      peer: z.literal(opposite(agentType)),
      message: text,
      projectPath: z.string().trim().min(1).max(4096).optional(),
      mode: z.enum(DISCUSSION_MODES).optional(),
      taskType: z.enum(TASK_TYPES).optional(),
      validationMode: z.enum(VALIDATION_MODES).optional(),
      peerTemperature: z.number().min(0).max(2).optional(),
      maxTurns: z.number().int().min(1).max(50).optional(),
      sessionPolicy: z.enum(['auto', 'reuse', 'fresh']).optional(),
    }),
    reply: z.object({ discussionId: id, message: text, mode: z.enum(DISCUSSION_MODES).optional() }),
    get: z.object({ discussionId: id }),
    wait: z.object({
      discussionId: id,
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      afterMessageId: id.optional(),
    }),
    watch: z.object({
      discussionId: id,
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      afterSequence: z.number().int().min(0).optional(),
    }),
    list: z.object({ projectPath: z.string().trim().min(1).max(4096).optional() }),
    close: z.object({ discussionId: id, conclusion: text }),
    cancel: z.object({ discussionId: id }),
    retry: z.object({ discussionId: id }),
    listPermissions: z.object({ discussionId: id, includeResolved: z.boolean().optional() }),
    resolvePermission: z.object({ permissionId: id, decision: z.enum(['approve', 'deny']) }),
  };

  const server = new Server(
    { name: 'agentbridge', version: process.env.AGENTBRIDGE_VERSION ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildTools(agentType),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    toolCallCount += 1;
    if (options.exitAfterToolCalls && toolCallCount >= options.exitAfterToolCalls) {
      setTimeout(() => process.exit(0), 250);
    }

    try {
      switch (name) {
        case 'ask_peer': {
          if (process.env.AGENTBRIDGE_PEER_INVOCATION === '1') {
            throw new Error('Nested AgentBridge peer invocation is disabled');
          }
          const input = parse(schemas.ask, args);
          const runtime = await resolveRuntime(input.projectPath, server);
          const result = await runtime.collaboration.initiateDiscussion({
            driver: agentType,
            peer: input.peer,
            topic: input.message.slice(0, 100),
            initialMessage: input.message,
            projectPath: runtime.projectPath ?? input.projectPath,
            traceId: `tr_${randomUUID()}`,
            mode: input.mode,
            taskType: input.taskType,
            validationMode: input.validationMode,
            peerTemperature: input.peerTemperature,
            maxTurns: input.maxTurns,
            sessionPolicy: input.sessionPolicy,
          });
          return ok(result);
        }
        case 'reply_peer': {
          const input = parse(schemas.reply, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.replyToDiscussion({
            discussionId: input.discussionId,
            reply: input.message,
            sender: agentType,
            mode: input.mode,
          }));
        }
        case 'get_discussion': {
          const input = parse(schemas.get, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.getDiscussion(input.discussionId));
        }
        case 'wait_discussion': {
          const input = parse(schemas.wait, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.waitForDiscussion(
            input.discussionId,
            input.timeoutMs,
            input.afterMessageId,
          ));
        }
        case 'watch_discussion': {
          const input = parse(schemas.watch, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.watchDiscussion(
            input.discussionId,
            input.timeoutMs,
            input.afterSequence,
          ));
        }
        case 'list_discussions': {
          const input = parse(schemas.list, args);
          const runtime = await resolveRuntime(input.projectPath, server);
          return ok({ discussions: runtime.storage.listDiscussions(runtime.projectPath ?? input.projectPath) });
        }
        case 'close_discussion': {
          const input = parse(schemas.close, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.closeDiscussion({
            discussionId: input.discussionId,
            conclusion: input.conclusion,
            agent: agentType,
          }));
        }
        case 'cancel_discussion': {
          const input = parse(schemas.cancel, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.cancelDiscussion({
            discussionId: input.discussionId,
            agent: agentType,
          }));
        }
        case 'retry_discussion': {
          const input = parse(schemas.retry, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.retryDiscussion({
            discussionId: input.discussionId,
            agent: agentType,
          }));
        }
        case 'list_permission_requests': {
          const input = parse(schemas.listPermissions, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(runtime.collaboration.listPermissionRequests(input.discussionId, input.includeResolved));
        }
        case 'resolve_permission': {
          const input = parse(schemas.resolvePermission, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.resolvePermission({
            permissionId: input.permissionId,
            decision: input.decision,
            agent: agentType,
          }));
        }
        default:
          return error(`Unknown tool: ${name}`);
      }
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  });

  return server;
}

export async function runServer(
  storage: Storage,
  collaboration: CollaborationService,
  options: MCPServerOptions = {},
) {
  const server = createMCPServer(storage, collaboration, options);
  await server.connect(new StdioServerTransport());
}

export async function runDynamicServer(
  resolveRuntime: MCPRuntimeResolver,
  options: MCPServerOptions = {},
) {
  const server = createDynamicMCPServer(resolveRuntime, options);
  await server.connect(new StdioServerTransport());
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid tool input: ${result.error.message}`);
  return result.data;
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}
