import type {ReactNode} from 'react';
/** 保持简单中文语义布局；不加载外部字体或资源。 */
export default function RootLayout({children}:{children:ReactNode}) { return <html lang="zh-CN"><body>{children}</body></html>; }
