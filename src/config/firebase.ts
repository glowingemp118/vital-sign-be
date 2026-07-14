import * as admin from 'firebase-admin';
import { config } from 'dotenv';
config();

const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
  console.error(
    '[Firebase] Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY',
  );
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId,
    clientEmail,
    privateKey,
  }),
});

console.log(
  `[Firebase] Admin initialized projectId=${projectId} (iOS FCM requires APNs Auth Key .p8 in Firebase Console — VoIP .p12 is separate)`,
);

export default admin;
