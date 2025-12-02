/**
 * Twitter GraphQL API client for posting tweets and replies
 */

import type { TwitterCookies } from './cookies.js';

const TWITTER_API_BASE = 'https://x.com/i/api/graphql';

// Twitter GraphQL query IDs - these may need to be updated periodically
// as Twitter rotates them. Check browser network tab for current values.
// Source: https://github.com/fa0311/TwitterInternalAPIDocument
const QUERY_IDS = {
  CreateTweet: 'TAJw1rBsjAtdNgTdlo2oeg',
  CreateRetweet: 'ojPdsZsimiJrUGLR1sjUtA',
  FavoriteTweet: 'lI07N6Otwv1PhnEgXILM7A',
  TweetDetail: 'nBS-WpgA6ZG0CyNHD517JQ',
};

export interface TweetResult {
  success: boolean;
  tweetId?: string;
  error?: string;
}

export interface TweetData {
  id: string;
  text: string;
  author: {
    username: string;
    name: string;
  };
  createdAt?: string;
  replyCount?: number;
  retweetCount?: number;
  likeCount?: number;
}

export interface GetTweetResult {
  success: boolean;
  tweet?: TweetData;
  error?: string;
}

export interface TwitterClientOptions {
  cookies: TwitterCookies;
  userAgent?: string;
}

interface CreateTweetResponse {
  data?: {
    create_tweet?: {
      tweet_results?: {
        result?: {
          rest_id?: string;
          legacy?: {
            full_text?: string;
          };
        };
      };
    };
  };
  errors?: Array<{ message: string; code?: number }>;
}

export class TwitterClient {
  private authToken: string;
  private ct0: string;
  private userAgent: string;

  constructor(options: TwitterClientOptions) {
    if (!options.cookies.authToken || !options.cookies.ct0) {
      throw new Error('Both authToken and ct0 cookies are required');
    }
    this.authToken = options.cookies.authToken;
    this.ct0 = options.cookies.ct0;
    this.userAgent =
      options.userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }

  private findTweetInInstructions(
    instructions:
      | Array<{
          entries?: Array<{
            content?: {
              itemContent?: {
                tweet_results?: {
                  result?: {
                    rest_id?: string;
                    legacy?: {
                      full_text?: string;
                      created_at?: string;
                      reply_count?: number;
                      retweet_count?: number;
                      favorite_count?: number;
                    };
                    core?: {
                      user_results?: {
                        result?: {
                          legacy?: {
                            screen_name?: string;
                            name?: string;
                          };
                        };
                      };
                    };
                  };
                };
              };
            };
          }>;
        }>
      | undefined,
    tweetId: string,
  ) {
    if (!instructions) return undefined;

    for (const instruction of instructions) {
      for (const entry of instruction.entries || []) {
        const result = entry.content?.itemContent?.tweet_results?.result;
        if (result?.rest_id === tweetId) {
          return result;
        }
      }
    }

    return undefined;
  }

  private getHeaders(): Record<string, string> {
    return {
      authorization:
        'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      'content-type': 'application/json',
      'x-csrf-token': this.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      cookie: `auth_token=${this.authToken}; ct0=${this.ct0}`,
      'user-agent': this.userAgent,
      origin: 'https://x.com',
      referer: 'https://x.com/',
    };
  }

  /**
   * Get tweet details by ID
   */
  async getTweet(tweetId: string): Promise<GetTweetResult> {
    const variables = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      rankingMode: 'Relevance',
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
    };

