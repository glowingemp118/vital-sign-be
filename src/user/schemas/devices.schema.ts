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
        device_id: { type: String }, // e.g., 'Monday'
        device_type: { type: String }, // e.g., '09:00'
        _id: false, // Prevents automatic _id for subdocuments
      },
    ],
    default: [],
    _id: false, // Prevents automatic _id for array items
  })
  devices: {
    device_id: string;
    device_type: string;
  }[];
}

export const DeviceSchema = SchemaFactory.createForClass(Device);
