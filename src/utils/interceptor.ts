import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => ({
        success: true,
        message: 'Request successful',
        data,
      })),
    );
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = null;

    // Fix: Use exception?.constructor?.name to check for HttpException
    if (
      exception instanceof HttpException ||
      (exception && (exception as any).constructor?.name === 'HttpException')
    ) {
      status = (exception as HttpException).getStatus();
      const res = (exception as HttpException).getResponse();

      if (typeof res === 'string') {
        message = res;
      }

      if (typeof res === 'object' && res !== null) {
        message = (res as any).message || (res as any).error || message;
        errors = (res as any).errors || null;
      }

      if (Array.isArray(message)) {
        errors = message;
        message = 'Validation failed';
      }
    } else if (exception instanceof Error) {
      message = (exception as Error).message || message;
      errors = (exception as Error).stack || null;
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message: message || 'Internal server error',
      errors,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
