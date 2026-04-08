import { config } from 'dotenv';
config();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  PORT: Number(process.env.PORT || 8000),
  NODE_ENV: process.env.NODE_ENV || 'development',

  IB_URL: process.env.IB_URL || '',

  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || '',
  FIREBASE_PRIVATE_KEY_ID: process.env.FIREBASE_PRIVATE_KEY_ID || '',
  FIREBASE_PRIVATE_KEY:
    process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',

  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'default-encryption-key',
  HASH_SECRET: process.env.HASH_SECRET || 'default-hash-secret',
  ITEMPERPAGE: process.env.ITEMPERPAGE || '10',
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || '',
  SG_EMAIL: process.env.SG_EMAIL || '',
};
