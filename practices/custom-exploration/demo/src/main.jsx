import React from "react";
import { createRoot } from "react-dom/client";
import { XProvider } from "@ant-design/x";
import "@ant-design/x-markdown/themes/light.css";
import xZhCN from "@ant-design/x/locale/zh_CN";
import antdZhCN from "antd/locale/zh_CN";
import App from "./App.jsx";
import "./styles.css";

const locale = { ...antdZhCN, ...xZhCN };
const root = createRoot(document.getElementById("root"));

/** 使用统一主题和中文组件文案挂载渠道应用。 */
root.render(
  <React.StrictMode>
    <XProvider
      locale={locale}
      theme={{
        token: {
          colorPrimary: "#1677ff",
          colorSuccess: "#238636",
          colorWarning: "#b7791f",
          borderRadius: 6,
          fontFamily:
            'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
      }}
    >
      <App />
    </XProvider>
  </React.StrictMode>,
);
