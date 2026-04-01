import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VoiceDocument = Voice & Document;

// ── Nested: Vitals ────────────────────────────────────────────
@Schema({ _id: false })
export class Vitals {
  @Prop() bloodPressure?: string;
  @Prop() heartRate?: number;
  @Prop() spo2?: number;
  @Prop() glucose?: number;
  @Prop() temperature?: string;
  @Prop() weight?: string;
  @Prop() notes?: string;
}
export const VitalsSchema = SchemaFactory.createForClass(Vitals);

// ── Nested: VitalBreakdown item ───────────────────────────────
@Schema({ _id: false })
export class VitalBreakdownItem {
  @Prop() vital: string;
  @Prop() value: string;
  @Prop() status: string;
  @Prop() interpretation: string;
}

// ── Nested: Recommendation item ───────────────────────────────
@Schema({ _id: false })
export class RecommendationItem {
  @Prop() priority: string;
  @Prop() action: string;
  @Prop() reason: string;
}

// ── Nested: HealthSummary ─────────────────────────────────────
@Schema({ _id: false })
export class HealthSummary {
  @Prop() disclaimer: string;
  @Prop() overallStatus: string;
  @Prop() clinicalSummary: string;
  @Prop({ type: [Object] }) vitalBreakdown: VitalBreakdownItem[];
  @Prop({ type: [String] }) riskPatterns: string[];
  @Prop({ type: [String] }) predictiveFlags: string[];
  @Prop({ type: [Object] }) recommendations: RecommendationItem[];
  @Prop() specialistAdvice: string;
  @Prop() supportMessage: string;
  @Prop({ default: null }) urgentAlert: string | null;
  @Prop() rawResponse?: string; // fallback if JSON parse fails
}

// ── Nested: SummaryEntry ──────────────────────────────────────
@Schema({ _id: false })
export class SummaryEntry {
  @Prop({ type: Object }) vitals: Vitals | null;
  @Prop({ type: Object }) summary: HealthSummary;
  @Prop() generatedAt: string;
}

// ── Root: Voice ───────────────────────────────────────────────
@Schema({ collection: 'voices', timestamps: false })
export class Voice {
  @Prop({ required: true, unique: true, index: true })
  voiceId: string;

  @Prop() filename: string;

  @Prop({ required: true })
  transcription: string;

  @Prop({ required: true, index: -1 })
  createdAt: string;

  @Prop({ type: [Object], default: [] })
  summaries: SummaryEntry[];

  @Prop({ type: Object, default: null })
  latestSummary: SummaryEntry | null;
}

export const VoiceSchema = SchemaFactory.createForClass(Voice);
