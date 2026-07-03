import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { diskStorage } from 'multer';
import * as path from 'path';
import { Response } from 'express';
import { CreateSummaryDto } from './dto/create-summary.dto';
import { VitalsDto } from './dto/upload-voice.dto';
import { HealthStreamEvent, HealthVoiceService } from './health-voice.service';
import { SkipInterceptor } from 'src/decorators/skip-interceptor.decorator';

const audioStorage = diskStorage({
  destination: './uploads',
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const audioFileFilter = (_req: any, file: Express.Multer.File, cb: any) => {
  const allowed = [
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm',
    'audio/ogg', 'audio/flac', 'audio/x-m4a', 'video/mp4',
  ];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new BadRequestException(`Unsupported audio type: ${file.mimetype}`), false);
  }
};

@ApiTags('HealthVoice')
@Controller('')
export class HealthVoiceController {
  constructor(
    private readonly healthVoiceService: HealthVoiceService
    
  ) { }

  // ── GET /api/health ─────────────────────────────────────────
  @Get('health')
  @ApiOperation({ summary: 'Health check ping' })
  @ApiResponse({ status: 200, description: 'Server is running' })
  healthCheck() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  // ── POST /api/voice/upload ───────────────────────────────────
  @Post('voice/upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload audio → transcribe and store' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: { type: 'string', format: 'binary', description: 'Audio file (mp3/mp4/wav/webm/ogg/flac/m4a)' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Returns voiceId + transcription' })

  @UseInterceptors(FileInterceptor('audio', {
    storage: audioStorage,
    fileFilter: audioFileFilter,
    limits: { fileSize: 25 * 1024 * 1024 },
  }))
  async uploadVoice(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request
  ) {

    if (!file) throw new BadRequestException('No audio file uploaded.');

    return this.healthVoiceService.uploadVoice(file, req);
  }

  // ── GET /api/voice ───────────────────────────────────────────
  @Get('voice')
  @ApiOperation({ summary: 'List all voice records' })
  @ApiResponse({ status: 200, description: 'Returns paginated voice list' })
  async listVoices(@Req() req: Request) {
    return this.healthVoiceService.listVoices(req);
  }

  // ── GET /api/voice/:voiceId ──────────────────────────────────
  @Get('voice/:voiceId')
  @ApiOperation({ summary: 'Get a single voice record by ID' })
  @ApiParam({ name: 'voiceId', example: 'voice_1234567890_abc12' })
  @ApiResponse({ status: 200, description: 'Voice record with latest summary' })
  @ApiResponse({ status: 404, description: 'Voice record not found' })
  async getVoice(@Param('voiceId') voiceId: string) {
    return this.healthVoiceService.getVoice(voiceId);
  }

  // ── DELETE /api/voice/:voiceId ───────────────────────────────
  @Delete('voice/:voiceId')
  @ApiOperation({ summary: 'Delete a voice record' })
  @ApiParam({ name: 'voiceId', example: 'voice_1234567890_abc12' })
  @ApiResponse({ status: 200, description: 'Voice record deleted' })
  @ApiResponse({ status: 404, description: 'Voice record not found' })
  async deleteVoice(@Param('voiceId') voiceId: string) {
    return this.healthVoiceService.deleteVoice(voiceId);
  }

  // ── POST /api/summary ────────────────────────────────────────
  @Post('summary')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate health summary for existing voice record' })
  @ApiBody({ type: CreateSummaryDto })
  @ApiResponse({ status: 201, description: 'Generated health summary' })
  @ApiResponse({ status: 404, description: 'Voice record not found' })
  async createSummary(@Body() dto: CreateSummaryDto) {
    return this.healthVoiceService.createSummary(dto.voiceId, dto.vitals);
  }

  // ── POST /api/summary/stream ─────────────────────────────────
  @Post('summary/stream')
  @SkipInterceptor()
  @ApiOperation({ summary: 'Live SSE: stream health summary + ~5s voice chunks' })
  @ApiBody({ type: CreateSummaryDto })
  async streamSummary(@Body() dto: CreateSummaryDto, @Res() res: Response) {
    this.setupSse(res);
    try {
      await this.healthVoiceService.streamCreateSummary(dto.voiceId, dto.vitals, (event) =>
        this.writeSse(res, event),
      );
    } catch (error: any) {
      this.writeSse(res, { type: 'error', message: error?.message || 'Stream failed' });
    } finally {
      res.end();
    }
  }

  // ── GET /api/summary/:voiceId ────────────────────────────────
  @Get('summary/:voiceId')
  @ApiOperation({ summary: 'Get all summaries for a voice record' })
  @ApiParam({ name: 'voiceId', example: 'voice_1234567890_abc12' })
  @ApiResponse({ status: 200, description: 'Latest summary + history' })
  @ApiResponse({ status: 404, description: 'Voice record not found' })
  async getSummaries(@Param('voiceId') voiceId: string) {
    return this.healthVoiceService.getSummaries(voiceId);
  }

  // ── POST /api/analyze ────────────────────────────────────────
  @Post('analyze')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'One-shot: upload audio + optional vitals → full analysis' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: { type: 'string', format: 'binary', description: 'Audio file' },
        vitals: {
          type: 'string',
          description: 'JSON string of vitals, e.g. {"bloodPressure":"145/95","heartRate":72}',
          example: '{"bloodPressure":"145/95","heartRate":72,"spo2":98,"glucose":110}',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Full analysis result' })

  @UseInterceptors(FileInterceptor('audio', {
    storage: audioStorage,
    fileFilter: audioFileFilter,
    limits: { fileSize: 25 * 1024 * 1024 },
  }))
  async analyze(
    @UploadedFile() file: Express.Multer.File,
    @Body('vitals') vitalsRaw?: string,
  ) {
    let vitals: VitalsDto | undefined;
    if (vitalsRaw) {
      try {
        vitals = JSON.parse(vitalsRaw);
      } catch {
        throw new BadRequestException('vitals must be a valid JSON string.');
      }
    }
    return this.healthVoiceService.analyze(file, vitals);
  }

  // ── POST /api/analyze/stream ─────────────────────────────────
  @Post('analyze/stream')
  @SkipInterceptor()
  @ApiOperation({ summary: 'Live SSE: transcribe + stream summary + ~5s voice chunks' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: { type: 'string', format: 'binary', description: 'Audio file' },
        vitals: {
          type: 'string',
          description: 'JSON string of vitals',
          example: '{"bloodPressure":"145/95","heartRate":72,"spo2":98,"glucose":110}',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: audioStorage,
      fileFilter: audioFileFilter,
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async streamAnalyze(
    @UploadedFile() file: Express.Multer.File,
    @Body('vitals') vitalsRaw: string | undefined,
    @Res() res: Response,
  ) {
    if (!file) throw new BadRequestException('No audio file uploaded.');

    let vitals: VitalsDto | undefined;
    if (vitalsRaw) {
      try {
        vitals = JSON.parse(vitalsRaw);
      } catch {
        throw new BadRequestException('vitals must be a valid JSON string.');
      }
    }

    this.setupSse(res);
    try {
      await this.healthVoiceService.streamAnalyze(file, vitals, (event) => this.writeSse(res, event));
    } catch (error: any) {
      this.writeSse(res, { type: 'error', message: error?.message || 'Stream failed' });
    } finally {
      res.end();
    }
  }

  private setupSse(res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  private writeSse(res: Response, event: HealthStreamEvent) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  }
}
