import { Streamdown } from "streamdown";

/** 正文和助手共用安全 Markdown 渲染；禁用原始 HTML 与外部图片加载。 */
export function Markdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      className="markdown"
      skipHtml
      // 文档图片只展示文本占位，避免浏览器发出隐式外部请求。
      components={{
        img: () => <span className="image-placeholder">[图片未加载]</span>,
      }}
    >
      {children}
    </Streamdown>
  );
}
