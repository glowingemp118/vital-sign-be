import { Controller, Get, Param } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get(':conversationId/messages')
  getMessages(@Param('conversationId') id: string) {
    return this.chat.fetchMessages(id);
  }
}
