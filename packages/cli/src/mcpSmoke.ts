import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpSmokeResult {
  status: 'PASS' | 'FAIL';
  detail: string;
  tools: string[];
}

export async function runMcpSmoke(
  entry: string,
  projectPath: string,
  timeoutMs = 15_000,
): Promise<McpSmokeResult> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: projectPath,
    stderr: 'pipe',
    env: {
      ...process.env,
      AGENTBRIDGE_AGENT: 'claude',
      AGENTBRIDGE_PROJECT_PATH: projectPath,
      AGENTBRIDGE_TEST_MAX_LIFETIME_MS: '30000',
    } as Record<string, string>,
  });
  const client = new Client({ name: 'agentbridge-verify', version: '1.0.0' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(transport);
        return (await client.listTools()).tools
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === 'string');
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP SDK smoke test timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return tools.length === 11
      ? { status: 'PASS', detail: 'MCP SDK connect → initialize → tools/list completed.', tools }
      : { status: 'FAIL', detail: `MCP tools/list returned ${tools.length} tools; expected 11.`, tools };
  } catch (cause) {
    return {
      status: 'FAIL',
      detail: cause instanceof Error ? cause.message : String(cause),
      tools: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
