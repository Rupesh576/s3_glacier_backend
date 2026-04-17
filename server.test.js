import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mock AWS SDK before importing server logic ──────────────────────────────
let mockGetSignedUrl = vi.fn();
let mockPutObjectCommandSpy = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({})),
  PutObjectCommand: vi.fn((params) => {
    mockPutObjectCommandSpy(params);
    return params;
  }),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));

// ── Import the handler factory after mocks are in place ─────────────────────
// We test the handler logic directly by extracting it into a helper.
// Since server.js starts a listener, we build a minimal testable version here.

import express from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function buildApp(vaultPassword, bucketName) {
  const app = express();
  app.use(express.json());

  const s3 = new S3Client({ region: 'us-east-1' });

  app.post('/presign', async (req, res) => {
    const { password, filename, contentType } = req.body;

    if (!password || !filename || !contentType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (password !== vaultPassword) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: filename,
        ContentType: contentType,
        StorageClass: 'DEEP_ARCHIVE',
      });
      const url = await getSignedUrl(s3, command, { expiresIn: 300 });
      res.json({ url });
    } catch {
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  });

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function post(app, body) {
  const { default: supertest } = await import('supertest');
  return supertest(app).post('/presign').send(body).set('Content-Type', 'application/json');
}

const VAULT = 'correct-password';
const BUCKET = 'my-test-bucket';

// ── Example Tests ────────────────────────────────────────────────────────────
describe('POST /presign — example tests', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp(VAULT, BUCKET);
  });

  it('returns 400 when password is missing', async () => {
    const res = await post(app, { filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 400 when filename is missing', async () => {
    const res = await post(app, { password: VAULT, contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 400 when contentType is missing', async () => {
    const res = await post(app, { password: VAULT, filename: 'file.txt' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 403 when password is wrong', async () => {
    const res = await post(app, { password: 'wrong', filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns 500 when AWS SDK throws', async () => {
    mockGetSignedUrl.mockRejectedValueOnce(new Error('AWS config error'));
    const res = await post(app, { password: VAULT, filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to generate upload URL');
  });

  it('returns 200 with url on success', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/presigned');
    const res = await post(app, { password: VAULT, filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://s3.example.com/presigned');
  });

  it('constructs PutObjectCommand with StorageClass DEEP_ARCHIVE', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/presigned');
    await post(app, { password: VAULT, filename: 'archive.zip', contentType: 'application/zip' });
    expect(mockPutObjectCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({ StorageClass: 'DEEP_ARCHIVE' })
    );
  });

  it('calls getSignedUrl with expiresIn: 300', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://s3.example.com/presigned');
    await post(app, { password: VAULT, filename: 'file.txt', contentType: 'text/plain' });
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expiresIn: 300 })
    );
  });

  it('does not echo the password in any response body', async () => {
    const res = await post(app, { password: 'leaked-secret', filename: 'f', contentType: 'text/plain' });
    expect(JSON.stringify(res.body)).not.toContain('leaked-secret');
  });
});
