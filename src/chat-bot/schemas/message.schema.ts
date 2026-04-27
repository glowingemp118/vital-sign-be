import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true,collection:"chatBot" })
export class ChatBotMessage {
    @Prop({ index: true })

    @Prop({ type: Types.ObjectId, required: true, ref: 'User' })
    userId: Types.ObjectId;

    @Prop()
    message: string;

    @Prop()
    aiReply: string;

}

export const ChatBotSchema = SchemaFactory.createForClass(ChatBotMessage);

ChatBotSchema.index({  createdAt: -1 });
