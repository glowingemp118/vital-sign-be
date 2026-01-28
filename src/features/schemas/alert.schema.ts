import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AlertDocument = Alert & Document;

@Schema({ timestamps: true })
export class Alert {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({
    type: [
      {
        message: { type: String, required: true },
        type: {
          type: String,
          enum: ['info', 'warning', 'error', 'success'],
          default: 'info',
        },
        isRead: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  alerts: Array<{
    message: string;
    type: string;
    isRead: boolean;
    createdAt: Date;
  }>;
}

export const AlertSchema = SchemaFactory.createForClass(Alert);
