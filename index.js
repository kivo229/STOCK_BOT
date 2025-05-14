/**
 * Financial News Telegram Bot with Express Server
 * 
 * This bot monitors financial news feeds and sends alerts to a Telegram channel
 * when news articles likely to affect the stock market are detected.
 * It includes an Express server to keep the application running on platforms like Replit.
 * 
 * Features:
 * - Parses RSS feeds from financial news sources
 * - Filters articles based on market-moving keywords
 * - Performs basic sentiment analysis
 * - Avoids duplicate alerts using in-memory cache
 * - Sends formatted alerts to a Telegram channel
 * - Includes Express server to keep the application alive
 */

const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const axios = require('axios');
const express = require('express');
const fs = require('fs');

// ================= CONFIGURATION =================

// Cache configuration
const CACHE_FILE = '.article_cache.json';
const MAX_CACHE_SIZE = 1000; // Maximum number of articles to keep in cache

// Telegram configuration
const BOT_TOKEN = process.env.TELEGRAM_TOKEN; // Replace with your bot token
const CHANNEL_USERNAME = process.env.CHANNEL_ID; // Replace with your channel username (include the @ symbol)

// RSS Feed URLs (add or remove as needed)
const RSS_FEEDS = [
  'https://finance.yahoo.com/news/rssindex',
  'https://www.marketwatch.com/rss/topstories',
  'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  'https://www.moneycontrol.com/rss/market.xml',
  'https://www.business-standard.com/rss/markets-106.rss'
];

// Check interval in milliseconds (3 minutes to reduce frequency)
const CHECK_INTERVAL = 3 * 60 * 1000;

// Express server port (for Replit)
const PORT = process.env.PORT || 3000;

// Delay between processing articles (to prevent sending too many messages at once)
const MESSAGE_DELAY = 2000; // 2 seconds between messages

// ================= KEYWORD LISTS =================

// Keywords that suggest market-moving news
const MARKET_KEYWORDS = [
  'fed', 'federal reserve', 'interest rate', 'rates', 'inflation', 'cpi', 'gdp', 'unemployment',
  'nifty', 'sensex', 'bse', 'nse', 'rbi', 'sebi', 'rupee', 'rbi governor',
  'earnings', 'revenue', 'profit', 'loss', 'forecast', 'guidance', 'outlook',
  'crash', 'correction', 'bear market', 'bull market', 'recession', 'depression',
  'rally', 'surge', 'plunge', 'tumble', 'soar', 'slump',
  'stock market', 'wall street', 'dow jones', 'nasdaq', 's&p', 'russell',
  'treasury', 'bond', 'yield', 'debt', 'default',
  'ipo', 'merger', 'acquisition', 'bankrupt', 'chapter 11',
  'economic', 'economy', 'fiscal', 'monetary policy',
  'stimulus', 'bailout', 'regulation', 'deregulation',
  'trade war', 'tariff', 'sanction', 'embargo'
];

// Positive sentiment keywords
const POSITIVE_KEYWORDS = [
  'rise', 'rises', 'rising', 'rose', 'gain', 'gains', 'gained', 'up', 'higher',
  'surge', 'surges', 'surged', 'rally', 'rallies', 'rallied', 'recover', 'recovers', 'recovered',
  'beat', 'beats', 'beating', 'exceed', 'exceeds', 'exceeded', 'outperform', 'outperforms',
  'strong', 'stronger', 'strongest', 'positive', 'optimistic', 'optimism', 'confidence',
  'bullish', 'boom', 'soar', 'soars', 'soared', 'jump', 'jumps', 'jumped',
  'growth', 'expand', 'expands', 'expanded', 'breakthrough', 'success'
];

