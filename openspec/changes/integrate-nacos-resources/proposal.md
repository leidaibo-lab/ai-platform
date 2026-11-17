## Why

主线资源在进程启动时静态装配，无法安全地按 Run 使用集中发布的 Prompt 和 Skill。需要在保持 Mastra Store 事实归属和旧 Run 兼容的前提下引入资源读取。

## What Changes

- 为新 Run 定义经授权资源的版本解析、内容冻结与恢复规则。
- 引入可关闭的 Nacos Prompt 和 Skill 资源适配；资源内容不授予执行权限。
- MCP、A2A 和远程 Agent 协作不在本次范围。

## Capabilities

### Modified Capabilities

- `mastra-role-resources`：增加资源冻结、恢复和只读工具授权边界。

## Impact

影响主流程初始化、Agent 装配、资源契约、服务端配置和验证。旧 Run 不自动获得冻结事实。实现依赖接口及恢复验证，当前尚未启用。
