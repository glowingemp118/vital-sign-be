import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReviewDocument = Review & Document;

@Schema({ timestamps: true })
export class Review {
  @Prop({ type: Types.ObjectId, required: true, ref: 'Appointment' })
  appointment: Types.ObjectId;  // Reference to the appointment

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;  // User who is leaving the review

  @Prop({ type: Number, required: true, min: 1, max: 5 })
  rating: number;  // Rating (1 to 5)

  @Prop({ type: String, required: true })
  review: string;  // Review text

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  doctor: Types.ObjectId;  // Doctor being reviewed
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
