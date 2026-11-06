import {BadRequestException,Body,Controller,Get,Post} from '@nestjs/common';
import {TicketsService} from './tickets.service.js';
@Controller('api/tickets')
export class TicketsController {
  /** 主持基准：注入真实数据库服务。 */
  constructor(private readonly tickets:TicketsService) {}
  /** 主持基准：只接受唯一字符串标题，trim后按UTF-16长度校验。 */
  @Post() create(@Body() body:unknown) {
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==1 || !Object.hasOwn(body,'title')) throw new BadRequestException('只接受title');
    const title=(body as {title:unknown}).title;
    if (typeof title!=='string' || title.trim().length<1 || title.trim().length>120) throw new BadRequestException('标题长度必须为1到120');
    return this.tickets.create(title.trim());
  }
  /** 主持基准：读取所有真实记录。 */
  @Get() list() { return this.tickets.list(); }
}
