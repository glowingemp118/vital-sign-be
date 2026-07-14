import { IsOptional, IsString } from 'class-validator';

export class DeviceTokensDto {
  @IsOptional()
  @IsString()
  device_type?: string;

  @IsOptional()
  @IsString()
  device_id?: string;

  @IsOptional()
  @IsString()
  voip_token?: string;
}
