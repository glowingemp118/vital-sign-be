import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema()
export class Doctor extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;
  @Prop({ type: [Types.ObjectId], ref: 'Speciality', required: true })
  specialties: Types.ObjectId[];

  @Prop({ type: String, required: true })
  experience: string;

  @Prop({ type: String })
  about: string;

  @Prop({
    type: [
      {
        day: { type: String }, // e.g., 'Monday'
        open: { type: String }, // e.g., '09:00'
        close: { type: String }, // e.g., '17:00'
        isOpen: { type: Boolean, default: true },
        _id: false, // Prevents automatic _id for subdocuments
      },
    ],
    default: [
      { day: 'Monday', open: '09:00', close: '17:00', isOpen: true },
      { day: 'Tuesday', open: '09:00', close: '17:00', isOpen: true },
      { day: 'Wednesday', open: '09:00', close: '17:00', isOpen: true },
      { day: 'Thursday', open: '09:00', close: '17:00', isOpen: true },
      { day: 'Friday', open: '09:00', close: '17:00', isOpen: true },
      { day: 'Saturday', open: '09:00', close: '13:00', isOpen: true },
      { day: 'Sunday', open: '', close: '', isOpen: false },
    ],
    _id: false, // Prevents automatic _id for array items
  })
  timing: {
    day: string;
    open: string;
    close: string;
    isOpen: boolean;
  }[];
}
export type DoctorDocument = Doctor & Document;

export const DoctorSchema = SchemaFactory.createForClass(Doctor);
