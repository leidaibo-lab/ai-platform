import React, { useMemo } from "react";
import { Tooltip } from "antd";
import { buildConversationAnchors } from "./conversation-view-model.js";

/**
 * 渲染固定聚合在会话区中部的用户消息索引。
 *
 * 组件只负责展示和发出稳定 messageId；实际滚动与高亮继续复用页面定位命令。
 */
export default function ConversationAnchorRail({ messages, onNavigate }) {
  const anchors = useMemo(
    // 仅在可见消息事实变化时重建用户消息摘要。
    () => buildConversationAnchors(messages),
    [messages],
  );

  if (anchors.length < 2) return null;

  return (
    <nav className="conversation-anchor-rail" aria-label="用户消息锚点">
      {anchors.map(
        // 每条用户消息生成一个等长刻度，顺序与会话事实保持一致。
        (anchor) => {
          /** 将当前锚点的稳定消息身份交给页面统一定位。 */
          function navigateToAnchor() {
            onNavigate(anchor.id);
          }
          return (
            <Tooltip
              key={anchor.id}
              placement="right"
              mouseEnterDelay={0.08}
              title={(
                <span className="conversation-anchor-preview">
                  <span>用户消息</span>
                  <strong>{anchor.preview}</strong>
                </span>
              )}
            >
              <button
                className="conversation-anchor"
                type="button"
                aria-label={`定位到用户消息：${anchor.preview}`}
                onClick={navigateToAnchor}
              >
                <span className="conversation-anchor-mark" />
              </button>
            </Tooltip>
          );
        },
      )}
    </nav>
  );
}
