import { BadRequestException, Injectable } from '@nestjs/common';
import * as cloudinary from 'cloudinary';
import { env } from 'src/config/env';

@Injectable()
export class CloudinaryService {
  constructor() {
    cloudinary.v2.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
    });
  }

  async uploadFile(file: any) {
    try {
      if (!file || !file.buffer) {
        throw new Error('Invalid file upload');
      }
      return await new Promise((resolve, reject) => {
        cloudinary.v2.uploader
          .upload_stream({ resource_type: 'auto' }, (error, result) => {
            if (error) {
              reject(error);
            }
            if (!result) {
              reject(new Error('File upload failed'));
            }
            const { format, public_id, version, secure_url } = result;
            const resp = {
              url: secure_url,
              name: `v${version}/${public_id}.${format}`,
            };
            resolve(resp);
          })
          .end(file.buffer);
      });
    } catch (error) {
      // Optionally log the error or handle it as needed
      throw new BadRequestException(error?.message || 'File upload failed');
    }
  }
}
