import {Body,Controller,Get,Post} from '@nestjs/common';
import {TicketsService} from './tickets.service.js';
@Controller('api/tickets')
export class TicketsController {
  /** 注入已装配的工单服务。 */
  constructor(private readonly tickets:TicketsService) {}
  /** 待Agent实现输入校验和创建契约。 */
  @Post() create(@Body() _body:unknown):never { throw new Error('AGENT_IMPLEMENTATION_REQUIRED'); }
  /** 待Agent实现真实工单列表。 */
  @Get() list():never { throw new Error('AGENT_IMPLEMENTATION_REQUIRED'); }
}
