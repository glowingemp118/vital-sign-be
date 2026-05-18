import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
const FormData = require('form-data');
import * as fs from 'fs';
import { Model } from 'mongoose';
import fetch from 'node-fetch';
// import Groq from 'groq-sdk';
import * as edgeTTS from 'node-edge-tts';

import { VitalsDto } from './dto/upload-voice.dto';
import { Voice, VoiceDocument } from './schemas/voice.schema';
import { Notification, NotificationDocument } from 'src/notification/notification.schema';
import path from 'path';
import { CloudinaryService } from 'src/utils/cloudinary';

@Injectable()
export class HealthVoiceService {
  private readonly logger = new Logger(HealthVoiceService.name);
  private readonly groqBase = 'https://api.groq.com/openai/v1';
  private readonly groqKey: string;

  constructor(
    @InjectModel(Voice.name) private readonly voiceModel: Model<VoiceDocument>,
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    private readonly config: ConfigService,
    private readonly cloudinaryService: CloudinaryService
  ) {
    this.groqKey = this.config.getOrThrow<string>('GROQ_API_KEY');

  }

  // private groq = new Groq({
  //   apiKey: process.env.GROQ_API_KEY,
  // });


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

"Before You Start
Important: Grok is an Artificial Intelligence, not a doctor.
All suggestions from Grok are AI-generated only. They are not medical advice and must never be used as a diagnosis or treatment.

Monitoring Consent
Please read, listen, and accept the following before activating 24/7 health monitoring.

Data Collection & Privacy
By enabling 24/7 monitoring, you authorize the continuous collection of your physiological data. This data is encrypted and stored securely.

Emergency Services
If the system detects a serious problem, it will send an alert to you. You are responsible for deciding whether to call emergency services. The app does not automatically call 911 or any emergency service.

Liability & Limitations
This service is only a monitoring aid. It is not a substitute for professional medical care. Grok’s voice messages are suggestions only and should never be treated as a diagnosis.

By clicking “Start Monitoring” you confirm that you have read, listened to, and fully accept these terms. The AI features will remain disabled until you accept.

You must scroll through the entire text and listen to the full audio message before activation is allowed."

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
  "disclaimer"       : "FULL DISCLAIMER TEXT ABOVE (must match exactly)",
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

  // private async convertTextToSpeech(text: string): Promise<string> {
  //   try {
  //     // create uploads/audio folder if not exists
  //     const outputDir = path.join(process.cwd(), 'uploads', 'audio');

  //     if (!fs.existsSync(outputDir)) {
  //       fs.mkdirSync(outputDir, { recursive: true });
  //     }

  //     const fileName = `summary-${Date.now()}.wav`;
  //     const outputPath = path.join(outputDir, fileName);

  //     // Generate speech
  //     const response = await this.groq.audio.speech.create({
  //       model: 'canopylabs/orpheus-v1-english',
  //       voice: 'hannah',
  //       input: text,
  //       response_format: 'wav',
  //     });

  //     const buffer: any = Buffer.from(await response.arrayBuffer());

  //     await fs.promises.writeFile(outputPath, buffer);

  //     this.logger.log(`Audio generated: ${outputPath}`);

  //     await fs.promises.writeFile(outputPath, buffer);

  //     return outputPath;
  //   } catch (error) {
  //     this.logger.error('TTS Error', error);
  //     throw error;
  //   }
  // }



  // ────────────────────────────────────────────────────────────
  //  PUBLIC: Service methods
  // ────────────────────────────────────────────────────────────


  private async convertTextToSpeech(
    text: string,
  ): Promise<string> {
    try {
      const outputDir = path.join(
        process.cwd(),
        'uploads/audio',
      );

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const fileName = `summary-${Date.now()}.mp3`;

      const filePath = path.join(outputDir, fileName);

      const tts = new edgeTTS.EdgeTTS();

      // Generate speech
      await tts.ttsPromise(text, filePath);

      return filePath;
    } catch (error) {
      throw error;
    }
  }

  /** POST /voice/upload — transcribe and store */
  async uploadVoice(file: Express.Multer.File, req: any): Promise<{ voiceId: string; transcription: string; createdAt: string, userId: string }> {
    this.logger.log(`Transcribing: ${file.originalname}`);

    let transcription: string;
    try {
      transcription = await this.transcribeAudio(file.path, file.originalname);
    } finally {
      fs.unlink(file.path, () => { });
    }

    // const voiceId = this.generateVoiceId();
    const createdAt = new Date().toISOString();

    const createVoice = await this.voiceModel.create({
      // voiceId,
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [],
      latestSummary: null,
      userId: req?.user?._id
    });

    this.logger.log(`Transcribed [${createVoice._id}]: "${transcription.slice(0, 80)}..."`);
    return { voiceId: createVoice._id.toString(), transcription, createdAt, userId: req?.user?._id };
  }

