import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
const FormData = require('form-data');
import * as fs from 'fs';
import { Model } from 'mongoose';
import fetch from 'node-fetch';
import * as path from 'path';

import { VitalsDto } from './dto/upload-voice.dto';
import { Voice, VoiceDocument } from './schemas/voice.schema';
import { Notification, NotificationDocument } from 'src/notification/notification.schema';
import { CloudinaryService } from 'src/utils/cloudinary';
import mongoose from 'mongoose';

export type HealthStreamEvent =
  | { type: 'started'; voiceId?: string; stage?: string }
  | { type: 'progress'; stage: string; elapsedMs: number }
  | { type: 'transcription_start' }
  | { type: 'transcription'; text: string }
  | { type: 'transcription_ready'; transcription: string }
  | { type: 'quick_summary_start' }
  | { type: 'summary_chunk'; text: string; isCumulative: false }
  | { type: 'summary_delta'; delta: string; fullText: string }
  | { type: 'clinical_summary_delta'; delta: string; fullText: string }
  | { type: 'patient_summary_ready'; patientSummary: string; urgencyLevel: string }
  | { type: 'clinical_summary_ready'; clinicalSummary: string }
  | { type: 'doctor_assessment_ready'; doctorAssessment: Record<string, unknown> }
  | { type: 'recommendations_ready'; recommendations: unknown[] }
  | { type: 'audio_chunk'; index: number; text: string; audioBase64: string; format: 'mp3' }
  | { type: 'audio_start' }
  | { type: 'audio_ready'; audioUrl: string }
  | { type: 'summary_complete'; summary: Record<string, unknown> }
  | { type: 'done'; voiceId: string; transcription: string; summary: Record<string, unknown>; patientSummary: string; clinicalSummary: string; doctorAssessment: Record<string, unknown>; recommendations: unknown[]; urgencyLevel: string; generatedAt: string; audioUrl?: string; audioPending?: boolean; data?: Record<string, unknown> }
  | { type: 'error'; message: string };

type StreamEmitter = (event: HealthStreamEvent) => void | Promise<void>;

/** Non-blocking TTS — first sentence goes out fast, later chunks ~5s each. */
class TtsChunkStreamer {
  private spokenUpTo = 0;
  private audioIndex = 0;
  private isFirstChunk = true;
  private chain: Promise<void> = Promise.resolve();
  readonly audioBuffers: Buffer[] = [];

  constructor(
    private readonly synthesize: (text: string) => Promise<Buffer>,
    private readonly firstMinChars = 28,
    private readonly minChars = 60,
  ) {}

  feed(fullText: string, emit: StreamEmitter) {
    while (true) {
      const chunk = this.takeChunk(fullText);
      if (!chunk) break;
      this.isFirstChunk = false;
      this.spokenUpTo = chunk.nextIndex;
      const index = this.audioIndex++;
      const text = chunk.text;

      this.chain = this.chain.then(async () => {
        const audioBuffer = await this.synthesize(text);
        this.audioBuffers.push(audioBuffer);
        await emit({
          type: 'audio_chunk',
          index,
          text,
          audioBase64: audioBuffer.toString('base64'),
          format: 'mp3',
        });
      });
    }
  }

  flush(fullText: string, emit: StreamEmitter) {
    const tail = fullText.slice(this.spokenUpTo).trim();
    if (tail) {
      const index = this.audioIndex++;
      this.chain = this.chain.then(async () => {
        const audioBuffer = await this.synthesize(tail);
        this.audioBuffers.push(audioBuffer);
        await emit({
          type: 'audio_chunk',
          index,
          text: tail,
          audioBase64: audioBuffer.toString('base64'),
          format: 'mp3',
        });
      });
      this.spokenUpTo = fullText.length;
    }
    return this.chain;
  }

  private takeChunk(fullText: string): { text: string; nextIndex: number } | null {
    const remaining = fullText.slice(this.spokenUpTo);
    const threshold = this.isFirstChunk ? this.firstMinChars : this.minChars;
    if (remaining.length < threshold) return null;

    const sentenceEnd = remaining.search(/[.!?](?:\s|$)/);
    if (sentenceEnd >= 0) {
      const end = sentenceEnd + 1;
      if (this.isFirstChunk || end >= threshold) {
        return { text: remaining.slice(0, end).trim(), nextIndex: this.spokenUpTo + end + (remaining[end] === ' ' ? 1 : 0) };
      }
    }

    if (!this.isFirstChunk && remaining.length >= threshold) {
      const cutAt = remaining.lastIndexOf(' ', threshold + 20);
      const end = cutAt > threshold ? cutAt : threshold;
      return { text: remaining.slice(0, end).trim(), nextIndex: this.spokenUpTo + end };
    }

    return null;
  }
}

@Injectable()
export class HealthVoiceService {
  private readonly logger = new Logger(HealthVoiceService.name);
  private readonly openaiBase = 'https://api.openai.com/v1';
  private readonly openaiKey: string;

  private readonly TRANSCRIPTION_MODEL = 'whisper-1';
  private readonly CHAT_MODEL = 'gpt-4o-mini';
  private readonly TTS_MODEL = 'tts-1';
  private readonly TTS_VOICE = 'nova';
  /** First voice chunk: first sentence. Later chunks: ~5 seconds of speech. */
  private readonly TTS_FIRST_MIN_CHARS = 28;
  private readonly TTS_MIN_CHARS = 60;

  constructor(
    @InjectModel(Voice.name) private readonly voiceModel: Model<VoiceDocument>,
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    private readonly config: ConfigService,
    private readonly cloudinaryService: CloudinaryService,
  ) {
    this.openaiKey = this.config.getOrThrow<string>('OPENAI_API_KEY');
  }

