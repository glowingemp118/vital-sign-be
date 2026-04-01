import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
const  FormData =require( 'form-data');
import * as fs from 'fs';
import { Model } from 'mongoose';
import fetch from 'node-fetch';

import { VitalsDto } from './dto/upload-voice.dto';
import { Voice, VoiceDocument } from './schemas/voice.schema';

@Injectable()
export class HealthVoiceService {
  private readonly logger = new Logger(HealthVoiceService.name);
  private readonly groqBase = 'https://api.groq.com/openai/v1';
  private readonly groqKey: string;

  constructor(
    @InjectModel(Voice.name) private readonly voiceModel: Model<VoiceDocument>,
    private readonly config: ConfigService,
  ) {
    this.groqKey = this.config.getOrThrow<string>('GROQ_API_KEY');
  }

  // ────────────────────────────────────────────────────────────
  //  PRIVATE: Groq helpers
  // ────────────────────────────────────────────────────────────

  private async transcribeAudio(filePath: string, originalName: string): Promise<string> {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename: originalName || 'audio.mp3' });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');
    form.append('language', 'en');

    const res = await fetch(`${this.groqBase}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.groqKey}`,
        ...(form.getHeaders ? form.getHeaders() : {}),
      },
      body: form as any,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new InternalServerErrorException(`Groq transcription failed: ${err}`);
    }
    const data = await res.json() as { text: string };
    return data.text;
  }

  private async generateHealthSummary(transcription: string, vitals?: VitalsDto): Promise<any> {
    const vitalsText = vitals
      ? `
- Blood Pressure : ${vitals.bloodPressure ?? 'N/A'}
- Heart Rate     : ${vitals.heartRate ?? 'N/A'} bpm
- SpO2           : ${vitals.spo2 ?? 'N/A'} %
- Glucose        : ${vitals.glucose ?? 'N/A'} mg/dL
- Temperature    : ${vitals.temperature ?? 'N/A'}
- Weight         : ${vitals.weight ?? 'N/A'}`
      : 'No vitals provided.';

    const systemPrompt = `You are an advanced AI health analyst with deep medical knowledge — like a highly experienced online doctor giving a thorough, honest, and complete assessment.

DISCLAIMER (always include verbatim at the start of your "disclaimer" field):
"⚠️ I am not a doctor. This is AI-generated guidance only — not a medical diagnosis. Always consult a qualified healthcare professional before making any medical decisions."

Your job:
- Perform a FULL, deep clinical-style analysis of the patient's vitals and voice message.
- Identify ALL concerning patterns, abnormalities, or risk indicators — do not hold back.
- Give detailed, specific, actionable recommendations (not vague advice).
- Explain what each abnormal vital could indicate.
- Predict potential risks if left unaddressed.
- Speak like a knowledgeable, caring doctor — warm but direct and thorough.
- If something is urgent, be very clear about it.
- Suggest specific next steps: specialist type, tests needed, lifestyle changes.
- If vitals are normal, still give a complete wellness insight.

Return ONLY valid JSON, no markdown, no extra text:
{
  "disclaimer"       : "⚠️ I am not a doctor. This is AI-generated guidance only — not a medical diagnosis. Always consult a qualified healthcare professional before making any medical decisions.",
  "overallStatus"    : "normal | warning | urgent",
  "clinicalSummary"  : "string – 3-5 sentences of deep clinical interpretation",
  "vitalBreakdown"   : [{ "vital": "name", "value": "reading", "status": "normal|elevated|low|critical", "interpretation": "string" }],
  "riskPatterns"     : ["string"],
  "predictiveFlags"  : ["string"],
  "recommendations"  : [{ "priority": "immediate|soon|routine", "action": "string", "reason": "string" }],
  "specialistAdvice" : "string",
  "supportMessage"   : "string",
  "urgentAlert"      : "string or null"
}`;

    const userPrompt = `Patient said:\n"${transcription}"\n\nTheir current vitals:\n${vitalsText}\n\nPerform a full, unrestricted health analysis.`;

    const res = await fetch(`${this.groqBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new InternalServerErrorException(`Groq LLM failed: ${err}`);
    }

    const data = await res.json() as any;
    const raw: string = data.choices[0].message.content.trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    try {
      return JSON.parse(clean);
    } catch {
      return { rawResponse: raw };
    }
  }

  private generateVoiceId(): string {
    return `voice_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // ────────────────────────────────────────────────────────────
  //  PUBLIC: Service methods
  // ────────────────────────────────────────────────────────────

  /** POST /voice/upload — transcribe and store */
  async uploadVoice(file: Express.Multer.File): Promise<{ voiceId: string; transcription: string; createdAt: string }> {
    this.logger.log(`Transcribing: ${file.originalname}`);

    let transcription: string;
    try {
      transcription = await this.transcribeAudio(file.path, file.originalname);
    } finally {
      fs.unlink(file.path, () => {});
    }

    const voiceId = this.generateVoiceId();
    const createdAt = new Date().toISOString();

    await this.voiceModel.create({
      voiceId,
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [],
      latestSummary: null,
    });

    this.logger.log(`Transcribed [${voiceId}]: "${transcription.slice(0, 80)}..."`);
    return { voiceId, transcription, createdAt };
  }

  /** GET /voice/:voiceId */
  async getVoice(voiceId: string) {
    const record = await this.voiceModel
      .findOne({ voiceId })
      .select('-_id voiceId filename transcription createdAt latestSummary')
      .lean();
    if (!record) throw new NotFoundException(`Voice record not found: ${voiceId}`);
    return record;
  }

  /** GET /voice */
  async listVoices() {
    const docs = await this.voiceModel
      .find({})
      .select('-_id voiceId filename transcription createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const voices = docs.map((v) => ({
      voiceId: v.voiceId,
      filename: v.filename,
      preview: (v.transcription || '').slice(0, 100),
      createdAt: v.createdAt,
    }));

    return { total: voices.length, voices };
  }

  /** DELETE /voice/:voiceId */
  async deleteVoice(voiceId: string) {
    const result = await this.voiceModel.deleteOne({ voiceId });
    if (result.deletedCount === 0) throw new NotFoundException(`Voice record not found: ${voiceId}`);
    return { message: `Voice record ${voiceId} deleted.` };
  }

  /** POST /summary — generate and save summary */
  async createSummary(voiceId: string, vitals?: VitalsDto) {
    const record = await this.voiceModel.findOne({ voiceId }).select('transcription').lean();
    if (!record) throw new NotFoundException(`No voice record found for voiceId: ${voiceId}`);

    this.logger.log(`Generating summary for [${voiceId}]`);
    const summary = await this.generateHealthSummary(record.transcription, vitals);
    const generatedAt = new Date().toISOString();
    const summaryEntry = { vitals: vitals ?? null, summary, generatedAt };

    await this.voiceModel.updateOne(
      { voiceId },
      {
        $push: { summaries: summaryEntry },
        $set: { latestSummary: summaryEntry },
      },
    );

    return { voiceId, transcription: record.transcription, summary, generatedAt };
  }

  /** GET /summary/:voiceId */
  async getSummaries(voiceId: string) {
    const record = await this.voiceModel
      .findOne({ voiceId })
      .select('-_id voiceId latestSummary summaries')
      .lean();
    if (!record) throw new NotFoundException(`Voice record not found: ${voiceId}`);
    return record;
  }

  /** POST /analyze — one-shot: upload + transcribe + summarize */
  async analyze(file: Express.Multer.File, vitals?: VitalsDto) {
    this.logger.log(`[analyze] Transcribing: ${file.originalname}`);

    let transcription: string;
    try {
      transcription = await this.transcribeAudio(file.path, file.originalname);
    } finally {
      fs.unlink(file.path, () => {});
    }

    const voiceId = this.generateVoiceId();
    const createdAt = new Date().toISOString();

    this.logger.log(`[analyze] Generating summary for [${voiceId}]`);
    const summary = await this.generateHealthSummary(transcription, vitals);
    const generatedAt = new Date().toISOString();
    const summaryEntry = { vitals: vitals ?? null, summary, generatedAt };

    await this.voiceModel.create({
      voiceId,
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [summaryEntry],
      latestSummary: summaryEntry,
    });

    return {
      voiceId,
      transcription,
      vitals: vitals ?? 'not provided',
      summary,
      generatedAt,
    };
  }
}
