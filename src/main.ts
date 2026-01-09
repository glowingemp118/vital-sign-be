import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
// import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import {
  BadRequestException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import helmet from 'helmet';
import { AllExceptionsFilter, ResponseInterceptor } from './utils/interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'debug'],
  });
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.get('/', (req, res) => {
    res.send('Hello from Node-Nest.js!');
  });
  expressApp.get('/favicon.ico', (req, res) => res.status(204).end());
  expressApp.get('/favicon.png', (req, res) => res.status(204).end());
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new ResponseInterceptor());
  // Enable global validation pipe with additional configuration
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Automatically remove properties that are not in the DTO class
      forbidNonWhitelisted: false, // Throw an error if non-whitelisted properties are provided
      transform: true, // Automatically transform plain objects into instances of DTO classe
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  // Enable versioning via URI
  app.enableVersioning({
    type: VersioningType.URI,
  });

  // Enable CORS for all domains (you can customize this for specific domains if needed)
  app.enableCors();

  // Use Helmet for security best practices
  app.use(helmet());

  // Set up Swagger documentation
  // const config = new DocumentBuilder()
  //   .setTitle('Nest App')
  //   .setDescription(
  //     `This documentation includes the Nest module, User module, and Login API's. It also includes the Authorization header`,
  //   )
  //   .setVersion('1.0')
  //   .addTag('Nest')
  //   .addBearerAuth() // Add authorization header for API calls
  //   .build();

  // const document = SwaggerModule.createDocument(app, config);
  // SwaggerModule.setup('api', app, document);

  // Start the application on port 3000
  await app.listen(3000);
}

bootstrap();
