#!/usr/bin/env node
/**
 * bird - CLI tool for posting tweets and replies
 *
 * Usage:
 *   bird tweet "Hello world!"
 *   bird reply <tweet-id> "This is a reply"
 *   bird reply <tweet-url> "This is a reply"
 *   bird read <tweet-id-or-url>
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import JSON5 from 'json5';
import kleur from 'kleur';
import { resolveCliInvocation } from './lib/cli-args.js';
import { resolveCredentials } from './lib/cookies.js';
import { type EngineMode, resolveEngineMode, shouldUseSweetistics } from './lib/engine.js';
import { extractTweetId } from './lib/extract-tweet-id.js';
import { normalizeHandle } from './lib/normalize-handle.js';
import { SweetisticsClient } from './lib/sweetistics-client.js';
import { type TweetData, TwitterClient } from './lib/twitter-client.js';
import { getCliVersion } from './lib/version.js';

const program = new Command();

const isTty = process.stdout.isTTY;
const wrap = (styler: (text: string) => string) => (text: string) => (isTty ? styler(text) : text);
const collect = (value: string, previous: string[] = []) => {
  previous.push(value);
  return previous;
};

const colors = {
  banner: wrap((t) => kleur.bold().blue(t)),
  subtitle: wrap((t) => kleur.dim(t)),
  section: wrap((t) => kleur.bold().white(t)),
  bullet: wrap((t) => kleur.blue(t)),
  command: wrap((t) => kleur.bold().cyan(t)),
  option: wrap((t) => kleur.cyan(t)),
  argument: wrap((t) => kleur.magenta(t)),
  description: wrap((t) => kleur.white(t)),
  muted: wrap((t) => kleur.gray(t)),
  accent: wrap((t) => kleur.green(t)),
};

type BirdConfig = {
  engine?: EngineMode;
  chromeProfile?: string;
  firefoxProfile?: string;
  sweetisticsApiKey?: string;
  sweetisticsBaseUrl?: string;
  allowChrome?: boolean;
  allowFirefox?: boolean;
  timeoutMs?: number;
};

function readConfigFile(path: string): Partial<BirdConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON5.parse(raw) as Partial<BirdConfig>;
    return parsed ?? {};
  } catch (error) {
    console.error(
      colors.muted(`⚠️ Failed to parse config at ${path}: ${error instanceof Error ? error.message : String(error)}`),
    );
    return {};
  }
}

function loadConfig(): BirdConfig {
  const globalPath = join(homedir(), '.config', 'bird', 'config.json5');
  const localPath = join(process.cwd(), '.birdrc.json5');

  return {
    ...readConfigFile(globalPath),
    ...readConfigFile(localPath),
  };
}

const config = loadConfig();

const KNOWN_COMMANDS = new Set([
  'tweet',
  'reply',
  'read',
  'replies',
  'thread',
  'search',
  'mentions',
  'whoami',
  'check',
]);

program.addHelpText(
  'beforeAll',
  () => `${colors.banner('bird CLI')} ${colors.subtitle('— fast X CLI for tweeting, replying, and reading')}`,
);

program.name('bird').description('Post tweets and replies via Twitter/X GraphQL API').version(getCliVersion());

const formatExample = (command: string, description: string) =>
  `${colors.command(`  ${command}`)}\n${colors.muted(`    ${description}`)}`;

program.addHelpText(
  'afterAll',
  () =>
    `\n${colors.section('Examples')}\n${[
      formatExample('bird whoami', 'Show the logged-in account via GraphQL cookies'),
      formatExample('bird --firefox-profile default-release whoami', 'Use Firefox profile cookies'),
      formatExample('bird tweet "hello from bird"', 'Send a tweet'),
      formatExample('bird replies https://x.com/user/status/1234567890123456789', 'Check replies to a tweet'),
    ].join('\n\n')}`,
);

// Global options for authentication
program
  .option('--auth-token <token>', 'Twitter auth_token cookie')
  .option('--ct0 <token>', 'Twitter ct0 cookie')
  .option('--chrome-profile <name>', 'Chrome profile name for cookie extraction', config.chromeProfile)
  .option('--firefox-profile <name>', 'Firefox profile name for cookie extraction', config.firefoxProfile)
  .option('--media <path>', 'Attach media file (repeatable, up to 4 images or 1 video)', collect, [])
  .option('--alt <text>', 'Alt text for the corresponding --media (repeatable)', collect, [])
  .option('--sweetistics-api-key <key>', 'Sweetistics API key (or set SWEETISTICS_API_KEY)')
  .option(
    '--sweetistics-base-url <url>',
    'Sweetistics base URL',
    config.sweetisticsBaseUrl || process.env.SWEETISTICS_BASE_URL || 'https://sweetistics.com',
  )
  .option(
    '--engine <engine>',
    'Engine: graphql | sweetistics | auto',
    process.env.BIRD_ENGINE || config.engine || 'auto',
  )
  .option('--timeout <ms>', 'Request timeout in milliseconds');

type MediaSpec = { path: string; alt?: string; mime: string; buffer: Buffer };

function resolveSweetisticsConfig(options: { sweetisticsApiKey?: string; sweetisticsBaseUrl?: string }) {
  const apiKey =
    options.sweetisticsApiKey || process.env.SWEETISTICS_API_KEY || process.env.SWEETISTICS_LOCALHOST_API_KEY || null;

  const baseUrl = options.sweetisticsBaseUrl || process.env.SWEETISTICS_BASE_URL || 'https://sweetistics.com';

  return { apiKey, baseUrl };
}

function resolveTimeoutMs(...values: Array<string | number | undefined | null>): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function resolveTimeoutFromOptions(options: { timeout?: string | number }): number | undefined {
  return resolveTimeoutMs(options.timeout, config.timeoutMs, process.env.BIRD_TIMEOUT_MS);
}

function detectMime(path: string): string | null {
  const ext = path.toLowerCase();
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.webp')) return 'image/webp';
  if (ext.endsWith('.gif')) return 'image/gif';
  if (ext.endsWith('.mp4') || ext.endsWith('.m4v')) return 'video/mp4';
  if (ext.endsWith('.mov')) return 'video/quicktime';
  return null;
}

function loadMedia(opts: { media: string[]; alts: string[] }): MediaSpec[] {
  if (opts.media.length === 0) return [];
  const specs: MediaSpec[] = [];
  for (const [index, path] of opts.media.entries()) {
    const mime = detectMime(path);
    if (!mime) {
      throw new Error(`Unsupported media type for ${path}. Supported: jpg, jpeg, png, webp, gif, mp4, mov`);
    }
    const buffer = readFileSync(path);
    specs.push({ path, mime, buffer, alt: opts.alts[index] });
  }

  const videoCount = specs.filter((m) => m.mime.startsWith('video/')).length;
  if (videoCount > 1) throw new Error('Only one video can be attached');
  if (videoCount === 1 && specs.length > 1) throw new Error('Video cannot be combined with other media');
  if (specs.length > 4) throw new Error('Maximum 4 media attachments');
  return specs;
}

function printTweets(
  tweets: TweetData[],
  opts: { json?: boolean; emptyMessage?: string; showSeparator?: boolean } = {},
) {
  if (opts.json) {
    console.log(JSON.stringify(tweets, null, 2));
    return;
  }
  if (tweets.length === 0) {
    console.log(opts.emptyMessage ?? 'No tweets found.');
    return;
  }
  for (const tweet of tweets) {
    console.log(`\n@${tweet.author.username} (${tweet.author.name}):`);
    console.log(tweet.text);
    if (tweet.createdAt) {
      console.log(`📅 ${tweet.createdAt}`);
    }
    console.log(`🔗 https://x.com/${tweet.author.username}/status/${tweet.id}`);
    if (opts.showSeparator ?? true) {
      console.log('─'.repeat(50));
    }
  }
}

// Tweet command
program
  .command('tweet')
  .description('Post a new tweet')
  .argument('<text>', 'Tweet text')
  .action(async (text: string) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    let media: MediaSpec[] = [];
    try {
      media = loadMedia({ media: opts.media ?? [], alts: opts.alt ?? [] });
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));

    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      try {
        const client = new SweetisticsClient({
          baseUrl: sweetistics.baseUrl,
          apiKey: sweetistics.apiKey,
          timeoutMs,
        });
        let mediaIds: string[] | undefined;
        if (media.length > 0) {
          const uploaded: string[] = [];
          for (const item of media) {
            const res = await client.uploadMedia({
              data: item.buffer.toString('base64'),
              mimeType: item.mime,
              alt: item.alt,
            });
            if (!res.success || !res.mediaId) {
              throw new Error(res.error ?? 'Media upload failed');
            }
            uploaded.push(res.mediaId);
          }
          mediaIds = uploaded;
        }
        const result = await client.tweet(text, undefined, mediaIds);
        if (result.success) {
          console.log('✅ Tweet posted via Sweetistics!');
          if (result.tweetId) {
            console.log(`🔗 https://x.com/i/status/${result.tweetId}`);
          }
          return;
        }
        console.error(`❌ Sweetistics post failed: ${result.error ?? 'Unknown error'}`);
        process.exit(1);
      } catch (error) {
        console.error(`❌ Sweetistics error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }

    if (media.length > 0) {
      console.error(
        '❌ Media uploads are only supported via Sweetistics. Provide SWEETISTICS_API_KEY or --engine sweetistics.',
      );
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
      allowChrome: config.allowChrome ?? true,
      allowFirefox: config.allowFirefox ?? true,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    if (cookies.source) {
      console.error(`📍 Using credentials from: ${cookies.source}`);
    }

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.tweet(text);

    if (result.success) {
      console.log('✅ Tweet posted successfully!');
      console.log(`🔗 https://x.com/i/status/${result.tweetId}`);
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL tweet failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).tweet(text);
      if (fallback.success) {
        console.log('✅ Tweet posted via Sweetistics (fallback)!');
        if (fallback.tweetId) {
          console.log(`🔗 https://x.com/i/status/${fallback.tweetId}`);
        }
      } else {
        console.error(`❌ Failed to post tweet: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Failed to post tweet: ${result.error}`);
      process.exit(1);
    }
  });

// Reply command
program
  .command('reply')
  .description('Reply to an existing tweet')
  .argument('<tweet-id-or-url>', 'Tweet ID or URL to reply to')
  .argument('<text>', 'Reply text')
  .action(async (tweetIdOrUrl: string, text: string) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    let media: MediaSpec[] = [];
    try {
      media = loadMedia({ media: opts.media ?? [], alts: opts.alt ?? [] });
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));
    const tweetId = extractTweetId(tweetIdOrUrl);

    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      try {
        const client = new SweetisticsClient({
          baseUrl: sweetistics.baseUrl,
          apiKey: sweetistics.apiKey,
          timeoutMs,
        });
        let mediaIds: string[] | undefined;
        if (media.length > 0) {
          const uploaded: string[] = [];
          for (const item of media) {
            const res = await client.uploadMedia({
              data: item.buffer.toString('base64'),
              mimeType: item.mime,
              alt: item.alt,
            });
            if (!res.success || !res.mediaId) {
              throw new Error(res.error ?? 'Media upload failed');
            }
            uploaded.push(res.mediaId);
          }
          mediaIds = uploaded;
        }
        const result = await client.tweet(text, tweetId, mediaIds);
        if (result.success) {
          console.log('✅ Reply posted via Sweetistics!');
          if (result.tweetId) {
            console.log(`🔗 https://x.com/i/status/${result.tweetId}`);
          }
          return;
        }
        console.error(`❌ Sweetistics reply failed: ${result.error ?? 'Unknown error'}`);
        process.exit(1);
      } catch (error) {
        console.error(`❌ Sweetistics error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }

    if (media.length > 0) {
      console.error(
        '❌ Media uploads are only supported via Sweetistics. Provide SWEETISTICS_API_KEY or --engine sweetistics.',
      );
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
      allowChrome: config.allowChrome ?? true,
      allowFirefox: config.allowFirefox ?? true,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    if (cookies.source) {
      console.error(`📍 Using credentials from: ${cookies.source}`);
    }

    console.error(`📝 Replying to tweet: ${tweetId}`);

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.reply(text, tweetId);

    if (result.success) {
      console.log('✅ Reply posted successfully!');
      console.log(`🔗 https://x.com/i/status/${result.tweetId}`);
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL reply failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).tweet(text, tweetId);
      if (fallback.success) {
        console.log('✅ Reply posted via Sweetistics (fallback)!');
        if (fallback.tweetId) {
          console.log(`🔗 https://x.com/i/status/${fallback.tweetId}`);
        }
      } else {
        console.error(`❌ Failed to post reply: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Failed to post reply: ${result.error}`);
      process.exit(1);
    }
  });

// Read command - fetch tweet content
program
  .command('read')
  .description('Read/fetch a tweet by ID or URL')
  .argument('<tweet-id-or-url>', 'Tweet ID or URL to read')
  .option('--json', 'Output as JSON')
  .action(async (tweetIdOrUrl: string, cmdOpts: { json?: boolean }) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));

    const tweetId = extractTweetId(tweetIdOrUrl);
    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      const client = new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      });
      const result = await client.read(tweetId);
      if (result.success && result.tweet) {
        if (cmdOpts.json) {
          console.log(JSON.stringify(result.tweet, null, 2));
        } else {
          console.log(`@${result.tweet.author.username} (${result.tweet.author.name}):`);
          console.log(result.tweet.text);
          if (result.tweet.createdAt) {
            console.log(`\n📅 ${result.tweet.createdAt}`);
          }
          console.log(
            `❤️ ${result.tweet.likeCount ?? 0}  🔁 ${result.tweet.retweetCount ?? 0}  💬 ${result.tweet.replyCount ?? 0}`,
          );
        }
        return;
      }
      console.error(`❌ Failed to read tweet via Sweetistics: ${result.error ?? 'Unknown error'}`);
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
      allowChrome: config.allowChrome ?? true,
      allowFirefox: config.allowFirefox ?? true,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.getTweet(tweetId);

    if (result.success && result.tweet) {
      if (cmdOpts.json) {
        console.log(JSON.stringify(result.tweet, null, 2));
      } else {
        console.log(`@${result.tweet.author.username} (${result.tweet.author.name}):`);
        console.log(result.tweet.text);
        if (result.tweet.createdAt) {
          console.log(`\n📅 ${result.tweet.createdAt}`);
        }
        console.log(
          `❤️ ${result.tweet.likeCount ?? 0}  🔁 ${result.tweet.retweetCount ?? 0}  💬 ${result.tweet.replyCount ?? 0}`,
        );
      }
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL read failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).read(tweetId);
      if (fallback.success && fallback.tweet) {
        if (cmdOpts.json) {
          console.log(JSON.stringify(fallback.tweet, null, 2));
        } else {
          console.log(`@${fallback.tweet.author.username} (${fallback.tweet.author.name}):`);
          console.log(fallback.tweet.text);
          if (fallback.tweet.createdAt) {
            console.log(`\n📅 ${fallback.tweet.createdAt}`);
          }
          console.log(
            `❤️ ${fallback.tweet.likeCount ?? 0}  🔁 ${fallback.tweet.retweetCount ?? 0}  💬 ${fallback.tweet.replyCount ?? 0}`,
          );
        }
      } else {
        console.error(`❌ Failed to read tweet: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Failed to read tweet: ${result.error}`);
      process.exit(1);
    }
  });

// Replies command - list replies to a tweet
program
  .command('replies')
  .description('List replies to a tweet (by ID or URL)')
  .argument('<tweet-id-or-url>', 'Tweet ID or URL')
  .option('--json', 'Output as JSON')
  .action(async (tweetIdOrUrl: string, cmdOpts: { json?: boolean }) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));
    const tweetId = extractTweetId(tweetIdOrUrl);
    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      const client = new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      });
      const result = await client.replies(tweetId);
      if (result.success && result.tweets) {
        printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No replies found.' });
        return;
      }
      console.error(`❌ Failed to fetch replies via Sweetistics: ${result.error}`);
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.getReplies(tweetId);

    if (result.success && result.tweets) {
      printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No replies found.' });
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL replies failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).replies(tweetId);
      if (fallback.success && fallback.tweets) {
        printTweets(fallback.tweets, { json: cmdOpts.json, emptyMessage: 'No replies found.' });
      } else {
        console.error(`❌ Failed to fetch replies: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Failed to fetch replies: ${result.error}`);
      process.exit(1);
    }
  });

// Thread command - show full conversation thread
program
  .command('thread')
  .description('Show the full conversation thread containing the tweet')
  .argument('<tweet-id-or-url>', 'Tweet ID or URL')
  .option('--json', 'Output as JSON')
  .action(async (tweetIdOrUrl: string, cmdOpts: { json?: boolean }) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));
    const tweetId = extractTweetId(tweetIdOrUrl);
    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      const client = new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      });
      const result = await client.thread(tweetId);
      if (result.success && result.tweets) {
        printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No thread tweets found.' });
        return;
      }
      console.error(`❌ Failed to fetch thread via Sweetistics: ${result.error}`);
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.getThread(tweetId);

    if (result.success && result.tweets) {
      printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No thread tweets found.' });
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL thread failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).thread(tweetId);
      if (fallback.success && fallback.tweets) {
        printTweets(fallback.tweets, { json: cmdOpts.json, emptyMessage: 'No thread tweets found.' });
      } else {
        console.error(`❌ Failed to fetch thread: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Failed to fetch thread: ${result.error}`);
      process.exit(1);
    }
  });

// Search command - find tweets
program
  .command('search')
  .description('Search for tweets')
  .argument('<query>', 'Search query (e.g., "@clawdbot" or "from:clawdbot")')
  .option('-n, --count <number>', 'Number of tweets to fetch', '10')
  .option('--json', 'Output as JSON')
  .action(async (query: string, cmdOpts: { count?: string; json?: boolean }) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    const count = Number.parseInt(cmdOpts.count || '10', 10);
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));

    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      const client = new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      });
      const result = await client.search(query, count);
      if (result.success && result.tweets) {
        printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No tweets found.' });
        return;
      }
      console.error(`❌ Search failed via Sweetistics: ${result.error}`);
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.search(query, count);

    if (result.success && result.tweets) {
      printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No tweets found.' });
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL search failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).search(query, count);
      if (fallback.success && fallback.tweets) {
        printTweets(fallback.tweets, { json: cmdOpts.json, emptyMessage: 'No tweets found.' });
      } else {
        console.error(`❌ Search failed: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Search failed: ${result.error}`);
      process.exit(1);
    }
  });

// Mentions command - shortcut to search for @username mentions
program
  .command('mentions')
  .description('Find tweets mentioning a user (defaults to current user)')
  .option('-u, --user <handle>', 'User handle (e.g. @steipete)')
  .option('-n, --count <number>', 'Number of tweets to fetch', '10')
  .option('--json', 'Output as JSON')
  .action(async (cmdOpts: { user?: string; count?: string; json?: boolean }) => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    const count = Number.parseInt(cmdOpts.count || '10', 10);
    const sweetistics = resolveSweetisticsConfig(opts);
    const engine = resolveEngineMode(opts.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));

    const explicitHandle = normalizeHandle(cmdOpts.user);
    let query: string | null = explicitHandle ? `@${explicitHandle}` : null;

    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }
      const client = new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      });

      if (!query) {
        const who = await client.getCurrentUser();
        const handle = normalizeHandle(who.user?.username);
        if (!handle) {
          console.error(`❌ Could not determine current user (${who.error ?? 'Unknown error'}). Use --user <handle>.`);
          process.exit(1);
        }
        query = `@${handle}`;
      }

      const result = await client.search(query, count);
      if (result.success && result.tweets) {
        printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No mentions found.' });
        return;
      }
      console.error(`❌ Failed to fetch mentions via Sweetistics: ${result.error}`);
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    const client = new TwitterClient({ cookies, timeoutMs });

    if (!query) {
      const who = await client.getCurrentUser();
      const handle = normalizeHandle(who.user?.username);
      if (!handle) {
        if (sweetistics.apiKey) {
          console.error(
            `⚠️ Could not determine current user (${who.error ?? 'Unknown error'}); trying Sweetistics fallback...`,
          );
          const fallbackWho = await new SweetisticsClient({
            baseUrl: sweetistics.baseUrl,
            apiKey: sweetistics.apiKey,
            timeoutMs,
          }).getCurrentUser();
          const fallbackHandle = normalizeHandle(fallbackWho.user?.username);
          if (!fallbackHandle) {
            console.error(`❌ Could not determine current user. Use --user <handle>.`);
            process.exit(1);
          }
          query = `@${fallbackHandle}`;
        } else {
          console.error(`❌ Could not determine current user (${who.error ?? 'Unknown error'}). Use --user <handle>.`);
          process.exit(1);
        }
      } else {
        query = `@${handle}`;
      }
    }

    const result = await client.search(query, count);

    if (result.success && result.tweets) {
      printTweets(result.tweets, { json: cmdOpts.json, emptyMessage: 'No mentions found.' });
    } else if (sweetistics.apiKey) {
      console.error(`⚠️ GraphQL mentions failed (${result.error}); trying Sweetistics fallback...`);
      const fallback = await new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      }).search(query, count);
      if (fallback.success && fallback.tweets) {
        printTweets(fallback.tweets, { json: cmdOpts.json, emptyMessage: 'No mentions found.' });
      } else {
        console.error(`❌ Failed to fetch mentions: ${result.error} | Sweetistics fallback: ${fallback.error}`);
        process.exit(1);
      }
    } else {
      console.error(`❌ Failed to fetch mentions: ${result.error}`);
      process.exit(1);
    }
  });

// Whoami command - show the logged-in account
program
  .command('whoami')
  .description('Show which Twitter account the current credentials belong to')
  .action(async () => {
    const opts = program.opts();
    const timeoutMs = resolveTimeoutFromOptions(opts);
    const sweetistics = resolveSweetisticsConfig({
      sweetisticsApiKey: opts.sweetisticsApiKey || config.sweetisticsApiKey,
      sweetisticsBaseUrl: opts.sweetisticsBaseUrl || config.sweetisticsBaseUrl,
    });
    const engine = resolveEngineMode(opts.engine || config.engine);
    const useSweetistics = shouldUseSweetistics(engine, Boolean(sweetistics.apiKey));
    const resolvedEngine = useSweetistics ? 'sweetistics' : 'graphql';
    if (useSweetistics) {
      if (!sweetistics.apiKey) {
        console.error('❌ Sweetistics engine selected but no API key provided.');
        process.exit(1);
      }

      const client = new SweetisticsClient({
        baseUrl: sweetistics.baseUrl,
        apiKey: sweetistics.apiKey,
        timeoutMs,
      });
      const result = await client.getCurrentUser();

      if (result.success && result.user) {
        const handle = result.user.username ? `@${result.user.username}` : '(no handle)';
        const name = result.user.name || handle;
        console.log(`🙋 Logged in via Sweetistics as ${handle} (${name})`);
        console.log(`🪪 User ID: ${result.user.id}`);
        if (result.user.email) {
          console.log(`📧 ${result.user.email}`);
        }
        console.log(`⚙️ Engine: ${resolvedEngine}`);
        console.log('🔑 Credentials: Sweetistics API key');
        return;
      }

      console.error(`❌ Failed to determine Sweetistics user: ${result.error ?? 'Unknown error'}`);
      process.exit(1);
    }

    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile || config.chromeProfile,
      firefoxProfile: opts.firefoxProfile || config.firefoxProfile,
      allowChrome: config.allowChrome ?? true,
      allowFirefox: config.allowFirefox ?? true,
    });

    for (const warning of warnings) {
      console.error(`⚠️ ${warning}`);
    }

    if (!cookies.authToken || !cookies.ct0) {
      console.error('❌ Missing required credentials');
      process.exit(1);
    }

    if (cookies.source) {
      console.error(`📍 Using credentials from: ${cookies.source}`);
    }

    const client = new TwitterClient({ cookies, timeoutMs });
    const result = await client.getCurrentUser();

    const credentialSource = cookies.source ?? 'env/auto-detected cookies';

    if (result.success && result.user) {
      console.log(`🙋 Logged in as @${result.user.username} (${result.user.name})`);
      console.log(`🪪 User ID: ${result.user.id}`);
      console.log(`⚙️ Engine: ${resolvedEngine}`);
      console.log(`🔑 Credentials: ${credentialSource}`);
    } else {
      // Fallback: try Sweetistics if available
      if (sweetistics.apiKey) {
        const fallback = await new SweetisticsClient({
          baseUrl: sweetistics.baseUrl,
          apiKey: sweetistics.apiKey,
          timeoutMs,
        }).getCurrentUser();
        if (fallback.success && fallback.user) {
          const handle = fallback.user.username ? `@${fallback.user.username}` : '(no handle)';
          const name = fallback.user.name || handle;
          console.log(`🙋 Logged in via Sweetistics as ${handle} (${name})`);
          console.log(`🪪 User ID: ${fallback.user.id}`);
          if (fallback.user.email) {
            console.log(`📧 ${fallback.user.email}`);
          }
          console.log('⚙️ Engine: sweetistics (fallback)');
          console.log('🔑 Credentials: Sweetistics API key');
          return;
        }
      }
      console.error(`❌ Failed to determine current user: ${result.error ?? 'Unknown error'}`);
      process.exit(1);
    }
  });

// Check command - verify credentials
program
  .command('check')
  .description('Check credential availability')
  .action(async () => {
    const opts = program.opts();
    const { cookies, warnings } = await resolveCredentials({
      authToken: opts.authToken,
      ct0: opts.ct0,
      chromeProfile: opts.chromeProfile,
    });

    console.log('🔍 Credential Check');
    console.log('─'.repeat(40));

    if (cookies.authToken) {
      console.log(`✅ auth_token: ${cookies.authToken.slice(0, 10)}...`);
    } else {
      console.log('❌ auth_token: not found');
    }

    if (cookies.ct0) {
      console.log(`✅ ct0: ${cookies.ct0.slice(0, 10)}...`);
    } else {
      console.log('❌ ct0: not found');
    }

    if (cookies.source) {
      console.log(`📍 Source: ${cookies.source}`);
    }

    if (warnings.length > 0) {
      console.log('\n⚠️ Warnings:');
      for (const warning of warnings) {
        console.log(`   - ${warning}`);
      }
    }

    if (cookies.authToken && cookies.ct0) {
      console.log('\n✅ Ready to tweet!');
    } else {
      console.log('\n❌ Missing credentials. Options:');
      console.log('   1. Login to x.com in Chrome');
      console.log('   2. Set AUTH_TOKEN and CT0 environment variables');
      console.log('   3. Use --auth-token and --ct0 flags');
      process.exit(1);
    }
  });

const rawArgs = process.argv.slice(2);
const { argv, showHelp } = resolveCliInvocation(rawArgs, KNOWN_COMMANDS);

if (showHelp) {
  program.outputHelp();
  process.exit(0);
}

if (argv) {
  program.parse(argv);
} else {
  program.parse();
}
