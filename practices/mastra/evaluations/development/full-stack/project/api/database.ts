import {Injectable, type OnModuleDestroy, type OnModuleInit} from '@nestjs/common';
import {PrismaPg} from '@prisma/adapter-pg';
import {PrismaClient} from '../generated/prisma/client.js';

@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** 仅连接Compose显式注入的本次合成数据库。 */
  constructor() { super({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})}); }
  /** Nest启动时建立实际数据库连接，连接失败即启动失败。 */
  async onModuleInit() { await this.$connect(); }
  /** Nest退出时释放数据库连接池。 */
  async onModuleDestroy() { await this.$disconnect(); }
}
