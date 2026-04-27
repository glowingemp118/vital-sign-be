import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { finalRes, paginationPipeline } from 'src/utils/dbUtils';
import { ChatBotMessage } from './schemas/message.schema';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ChatBotService {
    private readonly groqBase = 'https://api.groq.com/openai/v1';
    private readonly groqKey: string;
    constructor(
        @InjectModel(ChatBotMessage.name) private chatBotModel: Model<ChatBotMessage>,
        private readonly config: ConfigService,
    ) {

        this.groqKey = this.config.getOrThrow<string>('GROQ_API_KEY');
    }


    async fetchMessages(req: any, query: any) {

        const { pageno = 1, limit = 10, search } = query;

        const userId = new mongoose.Types.ObjectId(req.user._id);

        const qry: any = {
            $and: [{ userId }]
        }
        if (search) {
            qry['$or'] = [
                { message: { $regex: search, $options: 'i' } },
                { aiReply: { $regex: search, $options: 'i' } }
            ]
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

            const history = await this.chatBotModel
                .find({ userId })
                .sort({ createdAt: 1 })
                .limit(3);

            const res = await fetch(`${this.groqBase}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.groqKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        {
                            role: "system",
                            content:
                                "You are a helpful healthcare assistant. Provide general advice only.",
                        },
                        ...history?.map((item: any) => ({
                            role: "user",
                            content: item.message,
                        })),
                        {
                            role: "user",
                            content: message,
                        },
                    ],
                }),
            });

            if (!res.ok) {
                const err = await res.text();
                throw new InternalServerErrorException(`Groq chat failed: ${err}`);
            }

            const data = await res.json();

            return await this.chatBotModel.create({
                userId: new mongoose.Types.ObjectId(req.user._id),
                message,
                aiReply: data.choices[0].message.content
            })

        } catch (err: any) {
            throw new Error(err?.message);
        }
    }
}