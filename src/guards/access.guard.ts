import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCESS_KEY, IS_PUBLIC_KEY } from 'src/decorators/public.decorator';

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1️⃣ Public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    // 2️⃣ Allowed user types
    const allowedTypes = this.reflector.getAllAndOverride<number[]>(
      ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!allowedTypes) return true;

    // 3️⃣ Check user
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }
    if (!allowedTypes.includes(user.user_type)) {
      throw new UnauthorizedException('Unauthorized access');
    }

    return true;
  }
}
