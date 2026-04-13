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
import { ApiBearerAuth } from '@nestjs/swagger';
@Controller('transcription')
export class TranscriptionController {
    constructor(private readonly transcriptionService: TranscriptionService) { }

    @Post('/')
    @Access(UserType.User)
    async create(@Request() req: any) {
        return await this.transcriptionService.createTranscription(req);
    }

    @Get('/')
     @ApiBearerAuth()
    getTranscription(@Request() req: any) {
        return this.transcriptionService.getTranscription({ ...req.query, user: req.user });
    }

    @Get("/:id")
     @ApiBearerAuth()
    getTranscriptionById(@Request() req:any) {
        return this.transcriptionService.getTranscriptionBy(req);
    }
}
