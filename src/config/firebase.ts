import * as admin from 'firebase-admin';
import * as path from 'path';

const serviceAccount = require(
  path.join(
    process.cwd(),
    'src/config/vital-signs-b20b6-firebase-adminsdk-fbsvc.json',
  ),
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

export default admin;
