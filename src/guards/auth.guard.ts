import {
  CanActivate,
  Injectable,
  UnauthorizedException,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Reflector } from '@nestjs/core';
import { sign } from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'Some Complex Secrete Value';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const request: Request = context.switchToHttp().getRequest();
    const token: any = this.extractTokemFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: JWT_SECRET,
      });

      request['user'] = payload;
    } catch (error) {
      throw new ForbiddenException(error?.message);
    }
    return true;
  }

  private extractTokemFromHeader(request: any): Promise<any> {
    try {
      const [type, token] = request?.headers?.authorization?.split(' ') ?? [];
      return type === 'Bearer' ? token : undefined;
    } catch (error) {
      throw new UnauthorizedException();
    }
  }
}

export async function validateRefreshToken(token: string): Promise<any> {
  try {
    const payload = await new JwtService({ secret: JWT_SECRET }).verifyAsync(
      token,
      {
        secret: JWT_SECRET,
      },
    );
    if (!payload.is_refresh) {
      throw new ForbiddenException('Not a refresh token');
    }
    return payload;
  } catch (error) {
    throw new ForbiddenException('Invalid refresh token');
  }
}

export function generateToken(payload: any, onlyAccessToken = false): any {
  const { _id, email, user_type } = payload;
  const result: any = {
    access_token: {
      token: sign({ _id, email, user_type, is_refresh: false }, JWT_SECRET, {
        expiresIn: '1h',
      }),
      expiresIn: Date.now() + 3600000,
    },
  };
  if (!onlyAccessToken) {
    result.refresh_token = {
      token: sign({ _id, email, user_type, is_refresh: true }, JWT_SECRET, {
        expiresIn: '1d',
      }),
      expiresIn: Date.now() + 86400000,
    };
  }
  return result;
}
