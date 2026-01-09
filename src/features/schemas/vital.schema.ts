import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type VitalDocument = Vital & Document;

@Schema()
export class Vital {
  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true })
  key: string;

  @Prop({ type: String, required: true })
  description: string;
}

export const VitalSchema = SchemaFactory.createForClass(Vital);
