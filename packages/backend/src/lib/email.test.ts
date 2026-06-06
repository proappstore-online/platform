import { describe, expect, it, vi, beforeEach } from 'vitest';
import { sendEmail, normalizeEmail, isLikelyEmail } from './email.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const cfg = { apiKey: 're_test_123', from: 'ProAppStore <noreply@proappstore.online>' };

beforeEach(() => mockFetch.mockReset());

describe('sendEmail', () => {
  it('sends via Resend API with correct headers and body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    await sendEmail(cfg, {
      to: 'alice@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_123');

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe(cfg.from);
    expect(body.to).toBe('alice@example.com');
    expect(body.subject).toBe('Test');
    expect(body.html).toBe('<p>Hello</p>');
  });

  it('includes reply_to when provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    await sendEmail(cfg, {
      to: 'bob@example.com',
      subject: 'Re: Test',
      html: '<p>Reply</p>',
      text: 'Reply',
      replyTo: 'support@myapp.com',
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.reply_to).toBe('support@myapp.com');
  });

  it('omits reply_to when not provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    await sendEmail(cfg, { to: 'a@b.com', subject: 'x', html: 'x', text: 'x' });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.reply_to).toBeUndefined();
  });

  it('throws on non-ok response with status and body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 422,
      text: () => Promise.resolve('{"error":"invalid email"}'),
    } as Response);
    await expect(
      sendEmail(cfg, { to: 'bad', subject: 'x', html: 'x', text: 'x' })
    ).rejects.toThrow(/422.*invalid email/);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alice@EXAMPLE.COM  ')).toBe('alice@example.com');
  });
});

describe('isLikelyEmail', () => {
  it('accepts valid emails', () => {
    expect(isLikelyEmail('a@b.com')).toBe(true);
    expect(isLikelyEmail('user+tag@sub.domain.co')).toBe(true);
  });

  it('rejects invalid emails', () => {
    expect(isLikelyEmail('')).toBe(false);
    expect(isLikelyEmail('no-at-sign')).toBe(false);
    expect(isLikelyEmail('@no-local.com')).toBe(false);
    expect(isLikelyEmail('no-tld@host')).toBe(false);
    expect(isLikelyEmail('spaces in@email.com')).toBe(false);
  });

  it('rejects emails over 254 chars', () => {
    expect(isLikelyEmail('a'.repeat(250) + '@b.com')).toBe(false);
  });
});
