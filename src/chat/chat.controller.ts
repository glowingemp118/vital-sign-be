import {
  Controller,
  Get,
  Post,
  Delete,
  Put,
  Param,
  Body,
  Req,
} from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('/')
  fetchChats(@Req() req) {
    return this.chatService.fetchChats(req);
  }

  // 🔹 Fetch messages with a specific user
  @Get(':otherUserId/messages')
  fetchMessages(@Param('otherUserId') otherUserId: string, @Req() req) {
    return this.chatService.fetchMessages(req, otherUserId);
  }

  // 🔹 Send a message to a specific user
  @Post(':otherUserId/message')
  sendDirectMessage(@Param('otherUserId') otherUserId: string, @Req() req) {
    return this.chatService.sendDirectMessage(req, otherUserId);
  }

  // 🔹 Delete entire chat with a user
  @Delete(':otherUserId/chat')
  deleteChat(@Param('otherUserId') otherUserId: string, @Req() req) {
    return this.chatService.deleteChat(req.user, otherUserId);
  }

  // 🔹 Delete a specific message
  @Delete('message/:messageId')
  deleteMessage(@Param('messageId') messageId: string, @Req() req) {
    return this.chatService.deleteMessage(req.user, messageId);
  }

  // 🔹 Mark all messages as read
  @Put('message/read/:otherUserId')
  markAllMessagesAsRead(@Param('otherUserId') otherUserId: string, @Req() req) {
    return this.chatService.markAllMessagesAsRead(req.user, otherUserId);
  }
}
