import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';

const validCookies = {
  authToken: 'test_auth_token',
  ct0: 'test_ct0_token',
  cookieHeader: 'auth_token=test_auth_token; ct0=test_ct0_token',
  source: 'test',
};

type ResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

type TwitterClientApiPrivate = TwitterClient & {
  getBookmarksQueryIds: () => Promise<string[]>;
  getBookmarkFolderQueryIds: () => Promise<string[]>;
};

const makeResponse = (overrides: Partial<ResponseLike> = {}): ResponseLike => ({
  ok: true,
  status: 200,
  json: async (): Promise<unknown> => ({}),
  text: async (): Promise<string> => '',
  ...overrides,
});

describe('TwitterClient API coverage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('createTweet fallback paths', () => {
    it('returns an error when retry response is not ok', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, text: async () => 'nope' }))
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, text: async () => 'nope' }))
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 500, text: async () => 'boom' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.tweet('hi');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('returns API errors when retry response contains errors', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, text: async () => 'nope' }))
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, text: async () => 'nope' }))
        .mockResolvedValueOnce(
          makeResponse({
            json: async () => ({ errors: [{ message: 'rate limited', code: 1 }] }),
          }),
        );
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.tweet('hi');

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limited');
    });

    it('returns an error when retry response has no tweet id', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, text: async () => 'nope' }))
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 404, text: async () => 'nope' }))
        .mockResolvedValueOnce(
          makeResponse({
            json: async () => ({ data: { create_tweet: { tweet_results: { result: {} } } } }),
          }),
        );
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.tweet('hi');

      expect(result.success).toBe(false);
      expect(result.error).toContain('no ID');
    });
  });

  describe('search error paths', () => {
    it('returns an error for non-ok responses', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 500, text: async () => 'down' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.search('test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('returns errors from payloads', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        makeResponse({
          json: async () => ({ errors: [{ message: 'bad' }] }),
        }),
      );
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.search('test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('bad');
    });

    it('returns an error when fetching throws', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('boom'));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.search('test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('returns the second attempt error after 404s', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, text: async () => 'nope' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.search('test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 404');
    });
  });

  describe('bookmarks error paths', () => {
    it('returns an error for non-ok responses', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 500, text: async () => 'down' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarks(1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('returns API errors from payloads', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        makeResponse({
          json: async () => ({ errors: [{ message: 'bad' }] }),
        }),
      );
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarks(1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('bad');
    });

    it('returns an error when fetching throws', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('boom'));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarks(1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('returns unknown error when no query ids are available', async () => {
      const client = new TwitterClient({ cookies: validCookies });
      const clientPrivate = client as unknown as TwitterClientApiPrivate;
      clientPrivate.getBookmarksQueryIds = async () => [];

      const result = await client.getBookmarks(1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error fetching bookmarks');
    });

    it('returns the second attempt error after 404s', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, text: async () => 'nope' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarks(1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 404');
    });
  });

  describe('bookmark folder error paths', () => {
    it('returns an error for non-ok responses', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ ok: false, status: 500, text: async () => 'down' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarkFolderTimeline('123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('returns API errors from payloads', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        makeResponse({
          json: async () => ({ errors: [{ message: 'bad' }] }),
        }),
      );
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarkFolderTimeline('123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('bad');
    });

    it('returns an error when fetching throws', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('boom'));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarkFolderTimeline('123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('returns unknown error when no query ids are available', async () => {
      const client = new TwitterClient({ cookies: validCookies });
      const clientPrivate = client as unknown as TwitterClientApiPrivate;
      clientPrivate.getBookmarkFolderQueryIds = async () => [];

      const result = await client.getBookmarkFolderTimeline('123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error fetching bookmark folder');
    });

    it('returns the second attempt error after 404s', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, text: async () => 'nope' }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const client = new TwitterClient({ cookies: validCookies });
      const result = await client.getBookmarkFolderTimeline('123', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 404');
    });
  });
});
