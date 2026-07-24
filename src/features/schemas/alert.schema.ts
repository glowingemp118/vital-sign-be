import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AlertDocument = Alert & Document;

@Schema()
export class Alert {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({
    type: [
      {
        message: String,
        status: String,
        label: String,
        vital: String,
        value: String,
        recorded_at: Date,
        /** User tapped I'm Okay — do not FCM-retry until value changes */
        acked: { type: Boolean, default: false },
      },
    ],
    default: [],
  })
  alerts: Array<{
    message: string;
    status: string;
    label: string;
    vital: string;
    value: string;
    recorded_at: Date;
    acked?: boolean;
  }>;

  /**
   * Signatures the user acknowledged via I'm Okay.
   * Format: "vitalKey|normalizedValue" — blocks FCM/retry until value changes.
   */
  @Prop({ type: [String], default: [] })
  acknowledged: string[];
}

export const AlertSchema = SchemaFactory.createForClass(Alert);
