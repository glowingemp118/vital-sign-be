import { BadRequestException, Injectable } from '@nestjs/common';
import * as cloudinary from 'cloudinary';
import { config } from 'dotenv';
config(); // Load environment variables

@Injectable()
export class CloudinaryService {
  constructor() {
    cloudinary.v2.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  async uploadFile(file: Express.Multer.File | string) {
    try {
      // CASE 1: Local file path
      if (typeof file === 'string') {
        const result = await cloudinary.v2.uploader.upload(file, {
          resource_type: 'auto',
        });

        return {
          url: result.secure_url,
          name: `v${result.version}/${result.public_id}.${result.format}`,
        };
      }

      if (!file) {
        throw new Error('No file provided');
      }

      // CASE 2: Multer disk storage (path on disk)
      if (file.path) {
        return await this.uploadFile(file.path);
      }

      // CASE 3: Multer memory storage (buffer)
      if (!file.buffer) {
        throw new Error('Invalid file upload — no buffer or path');
      }

      return await new Promise((resolve, reject) => {
        cloudinary.v2.uploader
          .upload_stream({ resource_type: 'auto' }, (error, result) => {
            if (error) {
              return reject(error);
            }
            if (!result) {
              return reject(new Error('Cloudinary upload returned no result'));
            }
            const { format, public_id, version, secure_url } = result;
            resolve({
              url: secure_url,
              name: `v${version}/${public_id}.${format}`,
            });
          })
          .end(file.buffer);
      });
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'File upload failed');
    }
  }
}
