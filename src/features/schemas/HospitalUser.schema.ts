import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type HospitalUserDocument = HospitalUser & Document;

@Schema({ timestamps: true })
export class HospitalUser {
  @Prop({ type: Types.ObjectId, required: true, ref: "hospital" })
  hospital: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: "user" })
  user: Types.ObjectId;
}

export const HospitalUserSchema = SchemaFactory.createForClass(HospitalUser);
