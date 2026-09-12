/* Adora Innovations — early access form + header state */
(function () {
  'use strict';

  var CONTACT = 'esther@adorainnovations.com';

  /* ---------------------------------------------------- sticky header -- */

  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('is-stuck', window.scrollY > 4);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ------------------------------------------------------------- form -- */

  var form = document.getElementById('early-access-form');
  if (!form) return;

  var card     = document.querySelector('.form-card');
  var nameEl   = document.getElementById('name');
  var emailEl  = document.getElementById('email');
  var hpEl     = document.getElementById('company_website');
  var btn      = document.getElementById('submit-btn');
  var status   = document.getElementById('form-status');

  // Deliberately permissive: catches typos, never rejects a real address.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function setError(input, errorId, show) {
    var el = document.getElementById(errorId);
    if (el) el.hidden = !show;
    input.setAttribute('aria-invalid', show ? 'true' : 'false');
    if (show) input.setAttribute('aria-describedby', errorId);
    else input.removeAttribute('aria-describedby');
  }

  function validate(focusFirst) {
    var nameOk  = nameEl.value.trim().length >= 2;
    var emailOk = EMAIL_RE.test(emailEl.value.trim());
    setError(nameEl, 'name-error', !nameOk);
    setError(emailEl, 'email-error', !emailOk);
    if (focusFirst) (nameOk ? (emailOk ? null : emailEl) : nameEl)?.focus();
    return nameOk && emailOk;
  }

  // Clear an error as soon as the field becomes valid again.
  nameEl.addEventListener('input', function () {
    if (nameEl.getAttribute('aria-invalid') === 'true' && nameEl.value.trim().length >= 2) {
      setError(nameEl, 'name-error', false);
    }
  });
  emailEl.addEventListener('input', function () {
    if (emailEl.getAttribute('aria-invalid') === 'true' && EMAIL_RE.test(emailEl.value.trim())) {
      setError(emailEl, 'email-error', false);
    }
  });

  function showError(html) {
    status.innerHTML = html;
    status.className = 'form-status is-visible is-error';
  }

  function showSuccess(name) {
    var first = name.trim().split(/\s+/)[0];
    var safe = first.replace(/[<>&"']/g, '');
    card.classList.add('is-done');
    status.className = '';
    status.innerHTML =
      '<div class="success">' +
        '<span class="success-icon">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
          'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
        '</span>' +
        '<h3>You&rsquo;re on the list' + (safe ? ', ' + safe : '') + '.</h3>' +
        '<p>We&rsquo;ll email you personally when early access opens. ' +
        'No spam, no sales calls &mdash; just a demo with your own supplier quotes.</p>' +
      '</div>';
    status.classList.add('is-visible');
  }

  function setLoading(on) {
    btn.disabled = on;
    btn.classList.toggle('is-loading', on);
    btn.querySelector('.btn-label').textContent = on ? 'Sending…' : 'Request Early Access';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Honeypot: a real person never fills this in.
    if (hpEl && hpEl.value) { showSuccess(nameEl.value); return; }

    if (!validate(true)) return;

    status.className = 'form-status';
    status.innerHTML = '';
    setLoading(true);

    var payload = {
      name: nameEl.value.trim(),
      email: emailEl.value.trim(),
      company_website: ''
    };

    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (r) {
        if (r.ok) { showSuccess(payload.name); return; }

        var body = r.body || {};

        if (r.status === 429) {
          showError('That went through a moment ago. Give it a minute before trying again.');
          return;
        }

        // 400s are the visitor's own input — show them as-is, no email fallback.
        if (r.status === 400 && body.error) { showError(body.error); return; }

        // Anything else is our problem. Say what happened, then hand over the
        // address so the lead is never lost.
        showError(
          (body.error || 'Something went wrong on our side.') +
          ' Please email us at <a href="mailto:' + CONTACT + '?subject=' +
          encodeURIComponent('Early access request') + '">' + CONTACT +
          '</a> and we&rsquo;ll add you personally.'
        );
      })
      .catch(function () {
        showError(
          'We couldn&rsquo;t reach the server. Check your connection, or email us at ' +
          '<a href="mailto:' + CONTACT + '">' + CONTACT + '</a>.'
        );
      })
      .then(function () { setLoading(false); });
  });
})();
