# Naukri AI/Gen AI Jobs — Scraper + Description Enricher

Two connected pieces:

1. **`index.js`** — scrapes Naukri search-result pages into `naukri_jobs.csv`
   (or, when sharded on GitHub Actions, `naukri_jobs_shard<N>.csv` files
   merged into `naukri_jobs_all.csv`).
2. **`enrich_descriptions.js`** — takes that CSV, visits each job's detail
   page, captures the `jobapi/v4/job/<id>` response, and adds a
   `descriptionFromApi` column with the full job description.

Both support running solo locally, or as 15 parallel shards on GitHub
Actions (see `.github/workflows/scrape.yml` and `.github/workflows/enrich.yml`).

---

## 1. Local setup (do this first)

```bash
npm install
npx playwright install --with-deps chromium
```

## 2. Run the scraper locally (small test first)

```bash
node index.js              # scrapes 3 pages by default (CONFIG.PAGES)
PAGES=10 node index.js     # scrape 10 pages
PAGES=ALL node index.js    # scrape every page Naukri reports
```

Output: `naukri_jobs.csv`, `scrape_log.txt`, `raw_pages/` (raw API JSON per page).

Resumable: rerunning skips pages already marked `COMPLETED` in
`scrape_log.txt`. Use `FORCE=1 node index.js` to force a full re-scrape.

## 3. Run the enricher locally (small test first)

Needs a CSV already produced by step 2 (defaults to `naukri_jobs_all.csv`
in the same folder — override with `INPUT_CSV=naukri_jobs.csv` if you're
testing against the smaller local file instead).

```bash
MAX_ROWS=5 node enrich_descriptions.js     # quick 5-row sanity check
node enrich_descriptions.js                # process the whole file
```

Output: `naukri_jobs_enriched.csv`, `enrich_log.txt`.

Rows without a `jdURL` are skipped and logged as `SKIPPED_NO_URL`.
Resumable and checkpointed every 5 rows, same idea as the scraper.

## 4. Analyze results in Google Colab

Open `naukri_analysis.py` in Colab (paste the whole thing into one cell,
or split at each `# %% [cell N]` marker). It'll prompt you to upload your
CSV, then produces:
- unique company count + jobs-per-company (table + chart)
- experience-range breakdown, exact and bucketed (tables + charts)
- auto-generated written conclusions based on your real numbers

## 5. Push to GitHub

```bash
git init                     # skip if already a repo
git add .
git commit -m "Naukri scraper + enricher"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `raw_pages*/`, and OS/editor
cruft — those never get pushed.

## 6. Run it on GitHub Actions

Go to your repo's **Actions** tab. Two workflows will appear:

- **"Naukri Job Scraper (Parallel - 15 shards)"** — scrapes all pages in
  15 parallel runners, merges into `naukri_jobs_all.csv`, commits it back.
- **"Naukri Description Enricher (Parallel - 15 shards)"** — reads
  `naukri_jobs_all.csv` (or whichever CSV you specify), enriches
  descriptions in 15 parallel runners, merges into
  `naukri_jobs_all_enriched.csv`, commits it back.

Both need **Settings → Actions → General → Workflow permissions → "Read
and write permissions"** enabled (one-time repo setting) so the final
commit/push step can succeed.

Trigger either one manually via **Run workflow**, or let the built-in
`schedule:` cron in each `.yml` file run them automatically every few
hours.

---

## File reference

| File | Purpose |
|---|---|
| `index.js` | Scraper — search pages → job list CSV |
| `enrich_descriptions.js` | Enricher — job list CSV → full descriptions CSV |
| `naukri_analysis.py` | Colab script — company & experience analysis with charts |
| `package.json` | Dependencies (`playwright`, `csv-parse`, `csv-stringify`) and npm scripts |
| `.gitignore` | Keeps `node_modules/`, raw JSON dumps, and OS files out of git |
| `.github/workflows/scrape.yml` | 15-shard parallel scraping workflow |
| `.github/workflows/enrich.yml` | 15-shard parallel enrichment workflow |
