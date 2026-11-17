/** 仅供隔离 PoC 使用的无副作用 MCP 服务。 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'nacos-poc', version: '1.0.0' });
server.registerTool('lookup', { description: '返回固定的只读测试事实', inputSchema: { key: z.string() } },
  /** 返回测试输入，避免依赖实际业务数据。 */
  async ({ key }) => ({ content: [{ type: 'text', text: `fixture:${key}` }] }));
await server.connect(new StdioServerTransport());
