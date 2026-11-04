/** Adapted from shadcn/ui AI Elements Message composition (MIT), retrieved 2026-11-04.
 * Source: https://ui.shadcn.com/r/styles/new-york-v4/message.json
 */
import type { ComponentProps } from "react";
import { cn } from "../../lib";

/** 使用 AI Elements 的对齐方式呈现 AI SDK 的 user/assistant 消息。 */
export function Message({
  className,
  align = "start",
  ...props
}: ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  );
}
/** 正文与来源标签在同一条消息内排版。 */
export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:items-end",
        className,
      )}
      {...props}
    />
  );
}
