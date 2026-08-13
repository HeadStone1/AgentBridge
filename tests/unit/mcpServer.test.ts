import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer } from '../../packages/mcp/src/server';
import { Storage } from '../../packages/storage/src/index';
import { AuditService } from '../../packages/audit/src/index';
import { CollaborationService } from '../../packages/collaboration/src/index';

describe('AgentBridge MCP server', () => {
  it.each([
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const)('supports %s client tool calls to %s', async (agentType, peer) => {
    const storage = new Storage(':memory:');
    const collaboration = new CollaborationService(storage, new AuditService(storage));
    const server = createMCPServer(storage, collaboration, { agentType });
    const client = new Client({ name: `${agentType}-test-client`, version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    const askTool = tools.tools.find((tool) => tool.name === 'ask_peer');
    expect(tools.tools).toHaveLength(8);
    expect(tools.tools.some((tool) => tool.name === 'wait_discussion')).toBe(true);
    expect(askTool?.inputSchema.properties?.peer).toEqual({
      type: 'string',
      enum: [peer],
      description: 'The agent to discuss with',
    });
    expect(askTool?.inputSchema.properties?.mode).toMatchObject({
      type: 'string',
      enum: ['review', 'discussion', 'deep-discussion'],
    });

    const result = await client.callTool({
      name: 'ask_peer',
      arguments: { peer, message: `hello from ${agentType}`, mode: 'review' },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}')).toMatchObject({
      peer,
      mode: 'review',
      maxTurns: 3,
      status: 'DISCUSSING',
    });

    const discussion = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}');
    const waited = await client.callTool({
      name: 'wait_discussion',
      arguments: { discussionId: discussion.discussionId, timeoutMs: 1_000 },
    });
    expect(waited.isError).not.toBe(true);
    expect(JSON.parse(waited.content[0].type === 'text' ? waited.content[0].text : '{}')).toMatchObject({
      waitTimedOut: false,
    });

    await client.close();
    await server.close();
    storage.close();
  });
});