// Negative sentiment keywords
const NEGATIVE_KEYWORDS = [
  'fall', 'falls', 'falling', 'fell', 'drop', 'drops', 'dropped', 'down', 'lower',
  'plunge', 'plunges', 'plunged', 'tumble', 'tumbles', 'tumbled', 'sink', 'sinks', 'sank',
  'miss', 'misses', 'missed', 'fail', 'fails', 'failed', 'underperform', 'underperforms',
  'weak', 'weaker', 'weakest', 'negative', 'pessimistic', 'pessimism', 'concern', 'concerned',
  'bearish', 'bust', 'crash', 'crashes', 'crashed', 'collapse', 'collapses', 'collapsed',
  'decline', 'declines', 'declined', 'shrink', 'shrinks', 'shrank', 'crisis', 'warning'
];

// ================= INITIALIZE COMPONENTS =================

// Initialize Express app
const app = express();

// Initialize Telegram bot
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Initialize RSS parser
const parser = new Parser();

// Article cache to prevent duplicate alerts
let articleCache = new Set();
let titleCache = new Map(); // Cache for recent titles to check similarity

// Load cache from file if exists
try {
  if (fs.existsSync(CACHE_FILE)) {
    const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    articleCache = new Set(cacheData);
    console.log(`Loaded ${articleCache.size} articles from cache file.`);
  }
} catch (error) {
  console.error('Error loading cache file:', error.message);
  // Continue with empty cache if file cannot be loaded
}

// ================= HELPER FUNCTIONS =================

/**
 * Checks if an article contains market-moving keywords
 * @param {Object} article - Article object from RSS feed
 * @returns {Boolean} True if article contains market keywords
 */
function isMarketRelevant(article) {
  const content = (article.title + ' ' + (article.contentSnippet || '')).toLowerCase();

  return MARKET_KEYWORDS.some(keyword => content.includes(keyword.toLowerCase()));
}

/**
 * Performs basic sentiment analysis on article text
 * @param {Object} article - Article object from RSS feed
 * @returns {Object} Sentiment result with score and emoji
 */
function analyzeSentiment(article) {
  const content = (article.title + ' ' + (article.contentSnippet || '')).toLowerCase();

  let positiveScore = 0;
  let negativeScore = 0;

  // Count positive keyword occurrences
  POSITIVE_KEYWORDS.forEach(keyword => {
    const regex = new RegExp('\\b' + keyword.toLowerCase() + '\\b', 'g');
    const matches = content.match(regex);
    if (matches) positiveScore += matches.length;
  });

  // Count negative keyword occurrences
  NEGATIVE_KEYWORDS.forEach(keyword => {
    const regex = new RegExp('\\b' + keyword.toLowerCase() + '\\b', 'g');
    const matches = content.match(regex);
    if (matches) negativeScore += matches.length;
  });

  // Determine overall sentiment
  let emoji, sentiment;
  if (positiveScore > negativeScore) {
    emoji = '🟢';
    sentiment = 'positive';
  } else if (negativeScore > positiveScore) {
    emoji = '🔴';
    sentiment = 'negative';
  } else {
    emoji = '⚪';
    sentiment = 'neutral';
  }

  return {
    score: positiveScore - negativeScore,
    sentiment,
    emoji
  };
}

/**
 * Creates a formatted message for Telegram
 * @param {Object} article - Article object from RSS feed
 * @param {Object} sentiment - Sentiment analysis result
 * @returns {String} Formatted HTML message
 */
function formatMessage(article, sentiment) {
  const title = article.title.trim();
  const link = article.link;
  const source = article.creator || article.author || new URL(link).hostname;
  const date = article.isoDate ? new Date(article.isoDate).toLocaleString() : new Date().toLocaleString();

  return `
${sentiment.emoji} <b>${title}</b>

Source: ${source}
Published: ${date}
Sentiment: ${sentiment.sentiment.charAt(0).toUpperCase() + sentiment.sentiment.slice(1)}

<a href="${link}">Read more</a>
`;
}

/**
 * Sends a message to the Telegram channel
 * @param {String} message - Formatted HTML message
 * @returns {Promise}
 */
