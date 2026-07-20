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
  | { type: 'patient_summary_ready'; patientMessage: string; patientSummary: string; urgencyLevel: string }
  | { type: 'clinical_summary_ready'; clinicalSummary: string }
  | { type: 'doctor_assessment_ready'; doctorAssessment: Record<string, unknown> }
  | { type: 'recommendations_ready'; recommendations: unknown[] }
  | { type: 'audio_chunk'; index: number; text: string; audioBase64: string; format: 'mp3' }
  | { type: 'audio_start' }
  | { type: 'audio_ready'; audioUrl: string }
  | { type: 'summary_complete'; summary: Record<string, unknown> }
  | { type: 'done'; voiceId: string; transcription: string; summary: Record<string, unknown>; patientMessage: string; patientSummary: string; clinicalSummary: string; doctorAssessment: Record<string, unknown>; recommendations: unknown[]; urgencyLevel: string; generatedAt: string; audioUrl?: string; audioPending?: boolean; data?: Record<string, unknown> }
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
      [/strong headache|severe headache|bad headache/i, 'severe headache'],
      [/headache|head ache|migraine/i, 'headache'],
      [/shortness of breath|difficulty breathing|trouble breathing|can'?t breathe/i, 'breathing difficulty'],
      [/sore throat|throat pain|pain in (?:my )?throat|scratchy throat/i, 'sore throat'],
      [/difficulty swallowing|trouble swallowing|can'?t swallow|painful swallowing/i, 'difficulty swallowing'],
      [/swollen lymph node|swollen gland|neck swelling/i, 'swollen lymph nodes'],
      [/runny nose|stuffy nose|nasal congestion|congestion/i, 'nasal congestion'],
      [/body ache|body pain|muscle ache|muscle pain/i, 'body aches'],
      [/ear pain|earache/i, 'ear pain'],
      [/dizz(?:y|iness)/i, 'dizziness'],
      [/nausea|vomiting/i, 'nausea/vomiting'],
      [/fever|chills/i, 'fever/chills'],
      [/fatigue|tired|exhausted/i, 'fatigue'],
      [/palpitations|racing heart/i, 'palpitations'],
      [/abdominal pain|stomach pain/i, 'abdominal pain'],
      [/back pain/i, 'back pain'],
      [/cough/i, 'cough'],
      [/rash|skin redness|hives/i, 'rash'],
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
    const hasUrgentSymptoms = /chest pain|pain in (?:my )?chest|difficulty breathing|can'?t breathe|stroke|face drooping|slurred speech|severe headache|passed out|fainting/i.test(
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
5. Chest pain, severe headache, breathing difficulty, fainting, stroke-like symptoms, very low BP, SpO2 below 92%, extreme heart rate, or critically abnormal glucose → overallStatus must be "urgent".
6. For urgent cases, the patient message must be unmistakable but guidance-based: say this may be serious and that speaking with a medical professional as soon as possible may be advisable.
7. Doctor content must be clinical and specific: explain why each differential is plausible, name red flags, and list concrete checks/tests/questions — not generic "follow up" advice.`;

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
- Keep symptoms and vital readings in separate fields: keyFindings for symptoms/red flags, keyReadings for abnormal/critical vitals.
- Keep differentialDiagnosis to 2-3 most likely possibilities, each with a clinically meaningful rationale tied to symptoms/vitals/red flags.
- Urgency justification must mention the specific trigger(s), e.g. chest pain, severe headache, hypotension, low SpO2, abnormal glucose.
- Actionable recommendations must include concrete key questions, focused exam items, repeat measurements, and tests/checks to consider.
- For chest pain, include ACS/cardiac cause until excluded and recommend ECG/vitals/red-flag assessment.
- For severe headache, include neurologic red flags and consider acute neurologic causes if sudden/severe or with deficits.
- For very low BP, mention hypotension/shock risk and immediate reassessment.

Output fields in this exact order:

{
  "patientSummary"   : "Plain-language patient guidance. Explain why the situation may or may not be serious, mention critical vitals, and use guidance wording such as may be advisable or consider speaking with. Do not give direct medical orders.",
  "clinicalSummary"  : "1-2 concise doctor-facing sentences only.",
  "doctorAssessment" : {
    "chiefComplaint": "short phrase naming the main complaint in patient words",
    "keyFindings": ["reported symptoms and clinical red flags only — do not mix vital values here"],
    "keyReadings": ["abnormal or critical vitals only, e.g. Blood pressure very low (60/30)"],
    "urgency": { "level": "normal | warning | urgent", "justification": "one short reason" },
    "differentialDiagnosis": [{ "condition": "string", "rationale": "specific rationale tied to this patient's symptoms/vitals" }],
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
          'Chest pain or breathing difficulty reported — speaking with a medical professional as soon as possible may be advisable. Normal vitals do not rule out a serious cause.';
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
      summary.clinicalSummary = `The patient is presenting with ${symptomList}. These reported symptoms require clinical attention and should not be dismissed because some vitals appear within normal limits. Medical evaluation may be advisable, especially for chest pain or severe headache.`;
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
    const text = transcription.toLowerCase();

    // Backend-enforced red flags override any soft model output.
    if (
      /chest pain|pain in (?:my )?chest|difficulty breathing|shortness of breath|can'?t breathe|stroke|face drooping|slurred speech|passed out|fainting/.test(text) ||
      this.getAbnormalVitalFindings((summary as any).__vitals).some((v) => v.severity === 'critical')
    ) {
      return 'urgent';
    }

    if (status === 'urgent' || status === 'warning' || status === 'normal') {
      return status;
    }

    if (/severe headache|strong headache|bad headache|dizz(?:y|iness)|palpitations|fever/.test(text)) {
      return 'warning';
    }
    return 'normal';
  }

  private parseBloodPressure(value?: string): { systolic?: number; diastolic?: number } {
    const match = String(value || '').match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
    if (!match) return {};
    return {
      systolic: Number(match[1]),
      diastolic: Number(match[2]),
    };
  }

  private getAbnormalVitalFindings(vitals?: VitalsDto): Array<{
    vital: string;
    value: string;
    severity: 'warning' | 'critical';
    finding: string;
  }> {
    if (!vitals) return [];
    const findings: Array<{
      vital: string;
      value: string;
      severity: 'warning' | 'critical';
      finding: string;
    }> = [];

    const bp = this.parseBloodPressure(vitals.bloodPressure);
    if (bp.systolic || bp.diastolic) {
      const value = `${bp.systolic ?? '?'}/${bp.diastolic ?? '?'}`;
      if ((bp.systolic !== undefined && bp.systolic < 90) || (bp.diastolic !== undefined && bp.diastolic < 60)) {
        findings.push({
          vital: 'Blood Pressure',
          value,
          severity: 'critical',
          finding: `Very low blood pressure (${value}) raises concern for hypotension, poor perfusion, dehydration, bleeding, sepsis, or shock depending on context.`,
        });
      } else if ((bp.systolic !== undefined && bp.systolic >= 140) || (bp.diastolic !== undefined && bp.diastolic >= 90)) {
        findings.push({
          vital: 'Blood Pressure',
          value,
          severity: 'warning',
          finding: `Elevated blood pressure (${value}) may increase cardiovascular risk and should be rechecked.`,
        });
      }
    }

    if (typeof vitals.spo2 === 'number' && vitals.spo2 < 92) {
      findings.push({
        vital: 'SpO2',
        value: `${vitals.spo2}%`,
        severity: 'critical',
        finding: `Low oxygen saturation (${vitals.spo2}%) requires urgent assessment for respiratory or circulatory compromise.`,
      });
    }

    if (typeof vitals.heartRate === 'number' && (vitals.heartRate < 50 || vitals.heartRate > 120)) {
      findings.push({
        vital: 'Heart Rate',
        value: `${vitals.heartRate} bpm`,
        severity: vitals.heartRate < 40 || vitals.heartRate > 140 ? 'critical' : 'warning',
        finding: `Abnormal heart rate (${vitals.heartRate} bpm) should be interpreted with symptoms and repeated.`,
      });
    }

    if (typeof vitals.glucose === 'number' && (vitals.glucose < 70 || vitals.glucose > 250)) {
      findings.push({
        vital: 'Glucose',
        value: `${vitals.glucose} mg/dL`,
        severity: vitals.glucose < 54 || vitals.glucose > 300 ? 'critical' : 'warning',
        finding: `Abnormal glucose (${vitals.glucose} mg/dL) may require prompt correction and clinical review.`,
      });
    }

    return findings;
  }

  private buildPatientSummary(
    summary: Record<string, unknown>,
    transcription: string,
    symptomHints: string[],
  ): string {
    const urgency = this.getUrgencyLevel(summary, transcription);
    const vitals = (summary as any).__vitals as VitalsDto | undefined;
    const abnormalVitals = this.getAbnormalVitalFindings(vitals);
    const criticalVitals = this.getAbnormalVitalFindings(vitals).filter((v) => v.severity === 'critical');
    const patientSymptoms = this.collectPatientSymptoms(summary, symptomHints);
    const readingVitals = urgency === 'urgent' ? criticalVitals : abnormalVitals;
    const reportedSection = this.formatPatientSymptomSection(patientSymptoms);
    const readingsSection = this.formatPatientReadingsSection(readingVitals);
    const disclaimer =
      'This is an AI-generated summary. It is not a medical diagnosis, treatment recommendation, or substitute for professional medical care. Consider consulting a qualified healthcare provider for personalized advice.';

    if (urgency === 'urgent') {
      return [
        'This may indicate a potentially serious situation.',
        reportedSection,
        ...(readingsSection ? [readingsSection] : []),
        'What this could mean:\n\nYour body may not be receiving enough blood flow or oxygen, or there may be stress on the heart, brain, circulation, breathing, or blood sugar systems. These signs can be associated with serious medical issues.',
        [
          'What to consider:',
          '',
          '• Remaining at home without medical evaluation may carry risks.',
          '• Speaking with a medical professional as soon as possible may be advisable.',
          '• If symptoms worsen, calling emergency services could be an option to consider.',
          '• If you feel weak, dizzy, short of breath, confused, or the pain is severe, arranging transportation rather than driving yourself may be prudent.',
        ].join('\n'),
        disclaimer,
      ].join('\n\n');
    }
    if (urgency === 'warning') {
      return [
        this.buildPatientWarningLead(patientSymptoms),
        reportedSection,
        ...(readingsSection ? [readingsSection] : []),
        'What this could mean:\n\nThis does not clearly look like an emergency from the information provided, but these symptoms or readings can worsen or may need professional review.',
        [
          'What to consider:',
          '',
          '• Speaking with a medical professional today may be advisable.',
          '• Rechecking your vitals if available may help.',
          '• If pain, breathing trouble, dizziness, weakness, confusion, fainting, or worsening symptoms develop, considering urgent medical evaluation or emergency services may be appropriate.',
        ].join('\n'),
        disclaimer,
      ].join('\n\n');
    }

    return [
      'This does not show an obvious emergency right now based on the symptoms and vitals provided.',
      reportedSection,
      ...(readingsSection ? [readingsSection] : []),
      'What this could mean:\n\nNo critical red flags were detected from the information provided. Still, symptoms can change over time, and your personal medical history matters.',
      [
        'What to consider:',
        '',
        '• Continuing to monitor how you feel may be reasonable.',
        '• Rechecking your vitals if available may help.',
        '• If symptoms persist, worsen, or feel unusual for you, consider speaking with a medical professional.',
      ].join('\n'),
      disclaimer,
    ].join('\n\n');
  }

  private collectPatientSymptoms(summary: Record<string, unknown>, symptomHints: string[]): string[] {
    const symptoms = new Set<string>();
    const addSymptoms = (items: unknown) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const value = String(item || '').trim();
        if (!value) continue;
        const extracted = this.extractSymptomHints(value);
        if (extracted.length > 0) {
          for (const symptom of extracted) symptoms.add(symptom.toLowerCase());
        } else {
          symptoms.add(value.toLowerCase());
        }
      }
    };

    addSymptoms(symptomHints);
    addSymptoms(summary.reportedSymptoms);

    const doctor = summary.doctorAssessment;
    if (doctor && typeof doctor === 'object' && !Array.isArray(doctor)) {
      const chiefComplaint = String((doctor as Record<string, unknown>).chiefComplaint || '');
      addSymptoms(this.extractSymptomHints(chiefComplaint));
    }

    return this.normalizePatientSymptoms([...symptoms]);
  }

  private normalizePatientSymptoms(symptoms: string[]): string[] {
    const normalized = [...new Set(symptoms.map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (normalized.includes('severe headache')) {
      const index = normalized.indexOf('headache');
      if (index >= 0) normalized.splice(index, 1);
    }
    return normalized;
  }

  private buildPatientWarningLead(symptoms: string[]): string {
    const warningSigns = new Set<string>();

    if (symptoms.includes('sore throat') || symptoms.includes('difficulty swallowing') || symptoms.includes('swollen lymph nodes')) {
      warningSigns.add('fever');
      warningSigns.add('difficulty swallowing');
      warningSigns.add('swollen lymph nodes');
      warningSigns.add('breathing trouble');
    }
    if (symptoms.includes('headache') || symptoms.includes('severe headache')) {
      warningSigns.add('a severe or unusual headache');
      warningSigns.add('vision changes');
      warningSigns.add('weakness');
      warningSigns.add('confusion');
    }
    if (symptoms.includes('cough') || symptoms.includes('breathing difficulty')) {
      warningSigns.add('breathing trouble');
      warningSigns.add('chest pain');
      warningSigns.add('fever');
      warningSigns.add('low oxygen readings');
    }
    if (symptoms.includes('abdominal pain') || symptoms.includes('nausea/vomiting')) {
      warningSigns.add('worsening pain');
      warningSigns.add('ongoing vomiting');
      warningSigns.add('fever');
      warningSigns.add('signs of dehydration');
    }
    if (symptoms.includes('dizziness') || symptoms.includes('fatigue') || symptoms.includes('fainting')) {
      warningSigns.add('fainting');
      warningSigns.add('confusion');
      warningSigns.add('weakness');
      warningSigns.add('symptoms that are getting worse');
    }

    if (warningSigns.size === 0) {
      warningSigns.add('symptoms becoming severe');
      warningSigns.add('new symptoms appearing');
      warningSigns.add('abnormal readings');
    }

    return `This may need medical attention soon, especially if you develop ${this.formatPatientList([...warningSigns].slice(0, 6))}.`;
  }

  private formatPatientList(items: string[]): string {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
  }

  private formatPatientSymptomSection(symptomHints: string[]): string {
    const symptoms = this.normalizePatientSymptoms(symptomHints);
    const bullets =
      symptoms.length > 0
        ? symptoms.map((symptom) => `• ${this.toPatientLabel(symptom)}`).join('\n')
        : '• No specific symptoms were provided.';
    return `You reported:\n\n${bullets}`;
  }

  private formatPatientReadingsSection(
    vitals: Array<{ vital: string; value: string; severity: 'warning' | 'critical'; finding: string }>,
  ): string {
    if (!vitals.length) return '';
    const bullets = vitals.map((vital) => `• ${this.formatPatientVitalBullet(vital)}`).join('\n');
    return `Key readings:\n\n${bullets}`;
  }

  private formatPatientReportedItems(
    symptomHints: string[],
    vitals: Array<{ vital: string; value: string; severity: 'warning' | 'critical'; finding: string }>,
  ): string {
    const symptoms = this.normalizePatientSymptoms(symptomHints);
    const symptomBullets = symptoms.map((symptom) => `• ${this.toPatientLabel(symptom)}`);
    const vitalBullets = vitals.map((vital) => `• ${this.formatPatientVitalBullet(vital)}`);
    const bullets = [...symptomBullets, ...vitalBullets];
    return bullets.length > 0 ? bullets.join('\n') : '• No specific symptoms or critical vital signs were provided.';
  }

  private toPatientLabel(value: string): string {
    return value
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private formatPatientVitalBullet(vital: { vital: string; value: string; severity: 'warning' | 'critical'; finding: string }): string {
    if (vital.vital === 'Blood Pressure' && vital.severity === 'critical') return `Blood pressure very low (${vital.value})`;
    if (vital.vital === 'Blood Pressure') return `Blood pressure elevated (${vital.value})`;
    if (vital.vital === 'SpO2') return `Oxygen level low (${vital.value})`;
    if (vital.vital === 'Heart Rate') return `Heart rate abnormal (${vital.value})`;
    if (vital.vital === 'Glucose') return `Glucose abnormal (${vital.value})`;
    return `${vital.vital} abnormal (${vital.value})`;
  }

  private formatPatientSymptoms(symptomHints: string[]): string {
    const symptoms = [...new Set(symptomHints.filter(Boolean))];
    if (symptoms.includes('severe headache')) {
      const index = symptoms.indexOf('headache');
      if (index >= 0) symptoms.splice(index, 1);
    }
    if (symptoms.length === 0) return '';
    if (symptoms.length === 1) return symptoms[0];
    return `${symptoms.slice(0, -1).join(', ')} and ${symptoms[symptoms.length - 1]}`;
  }

  private formatPatientVitalReason(
    vitals: Array<{ vital: string; value: string; severity: 'warning' | 'critical'; finding: string }>,
  ): string {
    const parts = vitals.map((v) => {
      if (v.vital === 'Blood Pressure' && v.severity === 'critical') {
        return `your blood pressure is very low (${v.value}), which can mean your body may not be getting enough blood flow`;
      }
      if (v.vital === 'Blood Pressure') {
        return `your blood pressure is elevated (${v.value}), which should be rechecked`;
      }
      if (v.vital === 'SpO2') {
        return `your oxygen level is low (${v.value}), which can mean your body is not getting enough oxygen`;
      }
      if (v.vital === 'Heart Rate') {
        return `your heart rate is abnormal (${v.value}), which should be interpreted with your symptoms`;
      }
      if (v.vital === 'Glucose' && v.severity === 'critical') {
        return `your glucose is critically abnormal (${v.value}), which can affect alertness and body function`;
      }
      if (v.vital === 'Glucose') {
        return `your glucose is abnormal (${v.value}), which may need correction or review`;
      }
      return `your ${v.vital.toLowerCase()} is abnormal (${v.value})`;
    });

    if (parts.length === 1) {
      return `One important reason is that ${parts[0]}.`;
    }
    return `The main reasons are that ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
  }

  private buildDoctorAssessmentFallback(
    summary: Record<string, unknown>,
    transcription: string,
    vitals: VitalsDto | undefined,
    symptomHints: string[],
  ): Record<string, unknown> {
    const urgency = this.getUrgencyLevel(summary, transcription);
    const symptoms = symptomHints.length ? symptomHints : ['reported symptoms'];
    const abnormalVitals = this.getAbnormalVitalFindings(vitals);
    const keyFindings = symptoms.map((symptom) => this.toPatientLabel(symptom));
    const keyReadings = abnormalVitals.map((v) => this.formatPatientVitalBullet(v));

    const hasChestPain = /chest pain|pain in (?:my )?chest/i.test(transcription);
    const hasHeadache = /headache|migraine/i.test(transcription);
    const hasSevereHeadache = /severe headache|strong headache|bad headache/i.test(transcription);
    const hasLowBp = abnormalVitals.some((v) => v.vital === 'Blood Pressure' && v.severity === 'critical');
    const hasLowSpo2 = abnormalVitals.some((v) => v.vital === 'SpO2' && v.severity === 'critical');

    const differentials: Array<Record<string, string>> = [];
    if (hasChestPain) {
      differentials.push(
        { condition: 'Acute coronary syndrome / cardiac chest pain', rationale: 'Chest pain is a red flag; ACS must be excluded even if HR or SpO2 appear normal.' },
        { condition: 'Pulmonary embolism or acute cardiopulmonary cause', rationale: 'Chest pain with any dyspnea, low SpO2, tachycardia, syncope, or hypotension would raise concern for a cardiopulmonary emergency.' },
      );
    }
    if (hasSevereHeadache) {
      differentials.push({ condition: 'Secondary headache / acute neurologic cause', rationale: 'Severe or sudden headache requires screening for neurologic deficits, meningismus, hypertensive emergency, hemorrhage, or other secondary causes.' });
    } else if (hasHeadache) {
      differentials.push({ condition: 'Primary headache or migraine', rationale: 'Headache is reported; characterize onset, severity, triggers, associated symptoms, and neurologic red flags.' });
    }
    if (hasLowBp) {
      differentials.unshift({ condition: 'Hypotension / shock physiology', rationale: 'Very low blood pressure may indicate dehydration, bleeding, sepsis, medication effect, arrhythmia, or other poor-perfusion state and needs immediate repeat assessment.' });
    }
    if (hasLowSpo2) {
      differentials.unshift({ condition: 'Hypoxemic respiratory or cardiopulmonary process', rationale: 'SpO2 below 92% requires urgent evaluation for respiratory compromise, pneumonia/asthma/COPD exacerbation, PE, or cardiac cause.' });
    }
    if (differentials.length === 0) {
      differentials.push(
        { condition: 'Early evolving acute illness', rationale: 'Symptoms may precede objective abnormalities; reassess if persistent or worsening.' },
        { condition: 'Benign self-limited condition', rationale: 'Possible if symptoms remain mild, vitals stay normal, and no red flags emerge.' },
      );
    }

    const fallback = {
      chiefComplaint: symptoms.join(', '),
      keyFindings: keyFindings.length ? keyFindings : ['No specific symptoms reported'],
      keyReadings: keyReadings.length ? keyReadings : ['No abnormal vital readings provided'],
      urgency: {
        level: urgency,
        justification: this.buildUrgencyJustification(urgency, symptoms, abnormalVitals),
      },
      differentialDiagnosis: differentials.slice(0, 3),
      actionableRecommendations: {
        keyQuestions: [
          'Exact onset, duration, progression, severity score, and whether symptoms are new or different from usual?',
          'Any shortness of breath, sweating, nausea/vomiting, syncope, dizziness, weakness, confusion, neurologic deficit, fever, trauma, or severe/worst-ever pain?',
          'Relevant history: cardiac disease, hypertension, diabetes, clotting risk, pregnancy, medications, anticoagulants, stimulant use, recent infection, dehydration, or bleeding?',
        ],
        clinicalChecks: [
          'Repeat and confirm full vital signs manually, including BP in both arms if chest pain or hypotension is present; assess orthostatics if safe.',
          'Assess general appearance, perfusion, mental status, respiratory effort, hydration status, capillary refill, and pain severity.',
          hasChestPain ? 'Obtain/arrange ECG promptly, assess chest pain features, cardiac risk factors, and consider troponin/emergency chest pain pathway.' : 'Perform focused examination based on chief complaint and red flags.',
          hasHeadache ? 'Perform focused neurologic exam; check sudden onset, worst headache, neck stiffness, visual symptoms, weakness/numbness, speech changes, and papilledema red flags.' : 'Screen for neurologic, cardiopulmonary, infectious, and metabolic red flags as appropriate.',
          hasLowBp ? 'If BP remains low, evaluate for shock: repeat BP, pulse pressure, volume status, bleeding, sepsis signs, medication causes, arrhythmia, and need for urgent IV fluids/ED transfer.' : 'Trend vitals and compare against baseline if available.',
          hasLowSpo2 ? 'Repeat SpO2 with good waveform; assess lungs, oxygen requirement, and need for urgent respiratory/cardiopulmonary workup.' : 'Confirm pulse oximetry if symptoms suggest respiratory compromise.',
        ],
        nextSteps:
          urgency === 'urgent'
            ? ['Escalate to urgent/emergency evaluation now; do not manage as routine telehealth if red flags persist.']
            : urgency === 'warning'
              ? ['Arrange same-day clinical review or close follow-up with clear escalation precautions.']
              : ['Provide routine guidance, symptom monitoring, and return precautions.'],
      },
    };

    const existing = summary.doctorAssessment;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return fallback;
    }

    const current = existing as Record<string, any>;
    const currentActions = current.actionableRecommendations || {};
    return {
      chiefComplaint: current.chiefComplaint || fallback.chiefComplaint,
      keyFindings: this.mergeStringArrays(
        this.filterDoctorSymptomFindings(current.keyFindings),
        fallback.keyFindings,
      ),
      keyReadings: this.mergeStringArrays(
        current.keyReadings || this.filterDoctorVitalFindings(current.keyFindings),
        fallback.keyReadings,
      ),
      urgency: {
        level: urgency,
        justification: current.urgency?.justification && String(current.urgency.justification).length > 90
          ? current.urgency.justification
          : fallback.urgency.justification,
      },
      differentialDiagnosis: this.mergeDifferentials(current.differentialDiagnosis, fallback.differentialDiagnosis),
      actionableRecommendations: {
        keyQuestions: this.mergeStringArrays(currentActions.keyQuestions, fallback.actionableRecommendations.keyQuestions),
        clinicalChecks: this.mergeStringArrays(currentActions.clinicalChecks, fallback.actionableRecommendations.clinicalChecks),
        nextSteps: this.mergeStringArrays(currentActions.nextSteps, fallback.actionableRecommendations.nextSteps),
      },
    };
  }

  private filterDoctorSymptomFindings(items: unknown): string[] {
    if (!Array.isArray(items)) return [];
    return items
      .map(String)
      .filter((item) => !this.looksLikeVitalFinding(item));
  }

  private filterDoctorVitalFindings(items: unknown): string[] {
    if (!Array.isArray(items)) return [];
    return items
      .map(String)
      .filter((item) => this.looksLikeVitalFinding(item));
  }

  private looksLikeVitalFinding(text: string): boolean {
    return /blood pressure|heart rate|spo2|oxygen|glucose|bp\b|bpm|mg\/dl|%/i.test(text);
  }

  private buildUrgencyJustification(
    urgency: 'normal' | 'warning' | 'urgent',
    symptoms: string[],
    abnormalVitals: Array<{ vital: string; value: string; severity: 'warning' | 'critical'; finding: string }>,
  ): string {
    const criticalVitals = abnormalVitals.filter((v) => v.severity === 'critical');
    const symptomText = symptoms.filter(Boolean).join(', ');
    const vitalText = criticalVitals.map((v) => `${v.vital} ${v.value}`).join(', ');

    if (urgency === 'urgent') {
      const triggers = [symptomText, vitalText].filter(Boolean).join('; ');
      return `Urgent because the patient has red-flag features (${triggers || 'reported symptoms/abnormal vitals'}) that could represent an acute cardiopulmonary, neurologic, shock, or metabolic process and require immediate assessment.`;
    }
    if (urgency === 'warning') {
      const warningVitals = abnormalVitals.map((v) => `${v.vital} ${v.value}`).join(', ');
      return `Warning because symptoms${warningVitals ? ` and abnormal vitals (${warningVitals})` : ''} need timely clinical review and monitoring for progression.`;
    }
    return 'Routine urgency because no immediate red flags are identified from the submitted symptoms and vitals, but symptoms should still be monitored.';
  }

  private mergeStringArrays(primary: unknown, fallback: unknown): string[] {
    const fromPrimary = Array.isArray(primary) ? primary.map(String) : [];
    const fromFallback = Array.isArray(fallback) ? fallback.map(String) : [];
    const cleaned = [...fromPrimary, ...fromFallback]
      .map((v) => v.trim())
      .filter(Boolean);
    return [...new Set(cleaned)].slice(0, 10);
  }

  private mergeDifferentials(primary: unknown, fallback: unknown): Array<Record<string, string>> {
    const normalize = (items: unknown): Array<Record<string, string>> =>
      Array.isArray(items)
        ? items
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const obj = item as Record<string, unknown>;
              const condition = String(obj.condition || '').trim();
              const rationale = String(obj.rationale || '').trim();
              if (!condition) return null;
              return { condition, rationale };
            })
            .filter(Boolean) as Array<Record<string, string>>
        : [];

    const merged: Array<Record<string, string>> = [];
    for (const item of [...normalize(primary), ...normalize(fallback)]) {
      if (merged.some((existing) => existing.condition.toLowerCase() === item.condition.toLowerCase())) continue;
      merged.push(item);
      if (merged.length >= 3) break;
    }
    return merged;
  }

  private normalizeAssessmentSummary(
    summary: Record<string, unknown>,
    transcription: string,
    vitals: VitalsDto | undefined,
    symptomHints: string[],
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...summary, __vitals: vitals };
    const urgency = this.getUrgencyLevel(normalized, transcription);
    normalized.overallStatus = urgency;
    normalized.patientSummary = this.buildPatientSummary(normalized, transcription, symptomHints);
    normalized.patientMessage = normalized.patientSummary;
    normalized.doctorAssessment = this.buildDoctorAssessmentFallback(normalized, transcription, vitals, symptomHints);
    delete (normalized as any).__vitals;

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
    const immediateContext = { __vitals: vitals } as Record<string, unknown>;
    const immediatePatientSummary = this.buildPatientSummary(immediateContext, transcription, ctx.symptomHints);
    const immediateUrgency = this.getUrgencyLevel(immediateContext, transcription);
    await emit({
      type: 'patient_summary_ready',
      patientMessage: immediatePatientSummary,
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
    normalizedSummary.patientMessage = finalPatientSummary;
    normalizedSummary.doctorAssessment = doctorAssessment;

    const normalizeStreamText = (value: string) => value.replace(/\s+/g, ' ').trim();
    if (normalizeStreamText(finalPatientSummary) !== normalizeStreamText(immediatePatientSummary) || urgencyLevel !== immediateUrgency) {
      await emit({
        type: 'patient_summary_ready',
        patientMessage: finalPatientSummary,
        patientSummary: finalPatientSummary,
        urgencyLevel,
      });
    }
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
      const fallback = `The patient is presenting with ${ctx.symptomHints.join(' and ')}. Although heart rate and oxygen levels may appear within normal limits, these symptoms still require medical attention — especially chest pain and severe headache. Medical evaluation may be advisable.`;
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

    for await (const delta of this.streamOpenAIChat(systemPrompt, userPrompt, 1100, 0.35)) {
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
      const patientText =
        typeof summary.patientMessage === 'string'
          ? summary.patientMessage
          : typeof summary.patientSummary === 'string'
            ? summary.patientSummary
            : clinicalText;
      const audioUrl = await this.saveSpeechToFile(patientText);

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
    const patientMessage =
      typeof summary.patientMessage === 'string'
        ? summary.patientMessage
        : typeof summary.patientSummary === 'string'
          ? summary.patientSummary
          : clinicalSummary;
    const patientSummary = patientMessage;
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
      patientMessage,
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
        patientMessage,
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
    const patientText =
      typeof summary.patientMessage === 'string'
        ? summary.patientMessage
        : typeof summary.patientSummary === 'string'
          ? summary.patientSummary
          : clinicalText;
    const audioUrl = await this.saveSpeechToFile(patientText);
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
    const patientMessage =
      typeof summary.patientMessage === 'string'
        ? summary.patientMessage
        : typeof summary.patientSummary === 'string'
          ? summary.patientSummary
          : clinicalSummary;
    const patientSummary = patientMessage;
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
      patientMessage,
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
        patientMessage,
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
