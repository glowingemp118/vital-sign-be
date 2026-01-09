import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { ReadDto, SendMessageDto } from './dto/chat-dto';

@WebSocketGateway({ cors: true })
export class ChatGateway {
  @WebSocketServer()
  server: Server;

  constructor(private readonly chat: ChatService) {}

  room(id: string) {
    return `conversation:${id}`;
  }

  @SubscribeMessage('join')
  join(@MessageBody() { conversationId }, @ConnectedSocket() socket: Socket) {
    socket.join(this.room(conversationId));
  }

  @SubscribeMessage('send')
  async send(
    @MessageBody() dto: SendMessageDto,
    @ConnectedSocket() socket: Socket,
  ) {
    const senderId = socket.handshake.auth.userId;

    const message = await this.chat.sendMessage(senderId, dto);

    this.server.to(this.room(dto.conversationId)).emit('message:new', message);

    return message;
  }

  @SubscribeMessage('delivered')
  async delivered(
    @MessageBody() { messageId },
    @ConnectedSocket() socket: Socket,
  ) {
    const userId = socket.handshake.auth.userId;

    const msg = await this.chat.markDelivered(messageId, userId);

    if (msg) {
      this.server.to(this.room(msg.conversationId)).emit('message:status', msg);
    }
  }

  @SubscribeMessage('read')
  async read(@MessageBody() dto: ReadDto, @ConnectedSocket() socket: Socket) {
    const userId = socket.handshake.auth.userId;

    await this.chat.markRead(dto.conversationId, userId);

    this.server.to(this.room(dto.conversationId)).emit('conversation:read', {
      conversationId: dto.conversationId,
      userId,
    });
  }
}