  // ────────────────────────────────────────────────────────────
  //  PRIVATE: OpenAI helpers
  // ────────────────────────────────────────────────────────────

  private openaiHeaders(json = true): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.openaiKey}`,
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private buildVitalsText(vitals?: VitalsDto): string {
    if (!vitals) {
      return 'No separate vitals were submitted. Use any numbers the patient mentioned in their own words.';
    }

    const lines: string[] = [];
    const add = (label: string, value: unknown, unit = '') => {
      if (value !== undefined && value !== null && value !== '') {
        lines.push(`- ${label}: ${value}${unit}`);
      }
    };

    add('Blood Pressure', vitals.bloodPressure);
    add('Heart Rate', vitals.heartRate, ' bpm');
    add('SpO2', vitals.spo2, ' %');
    add('Glucose', vitals.glucose, ' mg/dL');
    add('Temperature', vitals.temperature);
    add('Weight', vitals.weight);
    if (vitals.notes?.trim()) lines.push(`- Notes: ${vitals.notes.trim()}`);

    return lines.length > 0
      ? lines.join('\n')
      : 'No separate vitals were submitted. Use any numbers the patient mentioned in their own words.';
  }

  private extractSymptomHints(transcription: string): string[] {
    const patterns: [RegExp, string][] = [
      [/chest pain|pain in (?:my )?chest/i, 'chest pain'],
      [/strong headache|severe headache|bad headache|headache|head ache|migraine/i, 'headache'],
      [/shortness of breath|difficulty breathing|trouble breathing|can'?t breathe/i, 'breathing difficulty'],
      [/dizz(?:y|iness)/i, 'dizziness'],
      [/nausea|vomiting/i, 'nausea/vomiting'],
      [/fever|chills/i, 'fever/chills'],
      [/fatigue|tired|exhausted/i, 'fatigue'],
      [/palpitations|racing heart/i, 'palpitations'],
      [/abdominal pain|stomach pain/i, 'abdominal pain'],
      [/back pain/i, 'back pain'],
      [/cough/i, 'cough'],
      [/faint(?:ing)?|passed out/i, 'fainting'],
    ];

    const found = new Set<string>();
    for (const [pattern, label] of patterns) {
      if (pattern.test(transcription)) found.add(label);
    }
    return [...found];
  }

  private buildClinicalContext(transcription: string, vitals?: VitalsDto) {
    const patientStatement = (transcription || '').trim() || 'No voice statement was captured.';
    const vitalsText = this.buildVitalsText(vitals);
    const symptomHints = this.extractSymptomHints(patientStatement);
    const hasUrgentSymptoms = /chest pain|difficulty breathing|can'?t breathe|stroke|face drooping|slurred speech|severe headache|passed out|fainting/i.test(
      patientStatement,
    );

    const symptomSection =
      symptomHints.length > 0
        ? symptomHints.map((s) => `- ${s}`).join('\n')
        : '- Review the patient statement and list every symptom they describe in your own words.';

    const userPrompt = `PATIENT STATEMENT (primary — treat as fact, quote symptoms back explicitly):
"${patientStatement}"

SYMPTOMS TO ADDRESS (extracted from patient words — discuss EACH one):
${symptomSection}

MEASURED VITALS (secondary context — do NOT ignore symptoms when vitals look normal):
${vitalsText}

${hasUrgentSymptoms ? 'URGENT SYMPTOM FLAG: Patient reported potentially serious symptoms. Elevate concern even if vitals are normal.\n' : ''}Integrate symptoms + vitals in your assessment. Normal heart rate or oxygen does NOT rule out chest pain, headache, or other serious problems.`;

    return { patientStatement, vitalsText, symptomHints, hasUrgentSymptoms, userPrompt };
  }

  private readonly CLINICAL_ANALYSIS_RULES = `CLINICAL RULES (follow strictly):
1. The patient's own words are the PRIMARY source. Name every symptom they report — never skip them.
2. NEVER say the statement is "unclear", "vague", or "non-specific" when the patient named concrete symptoms (e.g. headache, chest pain).
3. Vitals are supporting data only. Normal HR or SpO2 does NOT mean the patient is fine.
4. Always explain how reported symptoms and vitals fit together (e.g. "chest pain with HR 70 and SpO2 98% — vitals alone do not exclude cardiac causes").
5. Chest pain, severe headache, breathing difficulty, or stroke-like symptoms → overallStatus must be "warning" or "urgent", not "normal".
6. Give specific, actionable next steps — not generic wellness advice when symptoms are present.`;

  private buildSummaryPrompts(transcription: string, vitals?: VitalsDto) {
    const ctx = this.buildClinicalContext(transcription, vitals);

    const systemPrompt = `You are an advanced AI health analyst — like an experienced clinician giving a thorough assessment.

${this.CLINICAL_ANALYSIS_RULES}

Your job:
- Lead with what the patient REPORTED (symptoms first, then vitals).
- Identify concerning patterns in BOTH symptoms and vitals.
- Give specific recommendations and next steps.
- Be warm, direct, and thorough. Flag urgency clearly.

