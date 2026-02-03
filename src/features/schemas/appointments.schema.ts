import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AppointmentDocument = Appointment & Document;

@Schema({ timestamps: true })
export class Appointment {
  @Prop()
  appointmentId: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  doctor: Types.ObjectId;

  @Prop({ required: true })
  startTime: string;

  @Prop({ required: true })
  endTime: string;

  @Prop({ required: true })
  duration: number;

  @Prop({ default: 'minutes' })
  unit: string;

  @Prop({ required: true })
  date: Date;

  @Prop({
    enum: ['pending', 'confirmed', 'cancelled', 'completed'],
    default: 'pending',
  })
  status: string;
  @Prop()
  notes: string;
  @Prop({
    type: {
      reason: { type: String },
      cancelledAt: { type: Date },
      cancelledBy: { type: String },
    },
  })
  cancelled: { reason: string; cancelledAt: Date; cancelledBy: string };
}

export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
