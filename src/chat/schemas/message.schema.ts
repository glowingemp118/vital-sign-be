import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true })
export class Message {
  @Prop({ index: true })
  @Prop({ type: String, enum: ['direct', 'group'], default: 'direct' })
  type: 'direct' | 'group';

  @Prop({ type: Types.ObjectId, required: true, ref: 'User' })
  subjectId: Types.ObjectId; // Reference to the appointment

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  objectId: Types.ObjectId;

  @Prop({ type: String, enum: ['text', 'audio', 'file'], required: true })
  messageType: 'text' | 'audio' | 'file';

  @Prop({ required: false })
  mediaUrl: string;

  @Prop([{ type: Types.ObjectId, ref: 'User' }])
  readBy: Types.ObjectId[];

  @Prop()
  content: string;

  @Prop({
    enum: ['SENT', 'DELIVERED'],
    default: 'SENT',
  })
  status: 'SENT' | 'DELIVERED';
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.index({ conversationId: 1, createdAt: -1 });
