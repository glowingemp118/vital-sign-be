// src/schemas/admin.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Settings Schema for Terms, Privacy, and About
@Schema()
export class Settings {
  @Prop({ required: false })
  tac: string;

  @Prop({ required: false })
  privacy: string;

  @Prop({ required: false })
  about: string;

  @Prop({ type: Date, default: Date.now })
  updatedAt: Date;
}

// FAQ Schema for Questions and Answers
@Schema()
export class Faq {
  @Prop({ required: true })
  question: string;

  @Prop({ required: true })
  answer: string;

  @Prop({ type: Date, default: Date.now })
  updatedAt: Date;
}

@Schema()
export class ContactSupport {
  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  subject: string;

  @Prop({ required: true })
  message: string;

  @Prop({ type: [String], default: [] })
  replies: string[];

  @Prop({
    enum: ['contact', 'support'],
    default: 'support',
  })
  type: 'contact' | 'support';

  @Prop({
    required: true,
    enum: ['open', 'closed'],
    default: 'open',
  })
  status: string;

  @Prop({ type: Date, default: Date.now })
  updatedAt: Date;
}

export type ContactSupportDocument = ContactSupport & Document;
export const ContactSupportSchema =
  SchemaFactory.createForClass(ContactSupport);

export type SettingsDocument = Settings & Document;
export const SettingsSchema = SchemaFactory.createForClass(Settings);

export type FaqDocument = Faq & Document;
export const FaqSchema = SchemaFactory.createForClass(Faq);
