/**
 * scraper.js — Puppeteer-based HTML fetcher for Yupoo pages.
 *
 * Launches a single shared browser instance (created on first use, reused
 * across requests) so we don't pay the cold-start cost on every request.
 * Each fetch opens a new page, navigates, waits for content, grabs the HTML,
 * then closes the page.  The browser itself stays alive until the process
 * exits or `closeBrowser()` is called explicitly.
 */

const puppeteer = require('puppeteer');

/** Shared browser instance — null until first call to `fetchHTML`. */
let browser = null;

/** Serialised promise so concurrent requests don't race to launch the browser. */
let browserLaunchPromise = null;

/**
 * Returns the shared browser, launching it if necessary.
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function getBrowser() {
  if (browser && browser.connected) return browser;

  // If a launch is already in progress, wait for it instead of starting another.
  if (browserLaunchPromise) return browserLaunchPromise;

  console.log('[SCRAPER] Launching browser...');

  browserLaunchPromise = puppeteer
    .launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',   // avoids /dev/shm exhaustion in containers
        '--disable-gpu',
        '--no-zygote',
        // NOTE: --single-process is intentionally omitted — it causes crashes
        // in containerised environments (Railway) when multiple pages are open.
      ],
    })
    .then((b) => {
      browser = b;
      browserLaunchPromise = null;
      console.log('[SCRAPER] Browser launched successfully.');

      // If Chromium crashes, clear the reference so the next request re-launches.
      b.on('disconnected', () => {
        console.warn('[SCRAPER] Browser disconnected — will relaunch on next request.');
        browser = null;
      });

      return b;
    })
    .catch((err) => {
      browserLaunchPromise = null;
      console.error('[SCRAPER] Browser launch failed:', err.message);
      throw err;
    });

  return browserLaunchPromise;
}

/**
 * Fetches the fully-rendered HTML of `url` using a headless Chromium browser.
 * Retries once on navigation failure before giving up.
 *
 * @param {string} url          - The page URL to load.
 * @param {object} [options]
 * @param {string} [options.referer]  - Referer header to send.
 * @param {number} [options.timeout]  - Navigation timeout in ms (default 30 000).
 * @param {number} [options.retries]  - Number of retry attempts on failure (default 1).
 * @returns {Promise<string>}   - The page's outer HTML after JS has run.
 */
async function fetchHTML(url, { referer = 'https://www.yupoo.com/', timeout = 30000, retries = 1 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[SCRAPER] Retrying (attempt ${attempt + 1}) for: ${url}`);
    }

    const b = await getBrowser();
    const page = await b.newPage();

    try {
      console.log(`[SCRAPER] Navigating to: ${url}`);

      // Mimic a real Chrome browser to avoid bot-detection fingerprinting.
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': referer,
      });

      // Block images/fonts/media to speed up page loads — we only need the DOM.
      // Stylesheets are allowed through so JS that depends on CSSOM still works.
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'media', 'font'].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout,
      });

      // Give any lazy-loaded JS a moment to populate the DOM.
      await page.waitForTimeout(3000);

      const html = await page.content();
      console.log(`[SCRAPER] Page loaded successfully (${html.length} bytes): ${url}`);
      return html;

    } catch (err) {
      lastError = err;
      console.error(`[SCRAPER] Navigation error (attempt ${attempt + 1}):`, err.message);
    } finally {
      // Always close the page to free memory, even on error.
      await page.close().catch(() => {});
    }
  }

  throw lastError;
}

/**
 * Gracefully shuts down the shared browser.
 * Call this on process exit if you want a clean shutdown.
 */
async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// Clean up on process termination.
process.on('exit', () => { closeBrowser(); });
process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });

module.exports = { fetchHTML, closeBrowser };
