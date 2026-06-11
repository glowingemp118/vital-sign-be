import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TranscriptionDocument = Transcription & Document;

@Schema({ timestamps: true })
export class Transcription {
  @Prop({ type: Types.ObjectId, required: true, ref: 'users' })
  doctor: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: 'users' })
  user: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, ref: 'voices' })
  voice: Types.ObjectId;

  @Prop({ required: false, default: '' })
  doctorRecommendation?: string;
}

export const TranscriptionSchema = SchemaFactory.createForClass(Transcription);
