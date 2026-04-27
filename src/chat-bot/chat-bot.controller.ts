import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
    Req
} from '@nestjs/common';
import { ChatBotService } from './chat-bot.service';
import { Access } from 'src/decorators/public.decorator';
import { UserType } from 'src/user/dto/user.dto';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('chat-bot')
export class ChatBotController {
    constructor(private readonly chatBotService: ChatBotService) { }

    // 🔹 Fetch messages with  chat bot
    @Get()
    @ApiBearerAuth()
    @Access(UserType.User)
    @HttpCode(HttpStatus.OK)
    fetchMessages(@Req() req: Request, @Query() query: any) {
        return this.chatBotService.fetchMessages(req, query);
    }

    // 🔹 Send a message to chat bot
    @Post()
    @ApiBearerAuth()
    @Access(UserType.User)
    @HttpCode(HttpStatus.CREATED)
    sendMessage(@Req() req: Request) {
        return this.chatBotService.sendMessage(req);
    }

}