Return ONLY valid JSON, no markdown:
{
  "disclaimer"       : "Vital Signs AI is not a doctor. AI-generated suggestions are not medical advice or diagnosis.",
  "overallStatus"    : "normal | warning | urgent",
  "clinicalSummary"  : "3-5 sentences. Start by naming the patient's reported symptoms, then interpret vitals, then urgency.",
  "reportedSymptoms" : ["every symptom the patient named"],
  "symptomAnalysis"  : [{ "symptom": "name", "severity": "mild|moderate|severe", "interpretation": "string", "concern": "low|moderate|high" }],
  "vitalBreakdown"   : [{ "vital": "name", "value": "reading", "status": "normal|elevated|low|critical|not_provided", "interpretation": "string" }],
  "riskPatterns"     : ["string"],
  "predictiveFlags"  : ["string"],
  "recommendations"  : [{ "priority": "immediate|soon|routine", "action": "string", "reason": "string" }],
  "specialistAdvice" : "string",
  "supportMessage"   : "string",
  "urgentAlert"      : "string or null"
}`;

    const userPrompt = `${ctx.userPrompt}\n\nPerform a full health analysis. Symptoms first, vitals second.`;

    return { systemPrompt, userPrompt };
  }

  private buildQuickClinicalPrompts(transcription: string, vitals?: VitalsDto) {
    const ctx = this.buildClinicalContext(transcription, vitals);

    const systemPrompt = `You are an experienced clinician speaking directly to the patient.

${this.CLINICAL_ANALYSIS_RULES}

Respond in plain text only. No JSON, no markdown, no bullet points.

Format (exactly 3 sentences):
1. Start with: "The patient is presenting with" followed by EVERY symptom they named (e.g. strong headache and chest pain).
2. Explain how their vitals relate — note that normal readings do not rule out serious symptoms.
3. State urgency and one clear next step.

NEVER call the statement unclear if symptoms were named. Be fast, warm, and specific.`;

    const userPrompt = ctx.userPrompt;

    return { systemPrompt, userPrompt };
  }

  private buildFullAnalysisPrompts(transcription: string, vitals?: VitalsDto) {
    const ctx = this.buildClinicalContext(transcription, vitals);

    const systemPrompt = `You are an advanced clinical triage assistant preparing a concise doctor-facing assessment. Return ONLY valid JSON, no markdown.

${this.CLINICAL_ANALYSIS_RULES}

STYLE:
- Be clinical, structured, concise, and direct.
- Avoid long narrative paragraphs.
- Do not soften serious cases. If red flags exist, state urgency plainly.
- Keep differentialDiagnosis to 2-3 most likely possibilities, each with a one-line rationale.
- Actionable recommendations must include key questions the doctor should ask and checks/tests to consider.

Output fields in this exact order:

