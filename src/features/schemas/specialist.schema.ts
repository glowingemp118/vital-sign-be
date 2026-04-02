import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SpecialistDocument = Specialist & Document;

@Schema({ timestamps: true })
export class Specialist {
  @Prop({ type: String })
  name: string;

  @Prop({ type: String, required: true })
  email: string;

  @Prop({ type: Types.ObjectId, required: true, ref: 'users' })
  user: Types.ObjectId;
}

export const SpecialistSchema = SchemaFactory.createForClass(Specialist);
