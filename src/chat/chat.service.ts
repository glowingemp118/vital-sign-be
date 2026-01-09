import { Injectable } from "@nestjs/common";
import { Conversation } from "./schemas/conversation.schema";
import { Message } from "./schemas/message.schema";
import { Model } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { SendMessageDto } from "./dto/chat-dto";

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Message.name) private msgModel: Model<Message>,
    @InjectModel(Conversation.name) private convModel: Model<Conversation>,
  ) {}

  async getOrCreateConversation(a: string, b: string) {
    const participants = [a, b].sort();
    return this.convModel.findOneAndUpdate(
      { participants },
      { participants },
      { upsert: true, new: true },
    );
  }

  async sendMessage(senderId: string, dto: SendMessageDto) {
    return this.msgModel.create({
      conversationId: dto.conversationId,
      senderId,
      receiverId: dto.receiverId,
      content: dto.content,
      status: 'SENT',
    });
  }

  async markDelivered(messageId: string, receiverId: string) {
    return this.msgModel.findOneAndUpdate(
      { _id: messageId, receiverId, status: 'SENT' },
      { status: 'DELIVERED' },
      { new: true },
    );
  }

  async markRead(conversationId: string, readerId: string) {
    await this.msgModel.updateMany(
      { conversationId, receiverId: readerId },
      { status: 'READ' },
    );
  }

  async fetchMessages(conversationId: string) {
    return this.msgModel.find({ conversationId }).sort({ createdAt: -1 });
  }
}
