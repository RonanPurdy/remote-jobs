// Daily job list refresh. Runs in GitHub Actions on Node 20+, no dependencies.
// 1. Removes jobs whose posting is closed or gone.
// 2. Adds new remote jobs from public job feeds that pass her filters.
// Writes jobs.json only when something changed.

import { readFile, writeFile } from "node:fs/promises";

const FILE = new URL("../jobs.json", import.meta.url);
const MAX_JOBS = 90;
const MAX_AGE_DAYS = 60;
const UA = "Mozilla/5.0 (compatible; job-list-refresh/1.0; +https://github.com)";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }); // YYYY-MM-DD
const daysSince = (d) => (Date.parse(today) - Date.parse(d)) / 864e5;

// ---------- sources ----------
// Workable accounts that hire South Africa-based remote staff.
const WORKABLE = ["remote-recruitment", "huzzle", "d2b-1", "virtuhire", "emapply", "hirehawk", "fyxer-7", "pavago", "reworkssolutions", "ista-2"];
const LEVER = ["assist-world"];
const TEAMTAILOR_RSS = ["https://remoterecruitment.teamtailor.com/jobs.rss"];
const REMOTIVE_TERMS = ["assistant", "bookkeeper", "payroll", "administrator", "customer support", "sales", "appointment setter", "data entry"];

// ---------- her filters ----------
const TITLE_IN = /assistant|\bPA\b|\bVA\b|administrat|admin\b|coordinator|office manager|operations|bookkeep|account(s|ing)? (assistant|clerk|administrator|officer|payable|receivable)|finance (assistant|administrator|admin|officer)|ledger|reconcil|credit control|billing|invoic|payroll|appointment|setter|sales|\bSDR\b|\bBDR\b|telesales|lead gen|business development|closer|customer|support (agent|specialist|representative|advisor|executive)|service (agent|representative|desk|advisor)|chat|call cent|contact cent|receptionist|concierge|guest|booking|dispatch|scheduling|data entry|data (capturer|administrator)|onboarding|recruitment (coordinator|administrator|resourcer|assistant)|resourcer|\bHR\b|human resources|social media assistant|marketing assistant|transcri|collections|helpdesk/i;
const TITLE_OUT = /developer|engineer|designer|\bseo\b|\bppc\b|video|editor|nurse|dental (hygienist|nurse)|clinical|pharma|teacher|tutor|lawyer|attorney|data scientist|\bchief\b|director|head of|\bVP\b|\bcfo\b|\bcto\b|accountant\b(?!.*assistant)|devops|qa tester|architect/i;
const US_HOURS = /\bU\.?S\.?A?\.?\s*(business\s*)?(hours|time|shift|timezone)|\b(EST|EDT|CST|CDT|PST|PDT|MST)\b|eastern (standard )?time|pacific (standard )?time|central (standard )?time|mountain time|graveyard|night shift|hawaii/i;
const DEGREE_REQ = /bachelor'?s?|degree\s+(is\s+)?(required|essential|mandatory)|(diploma|qualification)\s+or\s+(a\s+)?degree|degree\s+in\s+(accounting|finance|business|commerce|economics|hr|human)|\bB\.?\s?Com\b|university degree/i;
const PAY_TO_APPLY = /(registration|training|admin|starter|application)\s+fee|pay (a|the) fee|deposit (is )?required/i;
const OK_HOURS = /\bUK\b|united kingdom|GMT|BST|british|london|europe|\bCET\b|\bCEST\b|uae|dubai|gulf|\bSAST\b|south african? (business )?hours|SA business hours|SA hours/i;
const SA_ELIGIBLE = /south africa|\bSA\b-?based|cape town|johannesburg|durban|pretoria|gqeberha/i;
const GLOBAL_ELIGIBLE = /worldwide|anywhere|\bEMEA\b|africa/i;
const NOEXP = /no (prior |previous )?experience (is )?(required|needed|necessary)|entry[- ]level|full training|training (is )?provided|we will train|we'll train|graduates? welcome|no experience/i;
const COMM = /commission|\bOTE\b|uncapped|bonus(es)? per|per (sale|appointment|booking|meeting)|performance[- ]based (pay|bonus|incentives?)|incentive/i;

