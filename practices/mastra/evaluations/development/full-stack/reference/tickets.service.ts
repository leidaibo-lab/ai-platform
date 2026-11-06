import {Injectable} from '@nestjs/common';
import {Database} from './database.js';
@Injectable()
export class TicketsService {
  /** 主持基准：只通过Prisma访问本次数据库。 */
  constructor(private readonly database:Database) {}
  /** 主持基准：ORM生成UUID并写入真实PostgreSQL。 */
  create(title:string) { return this.database.ticket.create({data:{title}}); }
  /** 主持基准：数据库端按时间与ID倒序排序。 */
  list() { return this.database.ticket.findMany({orderBy:[{createdAt:'desc'},{id:'desc'}]}); }
}
