import {Injectable} from '@nestjs/common';
import {Database} from './database.js';
@Injectable()
export class TicketsService {
  /** 注入主持装配的真实Prisma数据库客户端。 */
  constructor(private readonly database:Database) {}
  /** 待Agent实现真实数据库写入。 */
  create(_title:string):never { throw new Error('AGENT_IMPLEMENTATION_REQUIRED'); }
  /** 待Agent实现稳定排序的数据库读取。 */
  list():never { throw new Error('AGENT_IMPLEMENTATION_REQUIRED'); }
}
