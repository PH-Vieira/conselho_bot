import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function fail(msg) {
  console.error('\n[config] ' + msg + '\n');
  process.exit(1);
}

if (!fs.existsSync(CONFIG_PATH)) {
  fail('Missing `config.json` in project root. Create one (see config.example.json) with required keys: `groupJid` or `groupName`, `voteWindowHours`, `quorum` (object with `type` and `threshold`), and optional `stickers`.');
}

let raw;
try {
  raw = fs.readFileSync(CONFIG_PATH, 'utf8');
} catch (err) {
  fail('Unable to read `config.json`: ' + err.message);
}

let CONFIG;
try {
  CONFIG = JSON.parse(raw);
} catch (err) {
  fail('`config.json` is not valid JSON: ' + err.message);
}

// Backwards compatibility: allow older `quorumRule` string (e.g. 'half') and
// convert it to the new `quorum` object structure expected by the rest of
// the codebase.
if (!CONFIG.quorum && CONFIG.quorumRule) {
  const rule = String(CONFIG.quorumRule).toLowerCase();
  if (rule === 'half' || rule === 'half-votes' || rule === 'half_votes') {
    CONFIG.quorum = { type: 'percentage', threshold: 0.5 };
  } else if (rule === 'majority') {
    // >50%
    CONFIG.quorum = { type: 'percentage', threshold: 0.51 };
  } else {
    // unknown string - leave it and let validation catch it, but try to
    // support numeric strings like '0.5' or '50'
    const asNum = Number(rule);
    if (!Number.isNaN(asNum)) {
      if (asNum > 1) {
        // interpret >1 as absolute count
        CONFIG.quorum = { type: 'absolute', threshold: Math.floor(asNum) };
      } else {
        CONFIG.quorum = { type: 'percentage', threshold: asNum };
      }
    }
  }
}

// Basic validation
const hasGroup = !!(CONFIG.groupJid || CONFIG.groupName);
if (!hasGroup) {
  fail('`config.json` must include `groupJid` (recommended) or `groupName` to identify the target group.');
}

if (typeof CONFIG.voteWindowHours !== 'number' || Number.isNaN(CONFIG.voteWindowHours)) {
  fail('`voteWindowHours` is required and must be a number (hours).');
}

if (!CONFIG.quorum || typeof CONFIG.quorum !== 'object') {
  fail('`quorum` is required in config.json and should be an object, e.g. { type: "percentage", threshold: 0.5 } or { type: "absolute", threshold: 3 }');
}

if (!['percentage', 'absolute'].includes(CONFIG.quorum.type)) {
  fail('`quorum.type` must be either "percentage" or "absolute".');
}

if (typeof CONFIG.quorum.threshold !== 'number') {
  fail('`quorum.threshold` must be a number (for percentage use 0..1).');
}

// Normalize stickers structure
if (CONFIG.stickers && typeof CONFIG.stickers === 'object') {
  CONFIG.stickers = {
    yes: Array.isArray(CONFIG.stickers.yes) ? CONFIG.stickers.yes : [],
    no: Array.isArray(CONFIG.stickers.no) ? CONFIG.stickers.no : [],
    council: Array.isArray(CONFIG.stickers.council) ? CONFIG.stickers.council : [],
  };
}

// Optional: allow running with insecure TLS for environments with custom/proxy CAs.
// WARNING: this disables Node's TLS certificate verification and should only be
// used for debugging in trusted environments. Prefer fixing system CA/proxy
// configuration instead.
if (typeof CONFIG.insecureTls === 'undefined') CONFIG.insecureTls = false;

export default CONFIG;
