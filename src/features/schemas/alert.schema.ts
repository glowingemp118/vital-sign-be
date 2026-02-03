import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AlertDocument = Alert & Document;

@Schema()
export class Alert {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({
    type: [
      {
        message: String,
        status: String,
        label: String,
        vital: String,
        recorded_at: Date,
      },
    ],
    default: [],
  })
  alerts: Array<{
    message: string;
    status: string;
    label: string;
    vital: string;
    recorded_at: Date;
  }>;
}

export const AlertSchema = SchemaFactory.createForClass(Alert);
