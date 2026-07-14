import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DevicesDocument = Device & Document;

@Schema({ timestamps: true })
export class Device {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({
    type: [
      {
        device_id: { type: String }, // FCM token
        device_type: { type: String }, // ios | android
        voip_token: { type: String }, // iOS PushKit VoIP token (hex)
        _id: false,
      },
    ],
    default: [],
    _id: false,
  })
  devices: {
    device_id?: string;
    device_type: string;
    voip_token?: string;
  }[];
}

export const DeviceSchema = SchemaFactory.createForClass(Device);
