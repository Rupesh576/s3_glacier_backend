import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const s3 = new S3Client({ region: process.env.AWS_REGION });

app.post('/presign', async (req, res) => {
  const { password, filename, contentType } = req.body;

  if (!password || !filename || !contentType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (password !== process.env.MY_VAULT_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: filename,
      ContentType: contentType,
      StorageClass: 'DEEP_ARCHIVE',
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  app.listen(3001, () => console.log('Backend running on http://localhost:3001'));
}

export { app };
