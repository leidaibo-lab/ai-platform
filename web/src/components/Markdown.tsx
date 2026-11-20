import { createMermaidPlugin } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import { BusinessTextBlock } from "./BusinessTextBlock";

const architectureMermaid = createMermaidPlugin({ config: { securityLevel: "strict", htmlLabels: false, maxTextSize: 12000, maxEdges: 40 } });

/** 正文和助手共用安全 Markdown 渲染；禁用原始 HTML 与外部图片加载。 */
export function Markdown({
  children,
  streaming = false,
  business = false,
  architectureDiagrams = false,
}: {
  children: string;
  streaming?: boolean;
  business?: boolean;
  architectureDiagrams?: boolean;
}) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      className="markdown"
      skipHtml
      plugins={architectureDiagrams ? { mermaid: architectureMermaid } : undefined}
      // 文档图片只展示文本占位，避免浏览器发出隐式外部请求。
      components={{
        ...(business && !streaming ? { pre: BusinessTextBlock } : {}),
        img: () => <span className="image-placeholder">[图片未加载]</span>,
      }}
    >
      {children}
    </Streamdown>
  );
}
