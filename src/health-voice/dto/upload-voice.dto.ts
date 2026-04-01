import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class VitalsDto {
  @ApiPropertyOptional({ example: '145/95' })
  @IsOptional()
  @IsString()
  bloodPressure?: string;

  @ApiPropertyOptional({ example: 72 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  heartRate?: number;

  @ApiPropertyOptional({ example: 98 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  spo2?: number;

  @ApiPropertyOptional({ example: 110 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  glucose?: number;

  @ApiPropertyOptional({ example: '98.6 F' })
  @IsOptional()
  @IsString()
  temperature?: string;

  @ApiPropertyOptional({ example: '70 kg' })
  @IsOptional()
  @IsString()
  weight?: string;

  @ApiPropertyOptional({ example: 'Patient reports fatigue' })
  @IsOptional()
  @IsString()
  notes?: string;
}
