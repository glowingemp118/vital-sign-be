import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { VitalsDto } from './upload-voice.dto';

export class CreateSummaryDto {
  @ApiProperty({ example: 'voice_1234567890_abc12' })
  @IsString()
  @IsNotEmpty()
  voiceId: string;

  @ApiPropertyOptional({ type: VitalsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => VitalsDto)
  vitals?: VitalsDto;
}
