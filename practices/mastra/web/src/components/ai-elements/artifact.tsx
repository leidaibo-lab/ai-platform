/** Adapted from Vercel AI Elements Artifact (Apache-2.0), registry retrieved 2026-11-04.
 * Source: https://elements.ai-sdk.dev/api/registry/artifact.json
 * Only the display primitives needed by this page are retained; actions use native accessible buttons.
 */
import type { HTMLAttributes } from "react";
import { cn } from "../../lib";

/** 容纳只读交接物与就地工具栏。 */
export function Artifact({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-background",
        className,
      )}
      {...props}
    />
  );
}
/** 正文标题和操作保持在同一文档边界内。 */
export function ArtifactHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}
/** 文档区域使用可独立滚动的内容容器。 */
export function ArtifactContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-auto", className)} {...props} />
  );
}