const TOOLS = [
  [/xero/i, "Xero"], [/\bsage\b/i, "Sage"], [/quickbooks/i, "QuickBooks"], [/payroll/i, "payroll"],
  [/monday\.com|monday/i, "monday.com"], [/clickup/i, "ClickUp"], [/notion/i, "Notion"],
  [/google workspace|g suite/i, "Google Workspace"], [/microsoft 365|office 365|ms office|excel/i, "Microsoft 365"],
  [/\bsars\b/i, "SARS"], [/\bcipc\b/i, "CIPC"], [/calendar|diary|inbox/i, "diary and inbox work"],
  [/reconcil/i, "reconciliations"], [/invoic/i, "invoicing"],
];
const GAPS = /(uk vat|mtd|making tax digital|hmrc|paye|self[- ]assessment).{0,40}(experience|required|essential)|(experience|required|essential).{0,40}(uk vat|mtd|hmrc)/i;
const COLD = /cold[- ]call|outbound (sales|calls?|calling) experience|proven (sales|outbound)/i;

const CAT_BASE = { pay: 72, fin: 64, ea: 66, ops: 62, cs: 56, sales: 44 };
const CAT_WHY = {
  pay: "Payroll role, and you've run payroll for about 15 staff.",
  fin: "Bookkeeping and finance admin you already do daily.",
  ea: "Executive and virtual assistant work: your core experience.",
  ops: "Admin and operations coordination you've done remotely for 3+ years.",
  cs: "Client-facing support work that uses your client coordination experience.",
  sales: "Sales and appointment setting. Your client coordination helps, and there's room to earn more.",
};

function category(title) {
  if (/payroll/i.test(title)) return "pay";
  if (/bookkeep|account|finance|ledger|reconcil|credit control|billing|invoic|collections/i.test(title)) return "fin";
  if (/appointment|setter|sales|\bSDR\b|\bBDR\b|telesales|lead gen|business development|closer/i.test(title)) return "sales";
  if (/customer|support|service|chat|call cent|contact cent|receptionist|concierge|guest|booking|dispatch|helpdesk/i.test(title)) return "cs";
  if (/(executive|personal|virtual) assistant|\bPA\b|\bVA\b/i.test(title)) return "ea";
  return "ops";
}
const CATS_OK = new Set(["ea", "ops", "fin", "pay", "cs", "sales"]);

const strip = (html = "") => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

function sastWindowOk(text) {
  // Explicit SAST times like "11:00–19:00 SAST" or "(1:00am – 9:00am South African time)".
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[–-]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(SAST|South African? time|SA time)/i);
  if (!m) return null;
  const toH = (h, min, ap) => { h = +h; if (ap) h = (h % 12) + (/pm/i.test(ap) ? 12 : 0); return h + (+min || 0) / 60; };
  const start = toH(m[1], m[2], m[3] || (m[6] && +m[1] <= 12 ? m[6] : ""));
  const end = toH(m[4], m[5], m[6]);
  return start >= 3.5 && end <= 20 && end > start;
}

function hoursLabel(text) {
  const m = text.match(/\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}\s*SAST/i);
  if (m) return m[0].replace(/\s+/g, " ").replace("-", "–");
  if (/\bUK\b|united kingdom|GMT|BST|british|london/i.test(text)) return "UK hours (~11:00–19:30 SAST)";
  if (/europe|\bCET\b|\bCEST\b/i.test(text)) return "European hours";
  if (/uae|dubai|gulf/i.test(text)) return "UAE hours (~07:00–15:00 SAST)";
  if (/sast|south african? (business )?hours|SA (business )?hours/i.test(text)) return "SA hours";
  return "Check ad";
}

