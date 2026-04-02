import {
    Controller,
    Get,
    Post,
    Query,
    Request
} from '@nestjs/common';
import { Access } from '../../decorators/public.decorator';
import { UserType } from '../../user/dto/user.dto';
import { TranscriptionService } from '../services/transcription.services';
@Controller('transcription')
export class TranscriptionController {
    constructor(private readonly transcriptionService: TranscriptionService) { }

    @Post('/')
    @Access(UserType.User)
    async create(@Request() req) {
        return await this.transcriptionService.createTranscription(req);
    }

    @Get('/')
    @Access(UserType.Admin, UserType.Doctor)
    getTranscription(@Query() query) {
        return this.transcriptionService.getTranscription({ ...query });
    }

    @Get("/:id")
    @Access(UserType.Admin, UserType.Doctor)
    getTranscriptionById(@Request() req) {
        return this.transcriptionService.getTranscriptionBy(req);
    }
}
