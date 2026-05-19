import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Req,
  Param,
  Delete,
} from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notification')
export class NotificationController {
  constructor(private readonly service: NotificationService) { }

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

  @Delete('/all')
  deleteall(@Req() req: any) {
    const userId = req.user._id;
    return this.service.deleteAllNotifications(userId);
  }

  @Delete('/:notificationId')
  deletenotification(
    @Param('notificationId') notificationId: string,
    @Req() req: any,
  ) {
    const userId = req.user._id;
    return this.service.deleteNotification(notificationId, userId);
  }


  @Put("/update-status/:notificationId")
  updateStatus(
    @Param('notificationId') notificationId: string,
    @Req() req: any) {
    return this.service.updateUserStatus(req.user._id, notificationId);
  }

  @Put("/:notificationId/call-911")
  call911(
    @Param('notificationId') notificationId: string,
    @Req() req: any) {
    return this.service.handleCall911(req.user._id, notificationId);
  }

  @Put("/:notificationId/cancel-emergency")
  cancelEmergency(
    @Param('notificationId') notificationId: string,
    @Req() req: any) {
    return this.service.handleCancelEmergency(req.user._id, notificationId);
  }
  @Put("/yes-i-am-ok")
  YesIAmOk(@Req() req: any) {
    return this.service.YesIAmOk(req.user._id);
  }
}
