/** 原生步骤间只传版本引用；调用期上下文使用ALS隔离并行Run和团队成员。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { FrozenResources } from './contracts.js';
export interface ResourceScope { binding: FrozenResources; storage: MastraCompositeStore }
const local = new AsyncLocalStorage<ResourceScope>();
/** 读取当前执行段绑定；独立节点评测不属于正式产研主链。 */
export function currentResources() { return local.getStore(); }
/** 绑定整个异步执行段，包括原生并行、委派与工具调用。 */
export function withResources<T>(scope: ResourceScope, execute: () => Promise<T>) { return local.run(scope, execute); }