const fmtR = (x) => "R" + (+x.replace(/\D/g, "")).toLocaleString("en-US");
function payLabel(text) {
  const r = text.match(/R\s?(\d{1,3}(?:[ ,.]\d{3})+|\d{4,6})(?:\s*(?:[–-]|to)\s*R?\s?(\d{1,3}(?:[ ,.]\d{3})+|\d{4,6}))?/);
  if (r) return fmtR(r[1]) + (r[2] ? "–" + fmtR(r[2]) : "");
  const g = text.match(/£\s?\d[\d,]*(?:\s*[–-]\s*£?\s?\d[\d,]*)?/);
  if (g) return g[0].replace(/\s+/g, "");
  const u = text.match(/(?:US)?\$\s?\d[\d,]*(?:\s*[–-]\s*\$?\s?\d[\d,]*)?/);
  return u ? u[0].replace(/\s+/g, "") : "See ad";
}

// Returns a job object or null if it fails her filters.
function evaluate({ title, company, url, text }) {
  if (!title || !url || !TITLE_IN.test(title) || TITLE_OUT.test(title)) return null;
  if (!/^https:\/\//.test(url)) return null;
  const all = `${title} ${text}`;
  if (US_HOURS.test(all) || DEGREE_REQ.test(all) || PAY_TO_APPLY.test(all)) return null;
  if (!SA_ELIGIBLE.test(all) && !GLOBAL_ELIGIBLE.test(all)) return null;
  const explicit = sastWindowOk(all);
  if (explicit === false) return null;
  if (explicit === null && !OK_HOURS.test(all)) return null; // can't confirm SA-friendly hours
  const cat = category(title);
  const hits = TOOLS.filter(([re]) => re.test(all)).map(([, n]) => n);
  let m = CAT_BASE[cat] + Math.min(hits.length, 5) * 4;
  const noexp = NOEXP.test(all), comm = COMM.test(all);
  if (noexp) m += 6;
  if (GAPS.test(all)) m -= 15;
  if (cat === "sales" && COLD.test(all)) m -= 6;
  if (/senior|manager/i.test(title)) m -= 6;
  m = Math.max(40, Math.min(90, Math.round(m)));
  if (m < 40) return null;
  const why = hits.length ? `${CAT_WHY[cat]} Mentions ${hits.slice(0, 3).join(", ")}.` : CAT_WHY[cat];
  const h = hoursLabel(all);
  return {
    cat, t: title.trim(), co: company, h, p: payLabel(all), m,
    ...(m >= 85 ? { top: 1 } : {}),
    ...(/part[- ]time|flexible hours|flexible schedule/i.test(all) ? { study: 1 } : {}),
    ...(h === "Check ad" ? { chk: 1 } : {}),
    ...(noexp ? { noexp: 1 } : {}),
    ...(comm ? { comm: 1 } : {}),
    why, u: url, added: today,
  };
}

// ---------- fetching ----------
async function get(url, { json = false, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: json ? "application/json" : "*/*" }, redirect: "follow", signal: ctl.signal });
    const body = json ? await res.json().catch(() => null) : await res.text().catch(() => "");
    return { status: res.status, url: res.url, body };
  } catch (e) {
    return { status: 0, url, body: null, error: String(e) };
  } finally { clearTimeout(t); }
}

const live = { workable: new Map() }; // account -> Set of live shortcodes (only when the feed loaded)

async function fromWorkable(account) {
  const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${account}?details=true`, { json: true });
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.jobs)) { console.log(`workable ${account}: unavailable (${r.status})`); return []; }
  const company = r.body.name || account;
  // Only trust the feed for removals if it actually returned jobs.
  if (r.body.jobs.length) live.workable.set(account, new Set(r.body.jobs.map((j) => String(j.shortcode || "").toUpperCase())));
  console.log(`workable ${account}: ${r.body.jobs.length} jobs`);
  return r.body.jobs.map((j) => {
    const where = [j.country, j.city, ...(j.locations || []).map((l) => l.country)].filter(Boolean).join(" ");
    const text = `${strip(j.description)} ${strip(j.requirements)} ${strip(j.benefits)} ${where} ${j.telecommuting ? "remote" : ""}`;
    if (!SA_ELIGIBLE.test(`${where} ${text}`) || !(j.telecommuting || /remote|work from home/i.test(text))) return null;
    const url = j.shortcode ? `https://apply.workable.com/${account}/j/${j.shortcode}/` : j.url;
    return { title: j.title, company: `${company}${/remote recruitment/i.test(company) ? " (UK employer)" : ""}`, url, text: `${text} South Africa` };
  }).filter(Boolean);
}

