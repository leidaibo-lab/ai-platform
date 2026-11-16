/** Mastra 原生只读 API：目录/预览/下载不修改流程与审批。 */
import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';
import { assetIdSchema } from './asset-identity.js';
import { readAssetCatalog, readCatalogFile, type AssetCatalog } from './asset-catalog.js';

const filterSchema = z.object({ projectId: z.literal('hrm').optional(), iterationId: assetIdSchema.optional(), runId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(), stage: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional() });
const fileSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/), download: z.enum(['1']).optional() });

/** 用同一筛选规则导出清单及交付包；缺少关联的旧版本不属于任何迭代。 */
function filteredCatalog(directory: string, query: unknown): AssetCatalog {
  const filter = filterSchema.parse(query);
  const catalog = readAssetCatalog(directory);
  return { ...catalog, runs: catalog.runs.filter(
    // Run 列表保持初始化关联，即使尚无阶段产物仍可看见。
    (run) => (!filter.iterationId || run.correlation.iterationId === filter.iterationId) && (!filter.runId || run.correlation.runId === filter.runId),
  ), assets: catalog.assets.filter(
    // 阶段与 Run 可以独立筛选，迭代只匹配显式关联。
    (asset) => (!filter.iterationId || asset.manifest.correlation?.iterationId === filter.iterationId) && (!filter.runId || asset.manifest.runId === filter.runId) && (!filter.stage || asset.manifest.stage === filter.stage),
  ) };
}

/** 只在显式绑定业务仓库的 Studio 注册；不增加 CLI 的业务写入。 */
export function createAssetRoutes(config: PracticeConfig) {
  const directory = config.hrmRepositoryRoot;
  if (!directory) return [];
  /** 所有错误避免透出绝对路径、模型配置和异常栈。 */
  function failure(c: ContextWithMastra, error: unknown) {
    if (error instanceof z.ZodError) return c.json({ error: '筛选或文件参数格式无效' }, 400);
    return c.json({ error: '资产读取失败，请检查仓库清单、Run 关联及文件完整性。' }, 409);
  }
  return [
    registerApiRoute('/delivery-assets', { method: 'GET',
      // 页面随本实践发布，正文在浏览器中仅按文本展示。
      handler: async (c) => {
        c.header('Cache-Control', 'no-store');
        c.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        return c.html(readFileSync(join(config.rootDir, 'src/delivery/asset-browser.html'), 'utf8'));
      },
    }),
    registerApiRoute('/delivery-assets/catalog', { method: 'GET',
      // 目录是按需重建的投影，原生 Store 状态不在此接口复制。
      handler: async (c) => {
        c.header('Cache-Control', 'no-store');
        try { return c.json(filteredCatalog(directory, c.req.query())); }
        catch (error) { return failure(c, error); }
      },
    }),
    registerApiRoute('/delivery-assets/file', { method: 'GET',
      // 文件必须由产物 ID 和清单文件名共同定位，读取后校验 SHA256。
      handler: async (c) => {
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        try {
          const query = fileSchema.parse(c.req.query());
          const asset = readAssetCatalog(directory).assets.find(
            // ID 来自清单相对路径的散列，客户端不能指定磁盘路径。
            (entry) => entry.id === query.id,
          );
          if (!asset || !Object.hasOwn(asset.manifest.files, query.name)) return c.json({ error: '产物或文件不存在' }, 404);
          const content = readCatalogFile(directory, asset, query.name);
          if (query.download) c.header('Content-Disposition', `attachment; filename="${query.name}"`);
          return c.body(content, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
        } catch (error) { return failure(c, error); }
      },
    }),
    registerApiRoute('/delivery-assets/bundle', { method: 'GET',
      // JSON 包连同 manifest 保存每个历史版本，不能被当作批准或可部署制品。
      handler: async (c) => {
        c.header('Cache-Control', 'no-store');
        try {
          const catalog = filteredCatalog(directory, c.req.query());
          let bytes = 0;
          const artifacts = [];
          for (const asset of catalog.assets) {
            const files: Record<string, string> = {};
            for (const name of Object.keys(asset.manifest.files)) {
              const content = readCatalogFile(directory, asset, name);
              bytes += Buffer.byteLength(content);
              if (bytes > 64 * 1024 * 1024) return c.json({ error: '交付包超过 64MiB，请缩小到迭代、Run 或阶段后下载' }, 413);
              files[name] = content;
            }
            artifacts.push({ ...asset, files });
          }
          c.header('Content-Disposition', 'attachment; filename="hrm-delivery-assets.json"');
          return c.json({ ...catalog, assets: artifacts });
        } catch (error) { return failure(c, error); }
      },
    }),
  ];
}
