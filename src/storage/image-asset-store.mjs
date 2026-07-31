import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/**
 * 本地图片资产存储错误，只暴露稳定分类，不携带物理目录。
 */
export class ImageAssetStoreError extends Error {
  /** 保存稳定错误码和原始异常，供 Runtime 映射公开结果。 */
  constructor(message, code = "image_asset_store_failed", cause) {
    super(message, { cause });
    this.name = "ImageAssetStoreError";
    this.code = code;
  }
}

/**
 * 创建仅持有图片二进制的本地 ImageAssetStore Adapter。
 * Port/Adapter 模式让 Runtime 和 SQLite 只依赖稳定 storageKey，后续可替换为对象存储。
 *
 * @param {object} options - 本地资产目录配置。
 * @param {string} options.directory - 图片二进制根目录。
 * @returns {object} 图片写入、读取和清理能力。
 */
export function createLocalImageAssetStore({ directory }) {
  const rootDirectory = resolve(String(directory || ".data/image-assets"));

  return {
    /** 原子写入一张已校验图片，并返回不包含物理路径的 storageKey。 */
    async write({ assetId, bytes, mediaType }) {
      const extension = extensionForMediaType(mediaType);
      const storageKey = `${String(assetId)}${extension}`;
      const filePath = resolveStoragePath(rootDirectory, storageKey);
      const temporaryPath = `${filePath}.tmp`;
      await mkdir(rootDirectory, { recursive: true });
      try {
        await writeFile(temporaryPath, bytes, { flag: "wx" });
        await rename(temporaryPath, filePath);
        return { storageKey };
      } catch (error) {
        await unlink(temporaryPath).catch(ignoreMissingTemporaryFile);
        throw new ImageAssetStoreError("图片资产写入失败", "image_asset_write_failed", error);
      }
    },

    /** 按内部 storageKey 读取图片字节，调用方必须先完成会话所有权校验。 */
    async read(storageKey) {
      try {
        return await readFile(resolveStoragePath(rootDirectory, storageKey));
      } catch (error) {
        throw new ImageAssetStoreError("图片资产不存在或无法读取", "image_asset_read_failed", error);
      }
    },

    /** 幂等删除尚未成为稳定事实或已到期的图片二进制。 */
    async delete(storageKey) {
      try {
        await unlink(resolveStoragePath(rootDirectory, storageKey));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new ImageAssetStoreError("图片资产清理失败", "image_asset_delete_failed", error);
        }
      }
    },
  };
}

/** 将受支持 MIME 映射为固定扩展名，拒绝由外部输入控制文件名。 */
function extensionForMediaType(mediaType) {
  const extensions = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
  };
  const extension = extensions[String(mediaType || "").toLowerCase()];
  if (!extension) throw new ImageAssetStoreError("不支持的图片格式", "unsupported_image_media_type");
  return extension;
}

/** 将 storageKey 限制在资产根目录内，阻止路径逃逸和未知扩展名。 */
function resolveStoragePath(rootDirectory, storageKey) {
  const normalizedKey = String(storageKey || "");
  if (!/^[0-9a-f-]+\.(?:png|jpg|webp)$/i.test(normalizedKey) || !extname(normalizedKey)) {
    throw new ImageAssetStoreError("图片资产标识无效", "invalid_image_storage_key");
  }
  const filePath = resolve(rootDirectory, normalizedKey);
  if (!filePath.startsWith(`${rootDirectory}${sep}`)) {
    throw new ImageAssetStoreError("图片资产标识无效", "invalid_image_storage_key");
  }
  return filePath;
}

/** 忽略清理临时文件时的不存在错误，其余错误仍由原始写入异常收口。 */
function ignoreMissingTemporaryFile() {}
