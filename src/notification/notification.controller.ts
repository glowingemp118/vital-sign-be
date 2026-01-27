import { Controller, Get, Put, Post, Body, Req, Param } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notification')
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  @Post('send')
  send(@Body() body: any) {
    return this.service.send(body.token, body.title, body.body);
  }

  @Get('/')
  getall(@Req() req: any) {
    return this.service.getAllNotifications(req);
  }

  @Put('read/:notificationId')
  markread(@Param('notificationId') notificationId: any) {
    return this.service.markAsRead(notificationId);
  }

  @Put('readall')
  readall(@Req() req: any) {
    const userId = req.user._id;
    return this.service.markAllAsRead(userId);
  }
}