  /** GET /voice/:voiceId */
  async getVoice(voiceId: string) {

    const record: any = await this.voiceModel
      .findOne({ _id: voiceId })
      .select('_id voiceId filename transcription createdAt latestSummary')
      .lean();

    if (!record) throw new NotFoundException(`Voice record not found: ${voiceId}`);

    return {
      voiceId: record._id,
      filename: record.filename,
      transcription: record.transcription,
      createdAt: record.createdAt,
      latestSummary: {
        ...record.latestSummary,
        audioUrl: "http://res.cloudinary.com/" + process.env.CLOUDINARY_CLOUD_NAME + "/video/upload/" + record.latestSummary.audioUrl
      },
    };
  }

  /** GET /voice */
  async listVoices(req: any) {

    const docs = await this.voiceModel
      .find({ userId: req?.user?._id })
      .select('_id voiceId filename transcription createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const voices = docs.map((v) => ({
      // voiceId: v.voiceId,
      voiceId: v._id,
      filename: v.filename,
      preview: (v.transcription || '').slice(0, 100),
      createdAt: v.createdAt,
    }));

    return { total: voices.length, voices };
  }

  /** DELETE /voice/:voiceId */
  async deleteVoice(voiceId: string) {
    const result = await this.voiceModel.deleteOne({ _id: voiceId });
    if (result.deletedCount === 0) throw new NotFoundException(`Voice record not found: ${voiceId}`);
    return { message: `Voice record ${voiceId} deleted.` };
  }

  /** POST /summary — generate and save summary */
  async createSummary(voiceId: string, vitals?: VitalsDto) {
    try {
      const record = await this.voiceModel.findOne({ _id: voiceId }).select('transcription').lean();
      if (!record) throw new NotFoundException(`No voice record found for voiceId: ${voiceId}`);

      this.logger.log(`Generating summary for [${voiceId}]`);

      // Generate AI summary
      const summary = await this.generateHealthSummary(record.transcription, vitals);

      const audioUrl = await this.convertTextToSpeech(summary?.clinicalSummary);

      const generatedAt = new Date().toISOString();

      const data: any = await this.cloudinaryService.uploadFile(audioUrl);

      const summaryEntry = {
        vitals: vitals ?? null,
        summary,
        audioUrl: data.name,
        generatedAt
      };

      await this.voiceModel.updateOne(
        { _id: voiceId },
        {
          $push: { summaries: summaryEntry },
          $set: { latestSummary: summaryEntry },
        },
      );
      fs.unlinkSync(audioUrl);

      return {
        voiceId, transcription: record.transcription, summary: {
          ...summary,
          audioUrl: data.url
        }, generatedAt
      };
    } catch (error) {
      throw error;
    }
  }

  /** GET /summary/:voiceId */
  async getSummaries(voiceId: string) {
    const record = await this.voiceModel
      .findOne({ _id: voiceId })
      .select('-_id voiceId latestSummary summaries')
      .lean();
    if (!record) throw new NotFoundException(`Voice record not found: ${voiceId}`);

    record.summaries = record.summaries.map((item: any) => ({
      ...item,
      audioUrl: "http://res.cloudinary.com/" + process.env.CLOUDINARY_CLOUD_NAME + "/video/upload/" + item.audioUrl
    }));
  
    record.latestSummary = {
      ...record.latestSummary,
      vitals: record.latestSummary?.vitals ?? null,
      summary: record.latestSummary?.summary!,
      generatedAt:
        record.latestSummary?.generatedAt ?? '',

      audioUrl:
        'https://res.cloudinary.com/' +
        process.env.CLOUDINARY_CLOUD_NAME +
        '/video/upload/' +
        record.latestSummary?.audioUrl,
    };
    return record;
  }

  /** POST /analyze — one-shot: upload + transcribe + summarize */
  async analyze(file: Express.Multer.File, vitals?: VitalsDto) {
    this.logger.log(`[analyze] Transcribing: ${file.originalname}`);

    let transcription: string;
    try {
      transcription = await this.transcribeAudio(file.path, file.originalname);
    } finally {
      fs.unlink(file.path, () => { });
    }

    // const voiceId = this.generateVoiceId();
    const createdAt = new Date().toISOString();

    const summary: any = await this.generateHealthSummary(transcription, vitals);

    const audioUrl = await this.convertTextToSpeech(summary?.clinicalSummary);

    const data: any = await this.cloudinaryService.uploadFile(audioUrl);

    summary.audioUrl = data?.name

    const generatedAt = new Date().toISOString();

    const summaryEntry = { vitals: vitals ?? null, summary, generatedAt };

    const createVoice = await this.voiceModel.create({
      // voiceId:
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [summaryEntry],
      latestSummary: summaryEntry,
    });
    this.logger.log(`[analyze] Generating summary for [${createVoice?._id}]`);

    return {
      voiceId: createVoice._id.toString(),
      transcription,
      vitals: vitals ?? 'not provided',
      summary,
      generatedAt,
    };
  }
}
