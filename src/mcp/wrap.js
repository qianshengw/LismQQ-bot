// 把 MCP stdio server 的工具包装成 pi-agent-core 的 AgentTool（参照 pi-mcp README 的官方包装代码）。
import { McpClient, StdioTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { Type } from '@earendil-works/pi-ai';

/**
 * 启动一个 stdio MCP server 并返回包装后的 AgentTool 列表 + client 句柄。
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} [options.args]
 * @param {Record<string, string>} [options.env]
 * @param {string} [options.name] - MCP client 名
 * @param {number} [options.requestTimeoutMs] - 单请求超时（长轮询工具要调大）
 * @returns {Promise<{client: McpClient, tools: AgentTool[], close: () => Promise<void>}>}
 */
export async function connectMcpTools({
  command,
  args = [],
  env = {},
  name = 'qq-bridge-mcp',
  requestTimeoutMs = 30000,
}) {
  const transport = new StdioTransport({ command, args, env });
  const client = new McpClient({ name, version: '0.1.0', requestTimeoutMs });
  await client.connect(transport);

  const mcpTools = await client.listTools();
  const tools = mcpTools.map((tool) => ({
    // provider 只允许 [A-Za-z0-9_-] 最长 64
    name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
    label: tool.name,
    description: tool.description ?? tool.name,
    // providers 要求 object schema 且有 properties
    parameters: Type.Unsafe({ ...tool.inputSchema, type: 'object', properties: tool.inputSchema?.properties ?? {} }),
    execute: async (_toolCallId, params, signal) => {
      const result = await client.callTool(tool.name, params, { signal, timeoutMs: requestTimeoutMs });
      return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
    },
  }));

  return {
    client,
    tools,
    close: () => client.close(),
  };
}
