/**
 * POST /api/subscribe  →  { name, email }
 *
 * Adds an early-access lead to whichever mailing list is configured.
 * Set ONE of the two providers in the Vercel project's environment variables:
 *
 *   Brevo      BREVO_API_KEY          (+ optional BREVO_LIST_ID)
 *   Mailchimp  MAILCHIMP_API_KEY      (+ MAILCHIMP_AUDIENCE_ID)
 *
 * If both are set, Brevo wins. No other dependencies — Node's global fetch only.
 *
 * Optional, and independent of the above — so a signup is never only visible
 * inside a mailing-list dashboard:
 *
 *   NOTIFY_EMAIL        inbox that gets an alert for every submission
 *   NOTIFY_FROM         a sender address verified in Brevo (needs BREVO_API_KEY)
 *   SIGNUP_WEBHOOK_URL  POSTed the raw signup as JSON — point it at a Google
 *                       Apps Script bound to a Sheet, Zapier, Make, anything
 *
 * Both fire after the list write and can never fail the request: a lead that
 * reached the list must not be reported as failed because an alert bounced.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* --------------------------------------------------------- rate limit -- */
// Per warm instance only. A speed bump for scripted spam, not a security wall;
// the honeypot and the provider's own dedupe do the rest.
// Generous on purpose: a whole procurement team can share one office IP.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 15;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

/* ------------------------------------------------------------ helpers -- */

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

async function readJsonBody(req) {
  // On Vercel, `req.body` is a lazy getter that throws on malformed JSON.
  try {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body);
  } catch {
    return null;
  }

  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- providers -- */

// Distinguishes "your list is full / out of quota" from everything else, so the
// visitor gets an honest message instead of a generic failure. Deliberately
// keyword-based: both providers describe plan limits in prose, not error codes.
const LIMIT_RE = /not_enough_credits|contact limit|plan limit|reached the (?:maximum|limit)|exceed(?:s|ed)? (?:your|the) (?:plan|contact|subscriber)|upgrade your plan|too many (?:contacts|subscribers)/i;

function classify(status, detail = '') {
  if (status === 402 || LIMIT_RE.test(detail)) return 'limit';
  if (status === 401 || status === 403) return 'auth';
  return 'other';
}

async function addToBrevo({ name, email }) {
  const { first, last } = splitName(name);
  const listId = Number.parseInt(process.env.BREVO_LIST_ID || '', 10);

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      attributes: { FIRSTNAME: first, LASTNAME: last },
      updateEnabled: true, // re-submitting an address is an update, not an error
      ...(Number.isInteger(listId) ? { listIds: [listId] } : {}),
    }),
  });

  if (res.ok) return { ok: true };

  const detail = await res.text();
  // "duplicate_parameter" can still surface on some plans — treat as already-subscribed.
  if (res.status === 400 && detail.includes('duplicate_parameter')) return { ok: true };
  return { ok: false, status: res.status, detail, kind: classify(res.status, detail) };
}

async function addToMailchimp({ name, email }) {
  const key = process.env.MAILCHIMP_API_KEY;
  const audience = process.env.MAILCHIMP_AUDIENCE_ID;
  const dc = key.split('-').pop();

  if (!dc || dc === key) {
    return { ok: false, status: 500, kind: 'other',
             detail: 'MAILCHIMP_API_KEY is missing its "-usX" datacenter suffix.' };
  }
  if (!audience) {
    return { ok: false, status: 500, kind: 'other', detail: 'MAILCHIMP_AUDIENCE_ID is not set.' };
  }

  const { first, last } = splitName(name);
  const res = await fetch(
    `https://${dc}.api.mailchimp.com/3.0/lists/${audience}/members`,
    {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`anystring:${key}`).toString('base64'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email_address: email,
        status: process.env.MAILCHIMP_DOUBLE_OPT_IN === 'true' ? 'pending' : 'subscribed',
        merge_fields: { FNAME: first, LNAME: last },
        tags: ['early-access'],
      }),
    }
  );

  if (res.ok) return { ok: true };

  const detail = await res.text();
  if (res.status === 400 && detail.includes('Member Exists')) return { ok: true };
  return { ok: false, status: res.status, detail, kind: classify(res.status, detail) };
}

/* ------------------------------------------------------- notifications -- */

function alertBody({ name, email, captured, detail }) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const lines = [
    `Name:  ${name}`,
    `Email: ${email}`,
    `Time:  ${when}`,
    '',
    captured
      ? 'Added to the mailing list successfully.'
      : `NOT added to the mailing list — ${detail}. Add this person manually.`,
  ];
  return lines.join('\n');
}

