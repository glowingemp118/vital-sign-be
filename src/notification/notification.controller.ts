import { Controller, Post, Body, Req, Param } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notification')
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  @Post('send')
  send(@Body() body: any) {
    return this.service.send(body.token, body.title, body.body);
  }

  @Post('getall')
  getall(@Req() req: any) {
    return this.service.getAllNotifications(req);
  }

  @Post('markread/:notificationId')
  markread(@Param('notificationId') notificationId: any) {
    return this.service.markAsRead(notificationId);
  }

  @Post('readall')
  readall(@Req() req: any) {
    const userId = req.user._id;
    return this.service.markAllAsRead(userId);
  }
}
