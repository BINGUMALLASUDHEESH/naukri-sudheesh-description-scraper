/**
 * Naukri Job Description Enricher
 * ---------------------------------------------------------------
 * Reads an existing scraped CSV (e.g. naukri_jobs_all.csv). For each
 * row that has a jdURL:
 *   1. Opens that job detail page URL with Playwright
 *   2. Captures the job detail API response that the page itself
 *      fires in the background:
 *        GET https://www.naukri.com/jobapi/v4/job/<jobId>?microsite=y&brandedConsultantJd=true
 *   3. Extracts jobDetails.description from that JSON
 *   4. Writes it into a new "descriptionFromApi" column
 *
 * Rows with no jdURL are skipped (left blank, logged as SKIPPED_NO_URL).
 *
 * THREE MODES (mirrors index.js's design):
 *
 * 1) Simple/local mode (default) - processes every row in the input CSV
 *    sequentially, writing naukri_jobs_enriched.csv.
 *      node enrich_descriptions.js
 *      INPUT_CSV=naukri_jobs_all.csv node enrich_descriptions.js
 *      MAX_ROWS=5 node enrich_descriptions.js   -> quick local test, first 5 rows only
 *
 * 2) Sharded/parallel mode - processes only a specific inclusive row
 *    range (1-indexed over the DATA rows, not counting the header),
 *    writing naukri_jobs_enriched_shard<SHARD_ID>.csv so 15 runners
 *    can work in parallel without colliding.
 *      SHARD_ID=1 START_ROW=1 END_ROW=94 node enrich_descriptions.js
 *
 * Resumable: re-running (locally or as the same shard in CI) reuses
 * any descriptions already captured in this shard's existing output
 * CSV and only fetches what's still missing - no duplicate work, no
 * duplicate rows.
 * ---------------------------------------------------------------
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ------------------------- CONFIG -------------------------
const SHARD_ID = process.env.SHARD_ID || '';
const shardSuffix = SHARD_ID ? `_shard${SHARD_ID}` : '';

const CONFIG = {
  INPUT_CSV: process.env.INPUT_CSV || path.join(__dirname, 'jobs_experience_0-1.csv'),
  OUTPUT_CSV: path.join(__dirname, `naukri_jobs_enriched${shardSuffix}.csv`),
  LOG_FILE: path.join(__dirname, `enrich_log${shardSuffix}.txt`),

  START_ROW: process.env.START_ROW ? parseInt(process.env.START_ROW, 10) : null, // 1-indexed, inclusive
  END_ROW: process.env.END_ROW ? parseInt(process.env.END_ROW, 10) : null,       // 1-indexed, inclusive
  MAX_ROWS: process.env.MAX_ROWS ? parseInt(process.env.MAX_ROWS, 10) : null,    // local quick-test cap

  NAV_TIMEOUT_MS: 45000,
  API_WAIT_TIMEOUT_MS: 30000,
  RETRIES_PER_JOB: 3,
  DELAY_BETWEEN_JOBS_MS: 2000,
  FORCE_RESTART: process.env.FORCE === '1',

  // Self-imposed time budget. When elapsed time crosses this, the script
  // stops picking up new rows, writes whatever it has so far, and exits
  // gracefully so progress is never lost.
  RUN_BUDGET_MS: (parseInt(process.env.RUN_BUDGET_MINUTES, 10) || 170) * 60 * 1000,

  // Rewrite the output CSV to disk after every N successful rows, so a
  // crash mid-shard doesn't lose everything since the last checkpoint.
  CHECKPOINT_EVERY: 5,
};

// ------------------------- HELPERS -------------------------

function logLine(message) {
  const stamp = new Date().toISOString();
  const prefix = SHARD_ID ? `[shard ${SHARD_ID}] ` : '';
  const line = `[${stamp}] ${prefix}${message}`;
  console.log(line);
  fs.appendFileSync(CONFIG.LOG_FILE, line + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read which jobIds are already marked COMPLETED in this shard's log.
function getCompletedJobIds() {
  if (CONFIG.FORCE_RESTART) return new Set();
  if (!fs.existsSync(CONFIG.LOG_FILE)) return new Set();
  const text = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
  const completed = new Set();
  const regex = /JOBID (\S+) COMPLETED/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    completed.add(m[1]);
  }
  return completed;
}

// Load any descriptions already captured in a previous (interrupted) run
// of this same shard, so we don't re-fetch them.
function loadExistingDescriptions() {
  const map = new Map(); // jobId -> descriptionFromApi
  if (CONFIG.FORCE_RESTART || !fs.existsSync(CONFIG.OUTPUT_CSV)) return map;
  try {
    const text = fs.readFileSync(CONFIG.OUTPUT_CSV, 'utf8');
    const rows = parse(text, { columns: true, skip_empty_lines: true });
    for (const row of rows) {
      if (row.jobId && row.descriptionFromApi) {
        map.set(row.jobId, row.descriptionFromApi);
      }
    }
  } catch (err) {
    logLine(`Could not parse existing output CSV for resume (will start fresh): ${err.message}`);
  }
  return map;
}

function writeOutputCsv(rows, columns) {
  const csvText = stringify(rows, { header: true, columns });
  fs.writeFileSync(CONFIG.OUTPUT_CSV, csvText, 'utf8');
}

// Extract the jobId from a jdURL as a fallback, in case the CSV's jobId
// column is ever blank but the URL still contains it (URLs end in -<jobId>).
function jobIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/-(\d{9,})(?:$|\?)/);
  return match ? match[1] : null;
}

async function fetchDescriptionForRow(context, row) {
  const jobId = row.jobId || jobIdFromUrl(row.jdURL);
  const jdURL = row.jdURL;

  for (let attempt = 1; attempt <= CONFIG.RETRIES_PER_JOB; attempt++) {
    const page = await context.newPage();
    try {
      logLine(`JOBID ${jobId} attempt ${attempt}/${CONFIG.RETRIES_PER_JOB} - opening ${jdURL}`);

      const [response] = await Promise.all([
        page.waitForResponse(
          (resp) => resp.url().includes('/jobapi/v4/job/') && resp.status() === 200,
          { timeout: CONFIG.API_WAIT_TIMEOUT_MS }
        ),
        page.goto(jdURL, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT_MS }),
      ]);

      const data = await response.json();
      const description = data?.jobDetails?.description || '';

      await page.close();

      if (description) {
        return description;
      }
      logLine(`JOBID ${jobId} attempt ${attempt} - API responded but description was empty`);
    } catch (err) {
      logLine(`JOBID ${jobId} attempt ${attempt} - ERROR: ${err.message}`);
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    if (attempt < CONFIG.RETRIES_PER_JOB) {
      await sleep(CONFIG.DELAY_BETWEEN_JOBS_MS);
    }
  }
  return null; // failed after all retries
}

// ------------------------- MAIN -------------------------

(async () => {
  if (!fs.existsSync(CONFIG.INPUT_CSV)) {
    console.error(`Input CSV not found: ${CONFIG.INPUT_CSV}`);
    process.exit(1);
  }

  const inputText = fs.readFileSync(CONFIG.INPUT_CSV, 'utf8');
  const allRows = parse(inputText, { columns: true, skip_empty_lines: true });
  const originalColumns = Object.keys(allRows[0] || {});
  const outputColumns = originalColumns.includes('descriptionFromApi')
    ? originalColumns
    : [...originalColumns, 'descriptionFromApi'];

  logLine(`Input CSV loaded: ${allRows.length} total rows, ${originalColumns.length} columns`);

  // Determine which slice of rows this run/shard is responsible for.
  let startIdx = 0; // 0-indexed into allRows
  let endIdx = allRows.length - 1;

  if (CONFIG.START_ROW && CONFIG.END_ROW) {
    startIdx = CONFIG.START_ROW - 1;
    endIdx = Math.min(CONFIG.END_ROW - 1, allRows.length - 1);
    logLine(`SHARDED MODE: processing rows ${CONFIG.START_ROW}-${CONFIG.END_ROW} (of ${allRows.length} total)`);
  } else if (CONFIG.MAX_ROWS) {
    endIdx = Math.min(CONFIG.MAX_ROWS - 1, allRows.length - 1);
    logLine(`LOCAL TEST MODE: processing first ${CONFIG.MAX_ROWS} rows only`);
  } else {
    logLine(`SIMPLE MODE: processing all ${allRows.length} rows`);
  }

  const shardRows = allRows.slice(startIdx, endIdx + 1);

  // Resume support: reuse descriptions already captured in a prior
  // (possibly interrupted) run of this exact shard.
  const existingDescriptions = loadExistingDescriptions();
  const completedJobIds = getCompletedJobIds();
  if (existingDescriptions.size > 0) {
    logLine(`Resuming: found ${existingDescriptions.size} already-captured descriptions in existing output CSV`);
  }

  // Apply any already-known descriptions up front.
  for (const row of shardRows) {
    row.descriptionFromApi = existingDescriptions.get(row.jobId) || row.descriptionFromApi || '';
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  const runStartTime = Date.now();
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let sinceLastCheckpoint = 0;

  try {
    for (const row of shardRows) {
      const jobId = row.jobId || jobIdFromUrl(row.jdURL);

      // Already resolved from a previous interrupted run, or already
      // marked completed in the log -> nothing to do.
      if (row.descriptionFromApi && row.descriptionFromApi.trim() !== '') {
        continue;
      }
      if (jobId && completedJobIds.has(jobId)) {
        continue;
      }

      // No jdURL at all -> skip this row (per your instructions).
      if (!row.jdURL || row.jdURL.trim() === '') {
        logLine(`JOBID ${jobId || '(unknown)'} SKIPPED_NO_URL`);
        skipCount++;
        continue;
      }

      const elapsed = Date.now() - runStartTime;
      if (elapsed >= CONFIG.RUN_BUDGET_MS) {
        logLine(
          `RUN BUDGET REACHED (${Math.round(elapsed / 60000)} min elapsed) - stopping gracefully. ` +
          `Progress so far is saved; a future run can resume from here.`
        );
        break;
      }

      const description = await fetchDescriptionForRow(context, row);

      if (description) {
        row.descriptionFromApi = description;
        logLine(`JOBID ${jobId} COMPLETED - description captured (${description.length} chars)`);
        successCount++;
        sinceLastCheckpoint++;
      } else {
        logLine(`JOBID ${jobId} FAILED after ${CONFIG.RETRIES_PER_JOB} attempts - will retry on next run`);
        failCount++;
      }

      // Periodic checkpoint: rewrite the full shard CSV so a crash
      // doesn't lose everything since the last save.
      if (sinceLastCheckpoint >= CONFIG.CHECKPOINT_EVERY) {
        writeOutputCsv(shardRows, outputColumns);
        logLine(`Checkpoint saved (${successCount} completed so far)`);
        sinceLastCheckpoint = 0;
      }

      await sleep(CONFIG.DELAY_BETWEEN_JOBS_MS);
    }
  } catch (err) {
    logLine(`FATAL ERROR: ${err.message}`);
  } finally {
    // Always do a final full write, regardless of how the loop ended.
    writeOutputCsv(shardRows, outputColumns);
    await browser.close();
  }

  logLine(
    `Run finished. Rows in range: ${shardRows.length}. ` +
    `Completed: ${successCount}. Skipped (no URL): ${skipCount}. Failed: ${failCount}.`
  );
})();
