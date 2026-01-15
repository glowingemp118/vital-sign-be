import {
  IsEmail,
  IsString,
  IsEnum,
  MinLength,
  IsOptional,
  IsNumber,
  IsArray,
} from 'class-validator';

export enum UserType {
  Admin = 0,
  User = 1,
  Doctor = 2,
  Guest = 3,
}

export class SignInDto {
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password should be at least 6 characters' })
  password: string;

  @IsOptional()
  @IsString()
  device_id?: string;
  @IsOptional()
  @IsString()
  device_type?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class CreateUserDto {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password should be at least 6 characters' })
  password: string;

  @IsEnum(UserType, { message: 'Invalid user type' })
  user_type?: number;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsString()
  device_id?: string;

  @IsOptional()
  @IsString()
  device_type?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialties?: string;

  @IsOptional()
  @IsString()
  experience?: string;

  @IsOptional()
  @IsString()
  about?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(UserType, { message: 'Invalid user type' })
  user_type?: number;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  gender?: string;
}
