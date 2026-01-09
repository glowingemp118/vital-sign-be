import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class Message {
  @Prop({ index: true })
  conversationId: string;

  @Prop({ index: true })
  senderId: string;

  @Prop({ index: true })
  receiverId: string;

  @Prop()
  content: string;

  @Prop({
    enum: ['SENT', 'DELIVERED', 'READ'],
    default: 'SENT',
  })
  status: 'SENT' | 'DELIVERED' | 'READ';
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.index({ conversationId: 1, createdAt: -1 });
