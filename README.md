# Remote jobs list

A one-page list of remote admin, EA, bookkeeping and payroll jobs open to South Africa-based candidates in SA-friendly hours (03:30–20:00 SAST), with no degree required.

- `index.html`: the page (GitHub Pages serves it).
- `jobs.json`: the job list the page loads.
- `scripts/update-jobs.mjs`: daily refresh. It removes closed postings and adds new ones from Workable, Teamtailor and Remotive feeds that pass the filters (no US hours, no degree requirement, never pay-to-apply).
- `.github/workflows/update-jobs.yml`: runs the refresh every day at 06:43 SAST. Run it by hand from **Actions → Update job list → Run workflow**.

Her saved CV and "Done" marks stay in her own browser and are never uploaded.
