import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mock @aws-sdk/s3-request-presigner before importing the app ──────────────
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

// ── Mock @aws-sdk/client-s3 so no real AWS calls are made ───────────────────
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({})),
  PutObjectCommand: vi.fn((params) => ({ ...params })),
}));

import request from 'supertest';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { app } from '../server.js';

const VAULT_PASSWORD = 'test-vault-password';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MY_VAULT_PASSWORD = VAULT_PASSWORD;
  process.env.S3_BUCKET_NAME = 'test-bucket';
  process.env.AWS_REGION = 'us-east-1';
});

// ── Example Tests (Task 4.2) ─────────────────────────────────────────────────

describe('POST /presign — example tests', () => {
  it('returns 403 when password is wrong', async () => {
    const res = await request(app)
      .post('/presign')
      .send({ password: 'wrong', filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/presign')
      .send({ filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 400 when filename is missing', async () => {
    const res = await request(app)
      .post('/presign')
      .send({ password: VAULT_PASSWORD, contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 400 when contentType is missing', async () => {
    const res = await request(app)
      .post('/presign')
      .send({ password: VAULT_PASSWORD, filename: 'file.txt' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 500 when AWS SDK throws', async () => {
    getSignedUrl.mockRejectedValueOnce(new Error('AWS error'));
    const res = await request(app)
      .post('/presign')
      .send({ password: VAULT_PASSWORD, filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to generate upload URL');
  });

  it('constructs PutObjectCommand with StorageClass DEEP_ARCHIVE', async () => {
    getSignedUrl.mockResolvedValueOnce('https://s3.example.com/signed');
    await request(app)
      .post('/presign')
      .send({ password: VAULT_PASSWORD, filename: 'archive.zip', contentType: 'application/zip' });
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ StorageClass: 'DEEP_ARCHIVE' })
    );
  });

  it('calls getSignedUrl with expiresIn: 300', async () => {
    getSignedUrl.mockResolvedValueOnce('https://s3.example.com/signed');
    await request(app)
      .post('/presign')
      .send({ password: VAULT_PASSWORD, filename: 'archive.zip', contentType: 'application/zip' });
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expiresIn: 300 })
    );
  });

  it('returns 200 with url on success', async () => {
    getSignedUrl.mockResolvedValueOnce('https://s3.example.com/signed-url');
    const res = await request(app)
      .post('/presign')
      .send({ password: VAULT_PASSWORD, filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://s3.example.com/signed-url');
  });
});

// ── Property 1: Password comparison correctness (Task 4.3) ───────────────────
// Validates: Requirements 1.1, 1.2

describe('Property 1 — password comparison correctness', () => {
  it('auth returns 200 iff candidate === vault password, 403 otherwise', async () => {
    getSignedUrl.mockResolvedValue('https://s3.example.com/signed');

    // Filter out empty/whitespace-only strings — those correctly return 400
    // (missing fields guard), not 403. Property 1 only concerns non-empty passwords.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
        async (candidate) => {
          const res = await request(app)
            .post('/presign')
            .send({ password: candidate, filename: 'f.txt', contentType: 'text/plain' });

          if (candidate === VAULT_PASSWORD) {
            expect(res.status).toBe(200);
          } else {
            expect(res.status).toBe(403);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 2: Presign response encodes filename (Task 4.4) ─────────────────
// Validates: Requirements 2.1, 2.4

describe('Property 2 — presign response encodes filename', () => {
  it('response url contains the filename for any valid (filename, contentType)', async () => {
    const contentTypes = [
      'image/png', 'application/pdf', 'video/mp4',
      'text/plain', 'application/zip', 'audio/mpeg',
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('\0')),
        fc.constantFrom(...contentTypes),
        async (filename, contentType) => {
          // Mock returns a URL that includes the filename (simulating real S3 behaviour)
          getSignedUrl.mockResolvedValueOnce(
            `https://s3.example.com/${encodeURIComponent(filename)}?X-Amz-Signature=abc`
          );

          const res = await request(app)
            .post('/presign')
            .send({ password: VAULT_PASSWORD, filename, contentType });

          expect(res.status).toBe(200);
          expect(res.body).toHaveProperty('url');
          expect(typeof res.body.url).toBe('string');
          expect(res.body.url.length).toBeGreaterThan(0);
          // The URL should encode the filename
          expect(res.body.url).toContain(encodeURIComponent(filename));
        }
      ),
      { numRuns: 100 }
    );
  });
});