async function fromTeamtailor(feed) {
  const r = await get(feed);
  if (r.status !== 200 || !r.body) { console.log(`teamtailor ${feed}: unavailable (${r.status})`); return []; }
  const items = [...r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const tag = (x, n) => (x.match(new RegExp(`<${n}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`)) || [])[1] || "";
  console.log(`teamtailor: ${items.length} jobs`);
  return items.map((x) => ({ title: strip(tag(x, "title")), company: "Remote Recruitment (UK clients)", url: strip(tag(x, "link")), text: `${strip(tag(x, "description"))} South Africa remote UK hours` }));
}

async function fromRemotive(term) {
  const r = await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=100`, { json: true });
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.jobs)) { console.log(`remotive ${term}: unavailable (${r.status})`); return []; }
  console.log(`remotive ${term}: ${r.body.jobs.length} jobs`);
  return r.body.jobs
    .filter((j) => /south africa|worldwide|anywhere|emea|africa/i.test(j.candidate_required_location || ""))
    .map((j) => ({ title: j.title, company: j.company_name, url: j.url, text: `${strip(j.description)} ${j.salary || ""} ${j.candidate_required_location}` }));
}

async function fromLever(account) {
  const r = await get(`https://api.lever.co/v0/postings/${account}?mode=json`, { json: true });
  if (r.status !== 200 || !Array.isArray(r.body)) { console.log(`lever ${account}: unavailable (${r.status})`); return []; }
  console.log(`lever ${account}: ${r.body.length} jobs`);
  return r.body.map((j) => {
    const lists = (j.lists || []).map((l) => `${l.text} ${strip(l.content)}`).join(" ");
    const text = `${j.descriptionPlain || strip(j.description)} ${lists} ${j.additionalPlain || ""} ${j.categories?.location || ""} ${(j.categories?.allLocations || []).join(" ")}`;
    if (!SA_ELIGIBLE.test(text)) return null;
    return { title: j.text, company: account === "assist-world" ? "Assist World" : account, url: j.hostedUrl, text };
  }).filter(Boolean);
}

async function fromHimalayas() {
  const out = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const r = await get(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`, { json: true });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.jobs)) { console.log(`himalayas: unavailable (${r.status})`); break; }
    for (const j of r.body.jobs) {
      const locs = (j.locationRestrictions || []).join(" ");
      if (locs && !/south africa/i.test(locs)) continue;
      const pay = j.minSalary ? `${j.currency || ""} ${j.minSalary}${j.maxSalary ? "–" + j.maxSalary : ""}` : "";
      out.push({ title: j.title, company: j.companyName, url: j.applicationLink || j.guid, text: `${strip(j.description || j.excerpt)} ${pay} ${locs || "anywhere"}` });
    }
    if (r.body.jobs.length < 100) break;
  }
  console.log(`himalayas: ${out.length} open to SA`);
  return out.filter((x) => SA_ELIGIBLE.test(x.text) || GLOBAL_ELIGIBLE.test(x.text));
}

async function fromJobicy() {
  const r = await get("https://jobicy.com/api/v2/remote-jobs?count=100", { json: true });
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.jobs)) { console.log(`jobicy: unavailable (${r.status})`); return []; }
  const jobs = r.body.jobs.filter((j) => /south africa|anywhere|emea|africa/i.test(j.jobGeo || ""));
  console.log(`jobicy: ${jobs.length} open to SA`);
  return jobs.map((j) => ({ title: strip(j.jobTitle), company: j.companyName, url: j.url, text: `${strip(j.jobDescription || j.jobExcerpt)} ${j.jobGeo}` }));
}

async function fromRemoteOK() {
  const r = await get("https://remoteok.com/api", { json: true });
  if (r.status !== 200 || !Array.isArray(r.body)) { console.log(`remoteok: unavailable (${r.status})`); return []; }
  const jobs = r.body.filter((j) => j && j.position && /south africa|worldwide|anywhere|emea|africa/i.test(j.location || ""));
  console.log(`remoteok: ${jobs.length} open to SA`);
  return jobs.map((j) => ({ title: j.position, company: j.company, url: j.url || j.apply_url, text: `${strip(j.description)} ${j.location}` }));
}

// ---------- dead-link check ----------
const CLOSED = /no longer (accepting|available|active|open)|position (has been )?(filled|closed)|job (is )?(closed|expired|not found)|this job (ad )?(has )?(expired|been removed)|vacancy (has )?(closed|expired)|applications? (are |is )?closed|page not found|job not found|isn't available anymore|is no longer available/i;

// Returns "dead", "alive" or "unknown".
async function check(job) {
  const wm = job.u.match(/apply\.workable\.com\/([^/]+)\/j\/([A-Z0-9]+)/i);
  if (wm && live.workable.has(wm[1])) return live.workable.get(wm[1]).has(wm[2].toUpperCase()) ? "alive" : "dead";
  if (/jobs\.workable\.com\/view\//.test(job.u)) return "dead"; // old link style that can't be verified; feeds re-add live ones
  let r = await get(job.u);
  if (r.status === 0) r = await get(job.u);
  if (r.status === 404 || r.status === 410) return "dead";
  if (r.status !== 200) return "unknown";
  if (typeof r.body === "string" && CLOSED.test(r.body.slice(0, 200000))) return "dead";
  return "alive";
}

// ---------- main ----------
const data = JSON.parse(await readFile(FILE, "utf8"));
const before = data.jobs.length;

const sources = await Promise.all([
  ...WORKABLE.map(fromWorkable),
  ...TEAMTAILOR_RSS.map(fromTeamtailor),
  ...REMOTIVE_TERMS.map(fromRemotive),
  ...LEVER.map(fromLever),
  fromHimalayas(), fromJobicy(), fromRemoteOK(),
]);

// 1. remove dead / stale
const kept = [];
const removed = [];
for (const job of data.jobs) {
  if (!CATS_OK.has(job.cat)) job.cat = category(job.t); // migrate old categories
  const state = await check(job);
  if (state === "alive") delete job.fails;
  if (state === "unknown") job.fails = (job.fails || 0) + 1;
  const stale = daysSince(job.added) > MAX_AGE_DAYS;
  const unreachable = (job.fails || 0) >= 3; // couldn't open it 3 days running
  if (state === "dead" || stale || unreachable) removed.push(`${job.t} — ${job.co}${state === "dead" ? "" : stale ? " (older than 60 days)" : " (unreachable 3 days)"}`);
  else kept.push(job);
}

// Safety net: a source glitch must never wipe the list. If over half would go in one run, remove nothing.
if (removed.length > data.jobs.length / 2) {
  console.log(`Safety stop: ${removed.length} of ${data.jobs.length} looked dead, which is unlikely. Keeping all.`);
  kept.splice(0, kept.length, ...data.jobs);
  removed.length = 0;
}

// 2. add new
const key = (j) => `${j.t}|${j.co}|${j.p}`.toLowerCase();
const seenU = new Set(kept.map((j) => j.u.replace(/\/$/, "").toLowerCase()));
const seenK = new Set(kept.map(key));
const added = [];
for (const raw of sources.flat()) {
  const job = evaluate(raw);
  if (!job) continue;
  const u = job.u.replace(/\/$/, "").toLowerCase();
  if (seenU.has(u) || seenK.has(key(job))) continue;
  seenU.add(u); seenK.add(key(job));
  added.push(job);
}

let jobs = [...kept, ...added];
if (jobs.length > MAX_JOBS) {
  jobs.sort((a, b) => b.m - a.m || b.added.localeCompare(a.added));
  jobs = jobs.slice(0, MAX_JOBS);
}

const changed = removed.length || added.length || data.checked !== today;
data.checked = today;
data.jobs = jobs;
if (changed) await writeFile(FILE, JSON.stringify(data, null, 1) + "\n");

console.log(`\nBefore: ${before} | Removed: ${removed.length} | Added: ${added.length} | Now: ${jobs.length}`);
removed.forEach((x) => console.log("  - removed: " + x));
added.forEach((j) => console.log(`  + added: ${j.t} — ${j.co} (${j.m}%)`));
