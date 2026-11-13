/** 宿主签名清单验证器；信任根来自部署配置，不接受Run传入公钥。 */
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PracticeConfig } from '../mastra/config.js';
import { bytesHash, canonical, resourceHash, ResourceError } from './contracts.js';

export const artifactManifestSchema = z.object({ version: z.literal('role-artifact.v1'), node: z.string(), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

/** 收集完整宿主执行树；不读取.env/运行数据/业务候选，拒绝执行树中的外部链接。 */
export function captureArtifact(root: string, dependencies: boolean): ArtifactManifest {
  const files: Record<string, string> = {};
  /** 固定根内递归普通文件；.bin仅是包管理器入口链接，不由宿主角色调用。 */
  function walk(path: string) {
    const absolute = resolve(root, path); const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new ResourceError('ARTIFACT_SYMLINK');
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) if (name !== '.bin') walk(`${path}/${name}`);
    } else if (stat.isFile()) files[path] = bytesHash(readFileSync(absolute));
    else throw new ResourceError('ARTIFACT_FILE');
  }
  for (const path of ['src', 'package.json', 'package-lock.json', ...(dependencies ? ['node_modules'] : [])]) {
    if (!existsSync(resolve(root, path))) throw new ResourceError('ARTIFACT_MISSING');
    walk(path);
  }
  if (existsSync(resolve(root, '.mastra/output'))) walk('.mastra/output');
  if (existsSync(resolve(root, 'config/material-policy.ts'))) walk('config/material-policy.ts');
  return { version: 'role-artifact.v1', node: process.version, files };
}

/** 每次执行段重新检查字节；live没有可信签名绝不降级为fixture散列。 */
export function verifyArtifact(config: PracticeConfig, expectedDigest?: string) {
  try {
    const trust = expectedDigest && config.resourceTrust?.routes?.[expectedDigest] ? config.resourceTrust.routes[expectedDigest] : config.resourceTrust;
    if (!trust) {
      if (config.mode !== 'fixture') throw new ResourceError('TRUST_REQUIRED');
      return { digest: resourceHash(captureArtifact(config.rootDir, false)), assurance: 'fixture' as const, signer: 'fixture-only' };
    }
    const document = z.object({ manifest: artifactManifestSchema, signature: z.string() }).strict().parse(JSON.parse(readFileSync(trust.manifestPath, 'utf8')));
    const key = createPublicKey(readFileSync(trust.publicKeyPath));
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(document.manifest)), key, Buffer.from(document.signature, 'base64'))) throw new ResourceError('SIGNATURE_INVALID');
    const actual = captureArtifact(config.rootDir, true);
    if (resourceHash(actual) !== resourceHash(document.manifest)) throw new ResourceError('ARTIFACT_DRIFT');
    const digest = resourceHash(actual);
    if (expectedDigest && digest !== expectedDigest) {
      // 历史 Run 只能使用部署配置显式登记的续接制品继续；Run、浏览器与数据库均不能自行授权代码漂移。
      const continuation = config.resourceTrust?.continuations?.[expectedDigest];
      if (!continuation) throw new ResourceError('ARTIFACT_DRIFT');
      const continuationDocument = z.object({ manifest: artifactManifestSchema, signature: z.string() }).strict().parse(JSON.parse(readFileSync(continuation.manifestPath, 'utf8')));
      const continuationKey = createPublicKey(readFileSync(continuation.publicKeyPath));
      if (continuationKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(continuationDocument.manifest)), continuationKey, Buffer.from(continuationDocument.signature, 'base64')) || resourceHash(continuationDocument.manifest) !== digest) throw new ResourceError('ARTIFACT_DRIFT');
    }
    return { digest, assurance: 'signed' as const, signer: bytesHash(key.export({ type: 'spki', format: 'der' })) };
  } catch (error) { if (error instanceof ResourceError) throw error; throw new ResourceError('ARTIFACT_INVALID'); }
}
