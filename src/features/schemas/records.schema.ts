import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RecordDocument = Record & Document;

@Schema()
export class Record {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({ type: Date, required: true })
  recorded_at: Date;

  @Prop({ type: Types.ObjectId, ref: 'Vital', required: true })
  vital: Types.ObjectId;

  @Prop({ type: String, required: true })
  value: String;

  @Prop({ type: String, default: 'normal' })
  status: string;
}

export const RecordSchema = SchemaFactory.createForClass(Record);
