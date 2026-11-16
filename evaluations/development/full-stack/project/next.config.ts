import type {NextConfig} from 'next';
const config: NextConfig = {
  experimental: {cpus:1},
  /** 固定同容器网络的API代理，不接收用户输入的上游地址。 */
  async rewrites() { return [{source:'/api/:path*',destination:'http://api:3001/api/:path*'}]; },
};
export default config;