async function sendAlert(lead) {
  const to = process.env.NOTIFY_EMAIL;
  const from = process.env.NOTIFY_FROM;
  const key = process.env.BREVO_API_KEY;
  if (!to || !from || !key) return false;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: from, name: 'Adora Innovations' },
      to: [{ email: to }],
      replyTo: { email: lead.email, name: lead.name },
      subject: lead.captured
        ? `Early access request — ${lead.name}`
        : `ACTION NEEDED: early access request not saved — ${lead.name}`,
      textContent: alertBody(lead),
    }),
  });
  if (!res.ok) throw new Error(`alert email ${res.status}: ${await res.text()}`);
  return true;
}

async function postWebhook(lead) {
  const url = process.env.SIGNUP_WEBHOOK_URL;
  if (!url) return false;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: lead.name,
      email: lead.email,
      capturedInList: lead.captured,
      submittedAt: new Date().toISOString(),
      source: 'adorainnovations.com',
    }),
  });
  // Apps Script answers a 302 to its redirect target; that still counts.
  if (!res.ok && res.status !== 302) {
    throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return true;
}

// Never throws. Returns true only if a channel actually delivered something —
// an unconfigured channel resolves to false, so "skipped" can never be mistaken
// for "the lead reached a human".
async function notify(lead) {
  const results = await Promise.allSettled([sendAlert(lead), postWebhook(lead)]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[subscribe] notification failed:', r.reason?.message ?? r.reason);
  }
  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

/* ----------------------------------------------------------- handler -- */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  }

  const body = await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Could not read that request.' });

  // Honeypot — a real person leaves this empty.
  if (typeof body.company_website === 'string' && body.company_website.trim() !== '') {
    return res.status(200).json({ ok: true });
  }

  const name = String(body.name ?? '').trim().slice(0, 120);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200);

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const useBrevo = Boolean(process.env.BREVO_API_KEY);
  const useMailchimp = Boolean(process.env.MAILCHIMP_API_KEY);

  if (!useBrevo && !useMailchimp) {
    console.error(
      '[subscribe] no mailing-list provider configured. Set BREVO_API_KEY or ' +
      'MAILCHIMP_API_KEY in the Vercel project settings.',
      { name, email }
    );
    // A webhook alone can still capture the lead, so this is not automatically
    // a dead end.
    const reached = await notify({ name, email, captured: false, detail: 'no mailing-list provider configured' });
    if (reached) {
      console.log('[subscribe] captured via notification only', email);
      return res.status(200).json({ ok: true });
    }
    console.error('[subscribe] LEAD NOT CAPTURED', { name, email });
    return res.status(500).json({ error: 'Signup is not configured yet.', fallback: true });
  }

  try {
    const result = useBrevo
      ? await addToBrevo({ name, email })
      : await addToMailchimp({ name, email });

    if (result.ok) {
      console.log('[subscribe] added', email);
      await notify({ name, email, captured: true });
      return res.status(200).json({ ok: true });
    }

    // Always log the lead itself on failure — Vercel's logs are then the last
    // place it can be recovered from.
    console.error('[subscribe] provider rejected the request',
      { status: result.status, kind: result.kind, detail: result.detail, name, email });

    // The list rejected them, but an alert still puts the lead in front of a
    // human, which is what actually matters.
    const reached = await notify({
      name, email, captured: false,
      detail: result.kind === 'limit' ? 'the mailing list is at capacity' : `provider returned ${result.status}`,
    });
    if (reached) {
      console.log('[subscribe] captured via notification only', email);
      return res.status(200).json({ ok: true });
    }
    console.error('[subscribe] LEAD NOT CAPTURED', { name, email });

    if (result.kind === 'limit') {
      return res.status(503).json({
        error: 'Our early-access list is at capacity right now.',
        fallback: true,
      });
    }
    return res.status(502).json({ error: 'We could not add you just now.', fallback: true });
  } catch (err) {
    console.error('[subscribe] unexpected failure', { err, name, email });
    const reached = await notify({ name, email, captured: false, detail: 'unexpected failure' })
      .catch(() => false);
    if (reached) {
      console.log('[subscribe] captured via notification only', email);
      return res.status(200).json({ ok: true });
    }
    console.error('[subscribe] LEAD NOT CAPTURED', { name, email });
    return res.status(502).json({ error: 'We could not add you just now.', fallback: true });
  }
}
