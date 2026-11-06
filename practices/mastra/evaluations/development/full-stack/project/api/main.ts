import 'reflect-metadata';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {Database} from './database.js';
import {TicketsController} from './tickets.controller.js';
import {TicketsService} from './tickets.service.js';
@Module({controllers:[TicketsController],providers:[Database,TicketsService]})
class ApplicationModule {}
/** 只监听容器端口，宿主发布与网络边界由固定Compose控制。 */
async function main() { const app=await NestFactory.create(ApplicationModule); app.enableShutdownHooks(); await app.listen(3001,'0.0.0.0'); }
// 启动失败产生非零退出码，不保存配置或连接字符串。
main().catch(() => { console.error('API启动失败'); process.exitCode=1; });
