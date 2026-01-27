import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Message, MessageSchema } from './schemas/message.schema';
import {
  Conversation,
  ConversationSchema,
} from './schemas/conversation.schema';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import {
  SocketConnection,
  SocketConnectionSchema,
} from './schemas/socket.schema';
import { SocketService } from './socket.services';
import { User, UserSchema } from 'src/user/schemas/user.schema';
import { NotificationService } from 'src/notification/notification.service';
import { Device, DeviceSchema } from 'src/user/schemas/devices.schema';
import { NotificationModule } from 'src/notification/notfication.module';

@Module({
  imports: [
    NotificationModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: SocketConnection.name, schema: SocketConnectionSchema },
    ]),
  ],
  providers: [ChatGateway, ChatService, SocketService],
  controllers: [ChatController],
})
export class ChatModule {}
