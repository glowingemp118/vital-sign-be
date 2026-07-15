import { BadRequestException, Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as mime from 'mime-types';
import { randomBytes } from 'crypto';
import { config } from 'dotenv';

config();

@Injectable()
export class S3Service {
  private readonly s3: S3Client;
  private readonly bucket = process.env.AWS_S3_BUCKET!;
  private readonly region = process.env.AWS_REGION!;

  constructor() {
    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  async uploadFile(file: Express.Multer.File | string) {
    let tempFilePath: string | null = null;

    try {
      let body: Buffer;
      let fileName: string;
      let contentType: string;

      // CASE 1: Local file path
      if (typeof file === 'string') {
        tempFilePath = file;

        body = await fs.readFile(file);
        fileName = path.basename(file);
        contentType =
          (mime.lookup(fileName) as string) || 'application/octet-stream';
      }

      // CASE 2: Multer disk storage
      else if (file?.path) {
        tempFilePath = file.path;

        body = await fs.readFile(file.path);
        fileName = file.originalname || path.basename(file.path);
        contentType = file.mimetype || 'application/octet-stream';
      }

      // CASE 3: Multer memory storage
      else if (file?.buffer) {
        body = file.buffer;
        fileName = file.originalname;
        contentType = file.mimetype || 'application/octet-stream';
      } else {
        throw new Error('No valid file provided');
      }

      const extension = path.extname(fileName);
      const id = randomBytes(6).toString('hex'); // 12 chars
      const key = `${Date.now()}-${id}${extension}`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // Remove this if your bucket doesn't allow ACLs
          // ACL: 'public-read',
        }),
      );

      return {
        url: `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`,
        name: key,
      };
    } catch (error: any) {
      throw new BadRequestException(
        error?.message || 'Failed to upload file to S3',
      );
    } finally {
      // Delete temporary file if it exists
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
        } catch {
          // Ignore if file already deleted or doesn't exist
        }
      }
    }
  }
}