{
  "patientSummary"   : "2 short direct sentences for the patient. Plain language. Clearly state seriousness and what to do next.",
  "clinicalSummary"  : "1-2 concise doctor-facing sentences only.",
  "doctorAssessment" : {
    "chiefComplaint": "short phrase naming the main complaint in patient words",
    "keyFindings": ["abnormal vitals, reported symptoms, and red flags only"],
    "urgency": { "level": "normal | warning | urgent", "justification": "one short reason" },
    "differentialDiagnosis": [{ "condition": "string", "rationale": "one-line rationale" }],
    "actionableRecommendations": {
      "keyQuestions": ["specific question doctor should ask"],
      "clinicalChecks": ["specific exam/check/test/measurement to consider"],
      "nextSteps": ["specific immediate/soon/routine action"]
    }
  },
  "overallStatus"    : "normal | warning | urgent",
  "reportedSymptoms" : ["every symptom the patient explicitly mentioned"],
  "vitalBreakdown"   : [{ "vital": "name", "value": "reading", "status": "normal|elevated|low|critical|not_provided", "interpretation": "string" }],
  "recommendations"  : [{ "priority": "immediate|soon|routine", "action": "string", "reason": "string" }],
  "urgentAlert"      : "string or null",
  "disclaimer"       : "Vital Signs AI is not a doctor. AI-generated suggestions are not medical advice or diagnosis."
}`;

    const userPrompt = `${ctx.userPrompt}\n\nCreate the doctor-facing structured assessment and patient-facing message. Address every reported symptom.`;

    return { systemPrompt, userPrompt };
  }

  private isDismissiveClinicalText(text: string): boolean {
    return /\b(unclear|vague|unspecific|non-?specific|did not (?:specify|mention)|no symptoms(?: were)?(?: reported)?|unable to (?:determine|identify)|insufficient information|patient(?:'s)? statement is)\b/i.test(
      text,
    );
  }

  private applyClinicalSafetyOverrides(
    summary: Record<string, unknown>,
    transcription: string,
    symptomHints: string[],
  ): Record<string, unknown> {
    const statement = transcription.toLowerCase();
    const hasChestPain = /chest pain|pain in (?:my )?chest/.test(statement) || symptomHints.includes('chest pain');
    const hasSevereHeadache = /strong headache|severe headache|bad headache/.test(statement) || symptomHints.includes('headache');
    const hasBreathingIssue = /difficulty breathing|shortness of breath|can'?t breathe/.test(statement);

    if (hasChestPain || hasBreathingIssue) {
      summary.overallStatus = 'urgent';
      if (!summary.urgentAlert) {
        summary.urgentAlert =
          'Chest pain or breathing difficulty reported — seek emergency medical care immediately. Normal vitals do not rule out a serious cause.';
      }
    } else if (hasSevereHeadache && summary.overallStatus === 'normal') {
      summary.overallStatus = 'warning';
    }

    if (symptomHints.length > 0) {
      const existing = Array.isArray(summary.reportedSymptoms) ? (summary.reportedSymptoms as string[]) : [];
      summary.reportedSymptoms = [...new Set([...existing, ...symptomHints])];
    }

    const clinical = typeof summary.clinicalSummary === 'string' ? summary.clinicalSummary : '';
    if (clinical && this.isDismissiveClinicalText(clinical) && symptomHints.length > 0) {
      const symptomList = symptomHints.join(' and ');
      summary.clinicalSummary = `The patient is presenting with ${symptomList}. These reported symptoms require clinical attention and should not be dismissed because some vitals appear within normal limits. Please seek medical evaluation promptly, especially for chest pain or severe headache.`;
      summary.overallStatus = hasChestPain ? 'urgent' : 'warning';
    }

    return summary;
  }

  private pickBestClinicalSummary(quickText: string, fullSummary: Record<string, unknown>): string {
    const fullText = typeof fullSummary.clinicalSummary === 'string' ? fullSummary.clinicalSummary : '';

    if (fullText && !this.isDismissiveClinicalText(fullText)) {
      return fullText.length >= quickText.length * 0.7 ? fullText : quickText || fullText;
    }

    if (quickText && (!fullText || this.isDismissiveClinicalText(fullText))) {
      return quickText;
    }

    return fullText || quickText;
  }

  private getUrgencyLevel(summary: Record<string, unknown>, transcription: string): 'normal' | 'warning' | 'urgent' {
    const status = String(summary.overallStatus || '').toLowerCase();
    if (status === 'urgent' || status === 'warning' || status === 'normal') {
      return status;
    }

    const text = transcription.toLowerCase();
    if (/chest pain|pain in (?:my )?chest|difficulty breathing|shortness of breath|can'?t breathe|stroke|face drooping|slurred speech|passed out|fainting/.test(text)) {
      return 'urgent';
    }
    if (/severe headache|strong headache|bad headache|dizz(?:y|iness)|palpitations|fever/.test(text)) {
      return 'warning';
    }
    return 'normal';
  }

  private buildPatientSummary(
    summary: Record<string, unknown>,
    transcription: string,
    symptomHints: string[],
  ): string {
    const existing = typeof summary.patientSummary === 'string' ? summary.patientSummary.trim() : '';
    if (existing && !this.isDismissiveClinicalText(existing)) return existing;

    const urgency = this.getUrgencyLevel(summary, transcription);
    const symptoms = symptomHints.length
      ? symptomHints.join(' and ')
      : 'the symptoms you described';

    if (urgency === 'urgent') {
      return `Your symptoms (${symptoms}) may be serious. Please seek urgent medical care now or contact emergency services if symptoms are severe or worsening.`;
    }
    if (urgency === 'warning') {
      return `Your symptoms (${symptoms}) need medical attention soon. Please contact your doctor today and seek urgent help if they get worse.`;
    }
    return `Your readings do not show an obvious emergency, but your symptoms still matter. Monitor them closely and contact your doctor if they persist or worsen.`;
  }

  private buildDoctorAssessmentFallback(
    summary: Record<string, unknown>,
    transcription: string,
    vitals: VitalsDto | undefined,
    symptomHints: string[],
  ): Record<string, unknown> {
    const existing = summary.doctorAssessment;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      return existing as Record<string, unknown>;
    }

    const urgency = this.getUrgencyLevel(summary, transcription);
    const symptoms = symptomHints.length ? symptomHints : ['reported symptoms'];
    const vitalText = this.buildVitalsText(vitals);
    const keyFindings = [
      `Chief symptoms: ${symptoms.join(', ')}`,
      ...vitalText
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2)),
    ];

    const hasChestPain = /chest pain|pain in (?:my )?chest/i.test(transcription);
    const hasHeadache = /headache|migraine/i.test(transcription);

    const differentials: Array<Record<string, string>> = [];
    if (hasChestPain) {
      differentials.push(
        { condition: 'Acute coronary syndrome or cardiac chest pain', rationale: 'Chest pain requires exclusion of cardiac causes even with normal vitals.' },
        { condition: 'Musculoskeletal or reflux-related chest pain', rationale: 'Common non-cardiac causes remain possible after urgent causes are excluded.' },
      );
    }
    if (hasHeadache) {
      differentials.push({ condition: 'Primary headache or migraine', rationale: 'Headache is reported; characterize severity, onset, and neurologic symptoms.' });
    }
    if (differentials.length === 0) {
      differentials.push(
        { condition: 'Benign self-limited illness', rationale: 'No specific red-flag diagnosis is clear from available data.' },
        { condition: 'Early evolving condition', rationale: 'Symptoms may progress and should be reassessed if persistent.' },
      );
    }

    return {
      chiefComplaint: symptoms.join(', '),
      keyFindings,
      urgency: {
        level: urgency,
        justification:
          urgency === 'urgent'
            ? 'Reported red-flag symptoms require immediate clinical assessment.'
            : urgency === 'warning'
              ? 'Symptoms need timely evaluation and monitoring for progression.'
              : 'No red flags identified from provided symptoms and vitals.',
      },
      differentialDiagnosis: differentials.slice(0, 3),
      actionableRecommendations: {
        keyQuestions: [
          'When did symptoms start and are they worsening?',
          'Any associated shortness of breath, dizziness, fainting, neurologic deficit, fever, or severe pain?',
          'Any relevant cardiac, neurologic, diabetes, medication, or pregnancy history?',
        ],
        clinicalChecks: [
          'Repeat full vital signs and pain score.',
          hasChestPain ? 'Consider ECG and urgent chest pain evaluation.' : 'Perform focused exam based on chief complaint.',
          hasHeadache ? 'Check neurologic status and red flags for severe/new headache.' : 'Assess for red flags and symptom progression.',
        ],
        nextSteps:
          urgency === 'urgent'
            ? ['Escalate for urgent medical evaluation now.']
            : urgency === 'warning'
              ? ['Arrange same-day or soon clinical follow-up.']
              : ['Provide routine guidance and return precautions.'],
      },
    };
  }

  private normalizeAssessmentSummary(
    summary: Record<string, unknown>,
    transcription: string,
    vitals: VitalsDto | undefined,
    symptomHints: string[],
  ): Record<string, unknown> {
    const normalized = { ...summary };
    const urgency = this.getUrgencyLevel(normalized, transcription);
    normalized.overallStatus = urgency;
    normalized.patientSummary = this.buildPatientSummary(normalized, transcription, symptomHints);
    normalized.doctorAssessment = this.buildDoctorAssessmentFallback(normalized, transcription, vitals, symptomHints);

    const doctor = normalized.doctorAssessment as Record<string, any>;
    const doctorUrgency = doctor.urgency && typeof doctor.urgency === 'object' ? doctor.urgency : {};
    doctor.urgency = {
      ...doctorUrgency,
      level: urgency,
      justification:
        doctorUrgency.justification ||
        (urgency === 'urgent'
          ? 'Reported red-flag symptoms require immediate clinical assessment.'
          : urgency === 'warning'
            ? 'Symptoms require timely review.'
            : 'No immediate red flags identified.'),
    };

    if (!Array.isArray(normalized.recommendations) || normalized.recommendations.length === 0) {
      const actionable = doctor.actionableRecommendations as Record<string, unknown> | undefined;
      const nextSteps = Array.isArray(actionable?.nextSteps) ? actionable.nextSteps : [];
      normalized.recommendations = nextSteps.map((step) => ({
        priority: urgency === 'urgent' ? 'immediate' : urgency === 'warning' ? 'soon' : 'routine',
        action: String(step),
        reason: doctor.urgency.justification,
      }));
    }

    return normalized;
  }

  private parseSummaryJson(raw: string): Record<string, unknown> {
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      return JSON.parse(clean);
    } catch {
      return { rawResponse: raw };
    }
  }

  private extractClinicalSummaryFromPartialJson(buffer: string): string {
    const match = buffer.match(/"clinicalSummary"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!match?.[1]) return '';
    return match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }


  private async saveAudioBuffersToFile(buffers: Buffer[]): Promise<string> {
    const outputDir = path.join(process.cwd(), 'uploads/audio');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const filePath = path.join(outputDir, `summary-${Date.now()}.mp3`);
    const merged = Buffer.concat(buffers.map((b) => new Uint8Array(b)));
    await fs.promises.writeFile(filePath, new Uint8Array(merged));
    return filePath;
  }

  private async transcribeAudio(filePath: string, originalName: string): Promise<string> {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename: originalName || 'audio.mp3' });
    form.append('model', this.TRANSCRIPTION_MODEL);
    form.append('response_format', 'json');
    form.append('language', 'en');
    form.append(
      'prompt',
      'Patient describing symptoms and vitals: headache, chest pain, heart rate, oxygen level, blood pressure, dizziness, fatigue.',
    );

    const res = await fetch(`${this.openaiBase}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        ...(form.getHeaders ? form.getHeaders() : {}),
      },
      body: form as any,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new InternalServerErrorException(`OpenAI transcription failed: ${err}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text;
  }

  private async synthesizeSpeechMp3(text: string): Promise<Buffer> {
    const res = await fetch(`${this.openaiBase}/audio/speech`, {
      method: 'POST',
      headers: this.openaiHeaders(),
      body: JSON.stringify({
        model: this.TTS_MODEL,
        voice: this.TTS_VOICE,
        input: text,
        response_format: 'mp3',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new InternalServerErrorException(`OpenAI TTS failed: ${err}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  private async saveSpeechToFile(text: string): Promise<string> {
    const outputDir = path.join(process.cwd(), 'uploads/audio');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fileName = `summary-${Date.now()}.mp3`;
    const filePath = path.join(outputDir, fileName);
    const buffer = await this.synthesizeSpeechMp3(text);
    await fs.promises.writeFile(filePath, new Uint8Array(buffer));
    return filePath;
  }

  private async *streamOpenAIChat(
    systemPrompt: string,
    userPrompt: string,
    maxTokens = 1500,
    temperature = 0.6,
  ): AsyncGenerator<string> {
    const res = await fetch(`${this.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: this.openaiHeaders(),
      body: JSON.stringify({
        model: this.CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new InternalServerErrorException(`OpenAI LLM failed: ${err}`);
    }

    let leftover = '';
    const body = res.body as NodeJS.ReadableStream | null;
    if (!body) return;

    for await (const chunk of body) {
      leftover += chunk.toString();
      const lines = leftover.split('\n');
      leftover = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore malformed SSE chunks
        }
      }
    }
  }

  private async generateHealthSummary(transcription: string, vitals?: VitalsDto): Promise<Record<string, unknown>> {
    const { systemPrompt, userPrompt } = this.buildSummaryPrompts(transcription, vitals);

    const res = await fetch(`${this.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: this.openaiHeaders(),
      body: JSON.stringify({
        model: this.CHAT_MODEL,
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
      throw new InternalServerErrorException(`OpenAI LLM failed: ${err}`);
    }

    const data = (await res.json()) as any;
    const raw: string = data.choices[0].message.content.trim();
    const summary = this.parseSummaryJson(raw);
    const ctx = this.buildClinicalContext(transcription, vitals);
    const safeSummary = this.applyClinicalSafetyOverrides(summary, transcription, ctx.symptomHints);
    return this.normalizeAssessmentSummary(safeSummary, transcription, vitals, ctx.symptomHints);
  }

  private async streamHealthSummary(
    transcription: string,
    vitals: VitalsDto | undefined,
    emit: StreamEmitter,
  ): Promise<{ summary: Record<string, unknown> }> {
    const ctx = this.buildClinicalContext(transcription, vitals);
    const immediatePatientSummary = this.buildPatientSummary({}, transcription, ctx.symptomHints);
    const immediateUrgency = this.getUrgencyLevel({}, transcription);
    await emit({
      type: 'patient_summary_ready',
      patientSummary: immediatePatientSummary,
      urgencyLevel: immediateUrgency,
    });

    const fullSummary = await this.streamFullAnalysis(transcription, vitals, emit);
    const safeSummary = this.applyClinicalSafetyOverrides(fullSummary, transcription, ctx.symptomHints);
    const normalizedSummary = this.normalizeAssessmentSummary(safeSummary, transcription, vitals, ctx.symptomHints);
    const finalClinical =
      typeof normalizedSummary.clinicalSummary === 'string'
        ? normalizedSummary.clinicalSummary
        : String(normalizedSummary.patientSummary || immediatePatientSummary);
    const finalPatientSummary = String(normalizedSummary.patientSummary || immediatePatientSummary);
    const doctorAssessment =
      normalizedSummary.doctorAssessment && typeof normalizedSummary.doctorAssessment === 'object'
        ? (normalizedSummary.doctorAssessment as Record<string, unknown>)
        : {};
    const urgencyLevel = this.getUrgencyLevel(normalizedSummary, transcription);

    normalizedSummary.clinicalSummary = finalClinical;
    normalizedSummary.patientSummary = finalPatientSummary;
    normalizedSummary.doctorAssessment = doctorAssessment;

    await emit({
      type: 'patient_summary_ready',
      patientSummary: finalPatientSummary,
      urgencyLevel,
    });
    await emit({ type: 'clinical_summary_ready', clinicalSummary: finalClinical });
    await emit({ type: 'doctor_assessment_ready', doctorAssessment });
    await emit({
      type: 'recommendations_ready',
      recommendations: Array.isArray(normalizedSummary.recommendations)
        ? normalizedSummary.recommendations
        : [],
    });
    await emit({ type: 'summary_complete', summary: normalizedSummary });
    return { summary: normalizedSummary };
  }

  /** Fast plain-text stream — symptoms first, ~1-2s */
  private async streamQuickClinicalSnapshot(
    transcription: string,
    vitals: VitalsDto | undefined,
    emit: StreamEmitter,
  ): Promise<string> {
    const { systemPrompt, userPrompt } = this.buildQuickClinicalPrompts(transcription, vitals);
    const ctx = this.buildClinicalContext(transcription, vitals);
    await emit({ type: 'quick_summary_start' });

    let fullText = '';
    for await (const delta of this.streamOpenAIChat(systemPrompt, userPrompt, 220, 0.35)) {
      fullText += delta;
      await emit({ type: 'summary_chunk', text: delta, isCumulative: false });
      await emit({ type: 'clinical_summary_delta', delta, fullText });
    }

    const trimmed = fullText.trim();
    if (trimmed && this.isDismissiveClinicalText(trimmed) && ctx.symptomHints.length > 0) {
      const fallback = `The patient is presenting with ${ctx.symptomHints.join(' and ')}. Although heart rate and oxygen levels may appear within normal limits, these symptoms still require medical attention — especially chest pain and severe headache. Please seek evaluation promptly.`;
      await emit({ type: 'summary_chunk', text: fallback, isCumulative: false });
      await emit({ type: 'clinical_summary_delta', delta: fallback, fullText: fallback });
      return fallback;
    }

    return trimmed;
  }

  /** Full structured JSON — runs in parallel, clinicalSummary field first in prompt */
  private async streamFullAnalysis(
    transcription: string,
    vitals: VitalsDto | undefined,
    emit: StreamEmitter,
  ): Promise<Record<string, unknown>> {
    const { systemPrompt, userPrompt } = this.buildFullAnalysisPrompts(transcription, vitals);

    let fullText = '';
    let clinicalSummary = '';

    for await (const delta of this.streamOpenAIChat(systemPrompt, userPrompt, 850, 0.45)) {
      fullText += delta;

      const nextClinical = this.extractClinicalSummaryFromPartialJson(fullText);
      if (nextClinical.length > clinicalSummary.length && !this.isDismissiveClinicalText(nextClinical)) {
        const clinicalDelta = nextClinical.slice(clinicalSummary.length);
        clinicalSummary = nextClinical;
        await emit({ type: 'summary_chunk', text: clinicalDelta, isCumulative: false });
        await emit({ type: 'clinical_summary_delta', delta: clinicalDelta, fullText: clinicalSummary });
      }
    }

    const summary = this.parseSummaryJson(fullText);
    const ctx = this.buildClinicalContext(transcription, vitals);
    return this.applyClinicalSafetyOverrides(summary, transcription, ctx.symptomHints);
  }

  private async createSummaryAudio(
    clinicalText: string,
  ): Promise<{ audioUrl: string; cloudinaryName: string } | null> {
    const text = clinicalText.trim();
    if (!text) return null;

    const audioPath = await this.saveSpeechToFile(text);
    try {
      const data: any = await this.cloudinaryService.uploadFile(audioPath);
      return {
        audioUrl: data.url,
        cloudinaryName: data.name,
      };
    } finally {
      fs.unlink(audioPath, () => {});
    }
  }

  // ────────────────────────────────────────────────────────────
  //  PUBLIC: Service methods
  // ────────────────────────────────────────────────────────────

  /** POST /voice/upload — transcribe and store */
  async uploadVoice(file: Express.Multer.File, req: any): Promise<{ voiceId: string; transcription: string; createdAt: string; userId: string }> {
    this.logger.log(`Transcribing: ${file.originalname}`);

    let transcription: string;
    try {
      transcription = await this.transcribeAudio(file.path, file.originalname);
    } finally {
      fs.unlink(file.path, () => {});
    }

    const createdAt = new Date().toISOString();

    const createVoice = await this.voiceModel.create({
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [],
      latestSummary: null,
      userId: req?.user?._id,
    });

    this.logger.log(`Transcribed [${createVoice._id}]: "${transcription.slice(0, 80)}..."`);
    return { voiceId: createVoice._id.toString(), transcription, createdAt, userId: req?.user?._id };
  }

  /** GET /voice/:voiceId */
  async getVoice(voiceId: string) {
    const records = await this.voiceModel.aggregate([
      {
        $match: {
          $expr: {
            $eq: [new mongoose.Types.ObjectId(voiceId), '$_id'],
          },
        },
      },
      {
        $lookup: {
          from: 'transcriptions',
          let: { voiceId: '$_id' },
          as: 'voiceDetails',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$$voiceId', '$voice'],
                },
              },
            },
            {
              $lookup: {
                from: 'users',
                let: { doctorId: '$doctor' },
                as: 'doctor',
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $eq: ['$$doctorId', '$_id'],
                      },
                    },
                  },
                  {
                    $project: {
                      _id: 1,
                      name: 1,
                      email: 1,
                    },
                  },
                ],
              },
            },
            {
              $unwind: {
                path: '$doctor',
                preserveNullAndEmptyArrays: true,
              },
            },
          ],
        },
      },
      {
        $unwind: {
          path: '$voiceDetails',
          preserveNullAndEmptyArrays: true,
        },
      },
    ]);

    const record = records?.[0];

    if (!record) throw new NotFoundException(`Voice record not found: ${voiceId}`);

    return {
      voiceId: record._id,
      _id: record._id,
      filename: record.filename,
      transcription: record.transcription,
      createdAt: record.createdAt,
      latestSummary: {
        ...record.latestSummary,
        audioUrl:
          'http://res.cloudinary.com/' +
          process.env.CLOUDINARY_CLOUD_NAME +
          '/video/upload/' +
          record.latestSummary.audioUrl,
      },
      voiceDetails: record.voiceDetails,
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

      const summary = await this.generateHealthSummary(record.transcription, vitals);
      const clinicalText = typeof summary.clinicalSummary === 'string' ? summary.clinicalSummary : '';
      const audioUrl = await this.saveSpeechToFile(clinicalText);

      const generatedAt = new Date().toISOString();
      const data: any = await this.cloudinaryService.uploadFile(audioUrl);

      const summaryEntry = {
        vitals: vitals ?? null,
        summary,
        audioUrl: data.name,
        generatedAt,
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
        voiceId,
        transcription: record.transcription,
        summary: {
          ...summary,
          audioUrl: data.url,
        },
        generatedAt,
      };
    } catch (error) {
      throw error;
    }
  }

  /** POST /summary/stream — live SSE summary + TTS chunks */
  async streamCreateSummary(voiceId: string, vitals: VitalsDto | undefined, emit: StreamEmitter) {
    const startedAt = Date.now();
    await emit({ type: 'started', voiceId, stage: 'summary_stream' });

    const record = await this.voiceModel.findById(voiceId).select('transcription').lean();
    if (!record) throw new NotFoundException(`No voice record found for voiceId: ${voiceId}`);

    await emit({ type: 'progress', stage: 'voice_loaded', elapsedMs: Date.now() - startedAt });
    await emit({ type: 'transcription_start' });
    await emit({ type: 'transcription_ready', transcription: record.transcription });
    await emit({ type: 'transcription', text: record.transcription });

    const { summary } = await this.streamHealthSummary(record.transcription, vitals, emit);
    const generatedAt = new Date().toISOString();
    await emit({ type: 'progress', stage: 'summary_ready', elapsedMs: Date.now() - startedAt });

    const summaryEntry = {
      vitals: vitals ?? null,
      summary,
      audioUrl: null,
      generatedAt,
    };

    await this.voiceModel.updateOne(
      { _id: voiceId },
      {
        $push: { summaries: summaryEntry },
        $set: { latestSummary: summaryEntry },
      },
    );
    await emit({ type: 'progress', stage: 'text_summary_saved', elapsedMs: Date.now() - startedAt });

    const clinicalSummary = typeof summary.clinicalSummary === 'string' ? summary.clinicalSummary : '';
    const patientSummary = typeof summary.patientSummary === 'string' ? summary.patientSummary : clinicalSummary;
    const doctorAssessment =
      summary.doctorAssessment && typeof summary.doctorAssessment === 'object'
        ? (summary.doctorAssessment as Record<string, unknown>)
        : {};
    const recommendations = Array.isArray(summary.recommendations)
      ? summary.recommendations
      : [];
    const urgencyLevel = this.getUrgencyLevel(summary, record.transcription);

    await emit({
      type: 'done',
      voiceId,
      transcription: record.transcription,
      summary,
      patientSummary,
      clinicalSummary,
      doctorAssessment,
      recommendations,
      urgencyLevel,
      generatedAt,
      audioPending: true,
      data: {
        voiceId,
        transcription: record.transcription,
        summary,
        patientSummary,
        clinicalSummary,
        doctorAssessment,
        recommendations,
        urgencyLevel,
        generatedAt,
        audioPending: true,
      },
    });

    let audioUrl: string | undefined;
    let cloudinaryName: string | undefined;
    try {
      await emit({ type: 'audio_start' });
      const audio = await this.createSummaryAudio(patientSummary);
      if (audio) {
        audioUrl = audio.audioUrl;
        cloudinaryName = audio.cloudinaryName;
        await this.voiceModel.updateOne(
          { _id: voiceId, 'summaries.generatedAt': generatedAt },
          {
            $set: {
              'summaries.$.audioUrl': cloudinaryName,
              'latestSummary.audioUrl': cloudinaryName,
            },
          },
        );
        await emit({ type: 'audio_ready', audioUrl });
      }
    } catch (error: any) {
      this.logger.warn(`[summary/stream] Audio generation failed: ${error?.message || error}`);
      await emit({ type: 'error', message: 'Text summary is ready, but audio generation failed.' });
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
      audioUrl:
        'http://res.cloudinary.com/' +
        process.env.CLOUDINARY_CLOUD_NAME +
        '/video/upload/' +
        item.audioUrl,
    }));

    record.latestSummary = {
      ...record.latestSummary,
      vitals: record.latestSummary?.vitals ?? null,
      summary: record.latestSummary?.summary!,
      generatedAt: record.latestSummary?.generatedAt ?? '',
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
      fs.unlink(file.path, () => {});
    }

    const createdAt = new Date().toISOString();
    const summary: any = await this.generateHealthSummary(transcription, vitals);
    const clinicalText = typeof summary.clinicalSummary === 'string' ? summary.clinicalSummary : '';
    const audioUrl = await this.saveSpeechToFile(clinicalText);
    const data: any = await this.cloudinaryService.uploadFile(audioUrl);
    summary.audioUrl = data?.name;

    const generatedAt = new Date().toISOString();
    const summaryEntry = { vitals: vitals ?? null, summary, generatedAt };

    const createVoice = await this.voiceModel.create({
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [summaryEntry],
      latestSummary: summaryEntry,
    });
    fs.unlinkSync(audioUrl);
    this.logger.log(`[analyze] Generating summary for [${createVoice?._id}]`);

    return {
      voiceId: createVoice._id.toString(),
      transcription,
      vitals: vitals ?? 'not provided',
      summary,
      generatedAt,
    };
  }

  /** POST /analyze/stream — live SSE transcription + summary + TTS chunks */
  async streamAnalyze(file: Express.Multer.File, vitals: VitalsDto | undefined, emit: StreamEmitter) {
    const startedAt = Date.now();
    this.logger.log(`[analyze/stream] Transcribing: ${file.originalname}`);

    await emit({ type: 'started', stage: 'analyze_stream' });
    await emit({ type: 'transcription_start' });

    let transcription: string;
    try {
      transcription = await this.transcribeAudio(file.path, file.originalname);
    } finally {
      fs.unlink(file.path, () => {});
    }

    await emit({ type: 'transcription_ready', transcription });
    await emit({ type: 'transcription', text: transcription });
    await emit({ type: 'progress', stage: 'transcription_ready', elapsedMs: Date.now() - startedAt });

    const createdAt = new Date().toISOString();
    const { summary } = await this.streamHealthSummary(transcription, vitals, emit);
    const generatedAt = new Date().toISOString();
    await emit({ type: 'progress', stage: 'summary_ready', elapsedMs: Date.now() - startedAt });

    const summaryEntry = {
      vitals: vitals ?? null,
      summary,
      generatedAt,
      audioUrl: null,
    };

    const createVoice = await this.voiceModel.create({
      filename: file.originalname,
      transcription,
      createdAt,
      summaries: [summaryEntry],
      latestSummary: summaryEntry,
    });

    await emit({ type: 'progress', stage: 'text_summary_saved', elapsedMs: Date.now() - startedAt });

    const clinicalSummary = typeof summary.clinicalSummary === 'string' ? summary.clinicalSummary : '';
    const patientSummary = typeof summary.patientSummary === 'string' ? summary.patientSummary : clinicalSummary;
    const doctorAssessment =
      summary.doctorAssessment && typeof summary.doctorAssessment === 'object'
        ? (summary.doctorAssessment as Record<string, unknown>)
        : {};
    const recommendations = Array.isArray(summary.recommendations)
      ? summary.recommendations
      : [];
    const urgencyLevel = this.getUrgencyLevel(summary, transcription);

    await emit({
      type: 'done',
      voiceId: createVoice._id.toString(),
      transcription,
      summary,
      patientSummary,
      clinicalSummary,
      doctorAssessment,
      recommendations,
      urgencyLevel,
      generatedAt,
      audioPending: true,
      data: {
        voiceId: createVoice._id.toString(),
        transcription,
        summary,
        patientSummary,
        clinicalSummary,
        doctorAssessment,
        recommendations,
        urgencyLevel,
        generatedAt,
        audioPending: true,
      },
    });

    let audioUrl: string | undefined;
    let cloudinaryName: string | undefined;
    try {
      await emit({ type: 'audio_start' });
      const audio = await this.createSummaryAudio(patientSummary);
      if (audio) {
        audioUrl = audio.audioUrl;
        cloudinaryName = audio.cloudinaryName;
        await this.voiceModel.updateOne(
          { _id: createVoice._id, 'summaries.generatedAt': generatedAt },
          {
            $set: {
              'summaries.$.audioUrl': cloudinaryName,
              'latestSummary.audioUrl': cloudinaryName,
            },
          },
        );
        await emit({ type: 'audio_ready', audioUrl });
      }
    } catch (error: any) {
      this.logger.warn(`[analyze/stream] Audio generation failed: ${error?.message || error}`);
      await emit({ type: 'error', message: 'Text summary is ready, but audio generation failed.' });
    }
  }
}
