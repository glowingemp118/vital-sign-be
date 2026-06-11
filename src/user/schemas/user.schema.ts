import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, model } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true })
  name: string;

  @Prop({
    required: true,
    unique: true,
  })
  email: string;
  @Prop({
    required: true,
  })
  @Prop({ required: true, minlength: 6 })
  password: string;

  @Prop({ required: false })
  phone: string;

  @Prop({ type: [Number], default: [] })
  roles: number[];

  @Prop({ enum: [0, 1, 2, 3, 4], type: Number, default: 1 })
  user_type: number;

  @Prop({ default: 'UTC' })
  timezone: string;

  @Prop({ default: false })
  is_verified: boolean;

  @Prop({ required: false })
  otp: string;

  @Prop({ enum: ['male', 'female', 'other'], default: 'male' })
  gender: string;

  @Prop({ required: false })
  country: string;

  @Prop({
    enum: ['active', 'inactive', 'blocked', 'deleted'],
    default: 'active',
  })
  status: string;

  @Prop({ default: 'noimage.png' })
  image: string;

  @Prop({ type: { otp: Date, reset: Date } })
  expiry: { otp: Date; reset: Date };

  @Prop({ type: { name: String, email: String, phone: String }, default: {} })
  hashes: { name: string; email: string; phone: string };

  @Prop({ type: String })
  previousEmail: {
    type: String;
  };

  @Prop({ type: [String], default: [] })
  rc_uid: string[];

  @Prop({ type: Object, default: {} })
  subscription: {
    isSubscribed: boolean;
    subscriptionStatus: string;
    productId: string;
    expiresAt: Date;
  };

  @Prop({
    type: {
      hypertension: Boolean,
      diabetes: Boolean,
      heartCondition: Boolean,
      arrhythmia: Boolean,
      highCholesterol: Boolean,
      obesity: Boolean,
    },
    default: {
      hypertension: false,
      diabetes: false,
      heartCondition: false,
      arrhythmia: false,
      highCholesterol: false,
      obesity: false,
    },
  })
  medicalConditions: {
    hypertension: boolean;
    diabetes: boolean;
    heartCondition: boolean;
    arrhythmia: boolean;
    highCholesterol: boolean;
    obesity: boolean;
  };

  @Prop({ enum: ['local', 'google', 'facebook', 'apple'], default: 'local' })
  provider: string;

  @Prop({ type: String, default: null })
  googleId?: string;

  @Prop({ type: String, default: null })
  facebookId?: string;

  @Prop({ type: String, default: null })
  appleId?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
