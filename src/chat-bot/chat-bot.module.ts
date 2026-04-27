import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatBotController } from './chat-bot.controller';
import { ChatBotMessage, ChatBotSchema } from './schemas/message.schema';
import { ChatBotService } from './chat-bot.service';


@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatBotMessage.name, schema: ChatBotSchema },
    ]),
  ],
  providers: [ChatBotService],
  controllers: [ChatBotController],
})
export class ChatBotModule { }
