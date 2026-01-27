import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Notification {
  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    required: true,
  })
  user: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    trim: true,
  })
  title: string;

  @Prop({
    type: String,
    required: true,
  })
  message: string;

  @Prop({
    type: Boolean,
    default: false,
  })
  isRead: boolean;

  @Prop({
    type: String,
    default: false,
  })
  type: string;

  @Prop({
    type: Boolean,
    default: false,
  })
  isDeleted: boolean;

  @Prop({
    type: Object,
  })
  object: any;
}
export type NotificationDocument = Notification & Document;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