    const features = {
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    };

    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(features),
    });

    const url = `${TWITTER_API_BASE}/${QUERY_IDS.TweetDetail}/TweetDetail?${params}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        };
      }

      const data = (await response.json()) as {
        data?: {
          tweetResult?: {
            result?: {
              rest_id?: string;
              legacy?: {
                full_text?: string;
                created_at?: string;
                reply_count?: number;
                retweet_count?: number;
                favorite_count?: number;
              };
              core?: {
                user_results?: {
                  result?: {
                    legacy?: {
                      screen_name?: string;
                      name?: string;
                    };
                  };
                };
              };
            };
          };
          threaded_conversation_with_injections_v2?: {
            instructions?: Array<{
              entries?: Array<{
                content?: {
                  itemContent?: {
                    tweet_results?: {
                      result?: {
                        rest_id?: string;
                        legacy?: {
                          full_text?: string;
                          created_at?: string;
                          reply_count?: number;
                          retweet_count?: number;
                          favorite_count?: number;
                        };
                        core?: {
                          user_results?: {
                            result?: {
                              legacy?: {
                                screen_name?: string;
                                name?: string;
                              };
                            };
                          };
                        };
                      };
                    };
                  };
                };
              }>;
            }>;
          };
        };
        errors?: Array<{ message: string }>;
      };

      if (data.errors && data.errors.length > 0) {
        return {
          success: false,
          error: data.errors.map((e) => e.message).join(', '),
        };
      }

      // Prefer direct tweetResult if present, otherwise search the conversation thread
      const tweetResult =
        data.data?.tweetResult?.result ??
        this.findTweetInInstructions(data.data?.threaded_conversation_with_injections_v2?.instructions, tweetId);

      if (!tweetResult) {
        return {
          success: false,
          error: 'Tweet not found in response',
        };
      }

      const legacy = tweetResult.legacy;
      const userLegacy = tweetResult.core?.user_results?.result?.legacy;

      if (!legacy?.full_text || !userLegacy?.screen_name) {
        return {
          success: false,
          error: 'Incomplete tweet data',
        };
      }

      return {
        success: true,
        tweet: {
          id: tweetResult.rest_id || tweetId,
          text: legacy.full_text,
          author: {
            username: userLegacy.screen_name,
            name: userLegacy.name || userLegacy.screen_name,
          },
          createdAt: legacy.created_at,
          replyCount: legacy.reply_count,
          retweetCount: legacy.retweet_count,
          likeCount: legacy.favorite_count,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Post a new tweet
   */
  async tweet(text: string): Promise<TweetResult> {
    const variables = {
      tweet_text: text,
      dark_request: false,
      media: {
        media_entities: [],
        possibly_sensitive: false,
      },
      semantic_annotation_ids: [],
    };

    const features = {
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: false,
      responsive_web_jetfuel_frame: true,
      responsive_web_grok_share_attachment_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_grok_analysis_button_from_backend: true,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: false,
      rweb_tipjar_consumption_enabled: true,
      verified_phone_label_enabled: false,
      articles_preview_enabled: true,
      responsive_web_grok_community_note_auto_translation_is_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      responsive_web_grok_image_annotation_enabled: true,
      responsive_web_grok_imagine_annotation_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    };

    return this.createTweet(variables, features);
  }

  /**
   * Reply to an existing tweet
   */
  async reply(text: string, replyToTweetId: string): Promise<TweetResult> {
    const variables = {
      tweet_text: text,
      reply: {
        in_reply_to_tweet_id: replyToTweetId,
        exclude_reply_user_ids: [],
      },
      dark_request: false,
      media: {
        media_entities: [],
        possibly_sensitive: false,
      },
      semantic_annotation_ids: [],
    };

    const features = {
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: false,
      responsive_web_jetfuel_frame: true,
      responsive_web_grok_share_attachment_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_grok_analysis_button_from_backend: true,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: false,
      rweb_tipjar_consumption_enabled: true,
      verified_phone_label_enabled: false,
      articles_preview_enabled: true,
      responsive_web_grok_community_note_auto_translation_is_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      responsive_web_grok_image_annotation_enabled: true,
      responsive_web_grok_imagine_annotation_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    };

    return this.createTweet(variables, features);
  }

  private async createTweet(
    variables: Record<string, unknown>,
    features: Record<string, boolean>,
  ): Promise<TweetResult> {
    const url = `${TWITTER_API_BASE}/${QUERY_IDS.CreateTweet}/CreateTweet`;

    const body = JSON.stringify({
      variables,
      features,
      queryId: QUERY_IDS.CreateTweet,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body,
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        };
      }

      const data = (await response.json()) as CreateTweetResponse;

      if (data.errors && data.errors.length > 0) {
        return {
          success: false,
          error: data.errors.map((e) => e.message).join(', '),
        };
      }

      const tweetId = data.data?.create_tweet?.tweet_results?.result?.rest_id;
      if (tweetId) {
        return {
          success: true,
          tweetId,
        };
      }

      return {
        success: false,
        error: 'Tweet created but no ID returned',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
