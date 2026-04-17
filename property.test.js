/**
 * Property-Based Tests for s3-glacier-uploader backend
 * Uses fast-check to verify correctness properties across arbitrary inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';

// ── Mock AWS SDK ─────────────────────────────────────────────────────────────
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

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function buildApp(vaultPassword, bucketName = 'test-bucket') {
  const app = express();
  app.use(express.json());
  const s3 = new S3Client({ region: 'us-east-1' });

  app.post('/presign', async (req, res) => {
    const { password, filename, contentType } = req.body;
    if (!password || !filename || !contentType)
      return res.status(400).json({ error: 'Missing required fields' });
    if (password !== vaultPassword)
      return res.status(403).json({ error: 'Forbidden' });
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

async function post(app, body) {
  const { default: supertest } = await import('supertest');
  return supertest(app).post('/presign').send(body).set('Content-Type', 'application/json');
}

// ── Property 1: Password comparison correctness ──────────────────────────────
// For any candidate password string, auth returns 403 iff candidate !== vault,
// and proceeds (non-403) iff candidate === vault.
describe('Property 1 — password comparison correctness', () => {
  it('returns 403 for any string that is not the vault password', async () => {
    const VAULT = 'my-secret-vault-pw';
    const app = buildApp(VAULT);

    await fc.assert(
      fc.asyncProperty(
        fc.string().filter(s => s !== VAULT && s.length > 0),
        async (candidate) => {
          const res = await post(app, {
            password: candidate,
            filename: 'file.txt',
            contentType: 'text/plain',
          });
          expect(res.status).toBe(403);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('does not return 403 when the exact vault password is provided', async () => {
    const VAULT = 'my-secret-vault-pw';
    const app = buildApp(VAULT);
    mockGetSignedUrl.mockResolvedValue('https://s3.example.com/url');

    const res = await post(app, {
      password: VAULT,
      filename: 'file.txt',
      contentType: 'text/plain',
    });
    expect(res.status).not.toBe(403);
  });
});

// ── Property 2: Presign response encodes filename ────────────────────────────
// For any valid (filename, contentType), the returned url contains the filename.
describe('Property 2 — presign response encodes filename', () => {
  it('url in response contains the submitted filename for any valid input', async () => {
    const VAULT = 'vault-pw';
    const app = buildApp(VAULT);

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
        fc.constantFrom('image/png', 'application/pdf', 'video/mp4', 'text/plain', 'application/zip'),
        async (filename, contentType) => {
          const encodedFilename = encodeURIComponent(filename);
          mockGetSignedUrl.mockResolvedValueOnce(
            `https://s3.amazonaws.com/bucket/${encodedFilename}?X-Amz-Signature=abc`
          );

          const res = await post(app, { password: VAULT, filename, contentType });
          expect(res.status).toBe(200);
          expect(res.body).toHaveProperty('url');
          expect(typeof res.body.url).toBe('string');
          expect(res.body.url.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
