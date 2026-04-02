import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type HospitalDocument = Hospital & Document;

@Schema()
export class Hospital {
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, required: true })
  location: string;

  @Prop({ type: String, required: true })
  areaLevel: string;
}

export const HospitalSchema = SchemaFactory.createForClass(Hospital);