async function sendToTelegram(message) {
  const maxRetries = 3;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await bot.sendMessage(CHANNEL_USERNAME, message, { parse_mode: 'HTML' });
      console.log(`Message sent to ${CHANNEL_USERNAME}`);
      return;
    } catch (error) {
      if (error.message.includes('429')) {
        const match = error.message.match(/retry after (\d+)/i);
        const waitTime = match ? parseInt(match[1]) * 1000 : 30000;
        console.log(`Rate limited. Waiting ${waitTime/1000} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
      } else {
        console.error('Error sending message to Telegram:', error.message);
        return;
      }
    }
  }
  console.error('Max retries reached for message');
}

/**
 * Checks if a title is similar to recently posted titles
 * @param {String} title - Article title to check
 * @returns {Boolean} True if similar title exists
 */
function isSimilarTitleExists(title) {
  const normalizedTitle = title.toLowerCase().trim();
  for (const [cachedTitle, timestamp] of titleCache) {
    // Remove old titles (older than 1 hour)
    if (Date.now() - timestamp > 3600000) {
      titleCache.delete(cachedTitle);
      continue;
    }
    
    // Check for high similarity
    if (cachedTitle.includes(normalizedTitle) || normalizedTitle.includes(cachedTitle)) {
      return true;
    }
  }
  return false;
}

/**
 * Adds an article to the cache and maintains max size
 * @param {String} articleId - Unique identifier for the article
 * @param {String} title - Article title
 */
function addToCache(articleId, title) {
  articleCache.add(articleId);
  titleCache.set(title.toLowerCase().trim(), Date.now());

  // Clear cache if it exceeds maximum size
  if (articleCache.size > MAX_CACHE_SIZE) {
    console.log(`Cache reached ${articleCache.size} items. Clearing oldest entries...`);
    const itemsToKeep = Array.from(articleCache).slice(-Math.floor(MAX_CACHE_SIZE / 2));
    articleCache.clear();
    itemsToKeep.forEach(item => articleCache.add(item));
    console.log(`Cache cleared. New size: ${articleCache.size}`);
  }
}

/**
 * Fetches and processes RSS feeds
 */
async function checkNewsFeeds() {
  console.log(`Checking news feeds at ${new Date().toLocaleString()}...`);

  for (const feedUrl of RSS_FEEDS) {
    try {
      console.log(`Fetching feed: ${feedUrl}`);
      const feed = await parser.parseURL(feedUrl);

      for (const article of feed.items) {
        // Create a unique ID for the article
        const articleId = article.guid || article.link;

        // Skip if article is already in cache or has similar title
        if (articleCache.has(articleId) || isSimilarTitleExists(article.title)) {
          continue;
        }

        // Check if article is market-relevant
        if (isMarketRelevant(article)) {
          console.log(`Market-relevant article found: ${article.title}`);

          // Analyze sentiment
          const sentiment = analyzeSentiment(article);

          // Format and send message
          const message = formatMessage(article, sentiment);
          await sendToTelegram(message);

          // Add to cache after successful processing
          addToCache(articleId, article.title);
        }
      }
    } catch (error) {
      console.error(`Error processing feed ${feedUrl}:`, error.message);
    }
  }
}

// ================= MAIN APPLICATION =================

/**
 * Start the application
 */
function startBot() {
  console.log('Financial News Telegram Bot starting...');

  // Verify bot token and channel access
  bot.getMe()
    .then(botInfo => {
      console.log(`Bot connected successfully. Bot name: ${botInfo.username}`);

      // Run initial check
      checkNewsFeeds();

      // Set interval for regular checks
      setInterval(checkNewsFeeds, CHECK_INTERVAL);

      console.log(`Bot is now monitoring ${RSS_FEEDS.length} feeds at ${CHECK_INTERVAL/1000} second intervals`);
    })
    .catch(error => {
      console.error('Error initializing bot:', error.message);
      console.error('Please check your BOT_TOKEN and make sure the bot has been properly created with BotFather');
      process.exit(1);
    });
}

// Start the bot when the script is run
startBot();

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('Bot is shutting down...');

  // Save cache to file before exit
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Array.from(articleCache)));
    console.log(`Saved ${articleCache.size} articles to cache file.`);
  } catch (error) {
    console.error('Error saving cache on exit:', error.message);
  }

  process.exit(0);
});