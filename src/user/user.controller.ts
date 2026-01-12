import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Delete,
  Param,
  Request,
  HttpCode,
  HttpStatus,
  Put,
} from '@nestjs/common';
import { UserService } from './user.service';
import { SignInDto, CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';

@Controller('auth') // Change the controller prefix to '/auth'
export class UserController {
  constructor(private readonly userService: UserService) {}

  // Register user (now accessible at '/auth/register')
  @Post('register') // Keep '/register' but now it will be '/auth/register'
  @Public()
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() createUserDto: CreateUserDto) {
    return await this.userService.createUser(createUserDto);
  }

  // Login user (now accessible at '/auth/login')
  @ApiTags('Auth')
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  async login(@Body() signInDto: SignInDto) {
    return await this.userService.signIn(signInDto);
  }

  // Verify email (now accessible at '/auth/verify-otp')
  @ApiTags('Auth')
  @Put('verify-otp')
  @Public()
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() body: { email: string; otp: string; forgot_verify?: boolean },
  ) {
    return await this.userService.verifyOtp(body.email, body.otp);
  }
  // Send OTP (now accessible at '/auth/send-otp')
  @ApiTags('Auth')
  @Put('send-otp')
  @Public()
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() body: { email: string }) {
    return await this.userService.sendOtp(body.email);
  }

  // Change password (now accessible at '/auth/change-password')
  @ApiTags('Auth')
  @Put('change-password')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Request() req,
    @Body() body: { old_password: string; new_password: string },
  ) {
    const userId = req.user._id;
    return await this.userService.changePassword(
      userId,
      body.old_password,
      body.new_password,
    );
  }

  // Reset password (now accessible at '/auth/reset-password')
  @ApiTags('Auth')
  @Put('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: { email: string; password: string }) {
    return await this.userService.resetPassword(body.email, body.password);
  }

  // Reset password (now accessible at '/auth/refresh-token')
  @ApiTags('Auth')
  @Post('refresh-token')
  @Public()
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() body: { refreshToken: string }) {
    return await this.userService.refreshToken(body.refreshToken);
  }

  @ApiTags('Auth')
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req, @Body() body: { device_id: string }) {
    const id = req.user._id;
    return await this.userService.logout(id, body.device_id);
  }

  // Update user profile (now accessible at '/auth/update-profile/:id')
  @ApiTags('User')
  @Put('profile') // Using 'profile/:id' to update the user
  @ApiBearerAuth()
  async updateProfile(@Request() req, @Body() updateUserDto: UpdateUserDto) {
    const id = req.user._id || req.query.id; // JWT user ID or from body
    return await this.userService.updateProfile(id, updateUserDto);
  }

  // Delete user (now accessible at '/auth/delete/:id')
  @ApiTags('User')
  @Delete('profile/:id') // Using 'profile/:id' to delete the user
  @ApiBearerAuth()
  async delete(@Param('id') id: string) {
    return await this.userService.deleteUser(id);
  }

  // Get user profile (now accessible at '/auth/profile')
  @ApiTags('User')
  @Get('profile')
  @ApiBearerAuth()
  async getProfile(@Request() req) {
    const userId = req.user._id; // JWT user ID
    return await this.userService.getProfile(userId);
  }

  @ApiTags('User')
  @Post('decrypt')
  @ApiBearerAuth()
  async tDecrypt(@Request() req) {
    return this.userService.testDecrypt(req.body);
  }

  @ApiTags('User')
  @Delete('delete-account')
  @ApiBearerAuth()
  async deleteAccount(@Request() req) {
    return this.userService.softDeleteUser(req.user._id);
  }
}
