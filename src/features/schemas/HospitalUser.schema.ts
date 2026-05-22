import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Hospital } from './hospital.schema'; // import your Hospital schema

export type HospitalUserDocument = HospitalUser & Document;

@Schema({ timestamps: true })
export class HospitalUser {
  @Prop({ type: Types.ObjectId, required: true, ref: Hospital.name }) // <- fix here
  hospital: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: 'user' }) // keep user ref as is
  user: Types.ObjectId;
}

export const HospitalUserSchema = SchemaFactory.createForClass(HospitalUser);
