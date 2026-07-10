import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  BadRequestException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import helmet from 'helmet';
import { AllExceptionsFilter, ResponseInterceptor } from './utils/interceptor';

// Recognises the errors that mean "network is down", not "app is broken"
function isNetworkError(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  const name = err?.name ?? '';
  return (
    name.startsWith('MongoNetwork') ||
    name === 'MongoServerSelectionError' ||
    [
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNRESET',
    ].includes(code)
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'debug'],
  });

  app.enableShutdownHooks(); // lets onModuleDestroy hooks fire

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.get('/', (req, res) => {
    res.send('Hello from Node-Nest.js!');
  });
  expressApp.get('/favicon.ico', (req, res) => res.status(204).end());
  expressApp.get('/favicon.png', (req, res) => res.status(204).end());

  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableVersioning({ type: VersioningType.URI });
  app.enableCors();
  app.use(helmet());

  console.log(`Starting server on port ${process.env.PORT || 3000}...`);
  await app.listen(process.env.PORT || 3000);

  // ---- crash guard + graceful shutdown ----
  let shuttingDown = false;

  const shutdown = async (reason: string, code = 1) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Shutting down: ${reason}`);
    try {
      await app.close(); // closes HTTP server + mongoose connections
    } catch (e) {
      console.error('Error during close:', e);
    }
    process.exit(code);
  };

  process.on('unhandledRejection', (err: any) => {
    if (isNetworkError(err)) {
      console.warn(
        `⚠️  Network unreachable (${err?.cause?.code ?? err?.code}) — Mongo will keep retrying.`,
      );
      return; // stay alive
    }
    shutdown(`unhandledRejection: ${err?.stack ?? err}`);
  });

  process.on('uncaughtException', (err: any) => {
    if (isNetworkError(err)) {
      console.warn('⚠️  Network error caught — staying alive.');
      return;
    }
    shutdown(`uncaughtException: ${err?.stack ?? err}`);
  });

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
