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
import type { AgentType } from '@agentbridge/protocol';

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
  const peer = opposite(agentType);
  return [
    {
      name: 'ask_peer',
      description: 'Start a discussion with the other coding agent. A configured connector dispatches the request and returns a peer response.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: { type: 'string', enum: [peer], description: 'The agent to discuss with' },
          message: { type: 'string', description: 'Proposal or question for the peer' },
          projectPath: { type: 'string', description: 'Project path; defaults to the current working directory' },
        },
        required: ['peer', 'message'],
      },
    },
    {
      name: 'reply_peer',
      description: 'Continue an existing discussion and optionally dispatch the reply to the other agent.',
      inputSchema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string', description: 'Discussion ID from ask_peer' },
          message: { type: 'string', description: 'Reply message' },
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
      description: 'Record this agent\'s acceptance and ask the peer to confirm. The discussion completes only after both agents accept the same conclusion.',
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
    }),
    reply: z.object({ discussionId: id, message: text }),
    get: z.object({ discussionId: id }),
    list: z.object({ projectPath: z.string().trim().min(1).max(4096).optional() }),
    close: z.object({ discussionId: id, conclusion: text }),
    cancel: z.object({ discussionId: id }),
    retry: z.object({ discussionId: id }),
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
          }));
        }
        case 'get_discussion': {
          const input = parse(schemas.get, args);
          const runtime = await resolveRuntime(undefined, server);
          return ok(await runtime.collaboration.getDiscussion(input.discussionId));
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
