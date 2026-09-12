# Adora Innovations — landing page

One page. No accounts, no database, no build step. Static HTML/CSS/JS in `public/`,
plus a single serverless function that pushes early-access signups into a mailing list.

```
public/index.html      the page (all six sections)
public/styles.css      all styling, mobile-first
public/main.js         form validation + submit
public/assets/         logo, icons, social share image
api/subscribe.js       POST endpoint → Brevo or Mailchimp
vercel.json            caching + security headers
```

---

## 1. Connect the mailing list

The form will not store anything until one provider is configured. **Pick one.**

### Option A — Brevo (recommended)

1. Sign up at [brevo.com](https://www.brevo.com).
2. **Contacts → Lists → Create a list** (e.g. "Early access"). Note its numeric ID.
3. Top-right menu → **SMTP & API → API Keys → Generate a new API key**. Copy it.
4. In Vercel: **Project → Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `BREVO_API_KEY` | the key from step 3 |
   | `BREVO_LIST_ID` | the list ID from step 2 |

### Option B — Mailchimp

1. Sign up at [mailchimp.com](https://mailchimp.com).
2. **Audience → Settings → Audience name and defaults** → copy the **Audience ID**.
3. **Account → Extras → API keys → Create a key**. Copy it — it ends in something
   like `-us21`, and that suffix matters.
4. In Vercel: **Project → Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `MAILCHIMP_API_KEY` | the key from step 3, suffix included |
   | `MAILCHIMP_AUDIENCE_ID` | the audience ID from step 2 |

   Optional: `MAILCHIMP_DOUBLE_OPT_IN=true` sends a confirmation email before
   subscribing anyone.

**Redeploy after adding the variables** — Vercel only picks them up on a new
deployment. Either push a commit, or run `vercel --prod`.

> Add the keys in the Vercel dashboard, not in a file in this repo. `.env.example`
> lists the names only; a real key committed to git is a leaked key.

Signups appear as contacts in whichever provider you chose. Every one of them is a
warm lead you can email personally.

### About the API key

Brevo v3 API keys are **account-wide** — there is no scope or permission to switch
on before the key can create contacts, and no notion of a "known" contact. Posting
an address to `POST /v3/contacts` is what creates it, which is exactly what this
form does.

The flip side of account-wide is that the key can do anything: send campaigns, read
the whole list, delete contacts. So keep it to a Vercel environment variable, never
a file in this repo, and generate a **separate key for the website** so it can be
revoked on its own without breaking other integrations.

### When the list is full

The code does **not** enforce a contact cap of its own — a hard cap would stop
collecting leads at exactly the moment demand is highest, and it would be a second
copy of a number only the provider actually knows.

Instead, the provider's own limit is detected and handled. If the list is at
capacity, the visitor sees:

> Our early-access list is at capacity right now. Please email us at
> esther@adorainnovations.com and we'll add you personally.

rather than a generic failure. On any failure — capacity, bad key, provider outage
— the name and email are also written to the Vercel function logs
(`LEAD NOT CAPTURED`), so the lead is still recoverable from
**Vercel → Project → Logs**.

Plan limits worth knowing: Brevo's free plan stores far more contacts than an
early-access list is likely to need, but caps **marketing-automation entries at
2,000 contacts/month** and **sending at 300 emails/day** — the automation cap is
the "2,000" figure shown during signup, and it does not stop the form from storing
contacts. Mailchimp's free plan is the tighter one at 500 contacts. Check the
current numbers on your own account page; they change.

---

## 2. Point the domain at Vercel

The domain is registered at Namecheap; Vercel hosts the site. Namecheap needs two
records so `adorainnovations.com` and `www.adorainnovations.com` both resolve.

Both `adorainnovations.com` and `www.adorainnovations.com` are **already added to
the Vercel project**. The only outstanding step is at Namecheap.

Go to **Domain List → Manage → Advanced DNS** and set exactly these three records:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | `216.198.79.1` | Automatic |
| A Record | `@` | `64.29.17.1` | Automatic |
| CNAME Record | `www` | `20852d4618e1fed6.vercel-dns-017.com` | Automatic |

Then **delete** anything Namecheap put there by default — the `CNAME` for `www`
pointing at `parkingpage.namecheap.com`, and any `URL Redirect Record`. Those
conflict and will keep the domain showing a parking page.

The nameservers are already correct (`dns1.registrar-servers.com` /
`dns2.registrar-servers.com` = Namecheap BasicDNS). Leave them alone — switching to
"Custom DNS" would make the Advanced DNS tab stop applying.

DNS usually propagates in 10–30 minutes. Vercel then issues the HTTPS certificate
on its own. Check progress with:

```bash
vercel domains verify adorainnovations.com
```

`"ok": true` means it is live. The two A records are Vercel's current anycast IPs
and the CNAME value is specific to this project — if Vercel's Domains tab ever
shows something different, that display wins over this table.

---

## 3. Working on the page

```bash
vercel dev
```

Serves the page and the API together at `http://localhost:3000`. Without provider
keys set locally the form returns "Signup is not configured yet" — the page then
shows the visitor the fallback email address, which is the intended behaviour.

Deploy:

```bash
vercel --prod
```

### Editing content

All copy lives in `public/index.html`, in the order it appears on the page, with
each section commented (`Section 1 — Headline`, etc.). Change the text, redeploy.

Colours are CSS variables at the top of `public/styles.css` — `--navy`, `--blue`,
`--blue-light` — sampled from the logo.

---

## Notes

- The hero shows an **illustrative** report preview with placeholder suppliers. It
  is labelled as such on the page. Swap it for a real screenshot once the product
  can produce one.
- If the mailing-list call ever fails, the form does not pretend it worked — it
  shows `esther@adorainnovations.com` so the lead is not lost.
- A hidden honeypot field and a per-IP rate limit (15 submissions / 10 minutes)
  keep out casual bot spam.
- Leads are only ever reported as captured when the provider actually accepted
  them. The form never shows a success state it cannot back up.
