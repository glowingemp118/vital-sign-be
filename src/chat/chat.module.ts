import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Voice, VoiceSchema } from 'src/health-voice/schemas/voice.schema';
import { NotificationModule } from 'src/notification/notfication.module';
import { User, UserSchema } from 'src/user/schemas/user.schema';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { WebrtcController } from './webrtc.controller';
import {
  Conversation,
  ConversationSchema,
} from './schemas/conversation.schema';
import { Message, MessageSchema } from './schemas/message.schema';
import {
  SocketConnection,
  SocketConnectionSchema,
} from './schemas/socket.schema';
import { SocketService } from './socket.services';
import { Transcription, TranscriptionSchema } from 'src/features/schemas/transcription.schema';

@Module({
  imports: [
    NotificationModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Message.name, schema: MessageSchema },
      { name: SocketConnection.name, schema: SocketConnectionSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: Voice.name, schema: VoiceSchema },
      { name: Transcription.name, schema: TranscriptionSchema }
    ]),
  ],
  providers: [ChatGateway, ChatService, SocketService],
  controllers: [ChatController, WebrtcController],
})
export class ChatModule { }
