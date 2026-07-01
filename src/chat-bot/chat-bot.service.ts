import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';
import { ChatBotMessage } from './schemas/message.schema';
import { ConfigService } from '@nestjs/config';

const systemPrompt = `You are Vital Signs Assistant, the AI healthcare assistant for the “Vital Signs” project.

Provide clear, supportive, and easy-to-understand general health information focused on vital signs, wellness, and symptom awareness.

Rules:
- Always respond as “Vital Signs Assistant”.
- Provide educational guidance only, not medical diagnoses, prescriptions, or treatment plans.
- Keep responses calm, concise, empathetic, and easy to understand.
- Explain medical or health terms in simple language.
- Encourage users to consult healthcare professionals for medical concerns.
- If symptoms may be serious, urgent, or life-threatening (such as chest pain, heart pain, difficulty breathing, fainting, stroke symptoms, or severe bleeding), clearly advise immediate medical attention or emergency services.
- Never provide misleading, dangerous, or overly certain medical advice.
- When users describe symptoms, acknowledge their concern first, then provide safe general guidance.`;

@Injectable()
export class ChatBotService {
  private readonly openaiBase = 'https://api.openai.com/v1';
  private readonly openaiKey: string;

  constructor(
    @InjectModel(ChatBotMessage.name) private chatBotModel: Model<ChatBotMessage>,
    private readonly config: ConfigService,
  ) {
    this.openaiKey = this.config.getOrThrow<string>('OPENAI_API_KEY');
  }

  async fetchMessages(req: any, query: any) {
    const { pageno = 1, limit = 10, search } = query;

    const userId = new mongoose.Types.ObjectId(req.user._id);

    const qry: any = {
      $and: [{ userId }],
    };
    if (search) {
      qry['$or'] = [
        { message: { $regex: search, $options: 'i' } },
        { aiReply: { $regex: search, $options: 'i' } },
      ];
    }

    const pipeline: any[] = [{ $match: qry }];

    if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit }));

    const data: any = await this.chatBotModel.aggregate(pipeline);

    const res = finalRes({ pageno, limit, data });

    return res;
  }

  async sendMessage(req: any) {
    try {
      const { message } = req.body;

      const userId = new mongoose.Types.ObjectId(req.user._id);

      const history = await this.chatBotModel.find({ userId }).sort({ createdAt: 1 }).limit(3);

      const res = await fetch(`${this.openaiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            ...history?.map((item: any) => ({
              role: 'user',
              content: item.message,
            })),
            {
              role: 'user',
              content: message,
            },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new InternalServerErrorException(`OpenAI chat failed: ${err}`);
      }

      const data = await res.json();

      return await this.chatBotModel.create({
        userId: new mongoose.Types.ObjectId(req.user._id),
        message,
        aiReply: data.choices[0].message.content,
      });
    } catch (err: any) {
      throw new Error(err?.message);
    }
  }
}
