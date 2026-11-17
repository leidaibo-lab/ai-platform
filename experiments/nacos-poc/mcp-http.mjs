/** 验证固定版本 Mastra MCP 客户端与本机 Streamable HTTP 服务通信。 */
import assert from 'node:assert/strict';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCPClient } from '@mastra/mcp';
import { z } from 'zod';

const app = createMcpExpressApp({ host: '127.0.0.1' });
/** 为每次 HTTP 请求构造隔离的无状态测试服务。 */
app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('lookup', { description: '固定只读测试事实', inputSchema: { key: z.string() } },
    /** 返回合成结果。 */
    async ({ key }) => ({ content: [{ type: 'text', text: `fixture:${key}` }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  /** 结束时释放服务端资源。 */
  res.on('close', () => { void transport.close(); void server.close(); });
});
const listener = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
const client = new MCPClient({ id: 'nacos-http-poc', servers: { fixture: { url: new URL(`http://127.0.0.1:${listener.address().port}/mcp`) } } });
try {
  const tools = await client.listTools();
  assert.ok(tools.fixture_lookup);
  const result = await tools.fixture_lookup.execute({ key: 'http' }, {});
  assert.match(JSON.stringify(result), /fixture:http/);
  console.log('PASS: Streamable HTTP 工具发现与调用');
} finally {
  await client.disconnect();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}
