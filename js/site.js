(function () {
  document.getElementById('y').textContent = new Date().getFullYear();

  // entrance
  requestAnimationFrame(function () { setTimeout(function () { document.body.classList.add('loaded'); }, 80); });
  var canvasHost = document.getElementById('hero-canvas');
  var waitReady = setInterval(function () {
    if (window.__heroReady) { canvasHost.classList.add('ready'); clearInterval(waitReady); }
  }, 60);

  // island menu
  var burger = document.getElementById('burger');
  var overlay = document.getElementById('overlay');
  function setMenu(open) {
    overlay.classList.toggle('open', open);
    overlay.setAttribute('aria-hidden', String(!open));
    burger.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  }
  burger.addEventListener('click', function () { setMenu(!overlay.classList.contains('open')); });
  overlay.addEventListener('click', function (e) { if (e.target.closest('a') || e.target === overlay) setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });

  // scroll reveals
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
  document.querySelectorAll('[data-reveal]').forEach(function (el) { io.observe(el); });

  // current section in the nav
  var spyLinks = Array.prototype.slice.call(document.querySelectorAll('[data-spy]'));
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      spyLinks.forEach(function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + e.target.id)); });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  ['practice', 'method', 'about', 'faq', 'contact'].forEach(function (id) { var el = document.getElementById(id); if (el) spy.observe(el); });

  // tagline: each word lights up as it crosses a line two thirds down the screen
  var tag = document.getElementById('tagline');
  if (tag) {
    var words = tag.textContent.trim().split(/\s+/);
    tag.innerHTML = words.map(function (w) { return '<span class="w">' + w + '</span>'; }).join(' ');
    var wio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('on', e.isIntersecting || e.boundingClientRect.top < 0); });
    }, { rootMargin: '0px 0px -34% 0px', threshold: 1 });
    tag.querySelectorAll('.w').forEach(function (w) { wio.observe(w); });
  }

  // contact form with inline validation
  var form = document.getElementById('contact-form');
  var status = document.getElementById('form-status');
  var rules = [
    ['f-name', 'e-name', function (v) { return v ? '' : 'Enter your name.'; }],
    ['f-email', 'e-email', function (v) { return !v ? 'Enter your email address.' : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'That email address is missing something. Check it and try again.'); }],
    ['f-msg', 'e-msg', function (v) { return v ? '' : 'Describe the project in a sentence or two.'; }],
  ];
  function check(rule) {
    var el = document.getElementById(rule[0]), msg = rule[2](el.value.trim());
    document.getElementById(rule[1]).textContent = msg;
    el.closest('.field').classList.toggle('invalid', !!msg);
    el.setAttribute('aria-invalid', String(!!msg));
    return !msg;
  }
  rules.forEach(function (r) { document.getElementById(r[0]).addEventListener('blur', function () { check(r); }); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = rules.map(check).every(Boolean);
    if (!ok) { status.textContent = ''; return; }
    var endpoint = form.getAttribute('data-endpoint') || '';
    var fd = new FormData(form);
    if (endpoint && endpoint.indexOf('REPLACE_ME') === -1) {
      status.textContent = 'Sending';
      fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json' }, body: fd })
        .then(function (res) { if (!res.ok) throw new Error(); status.textContent = 'Received. Expect a reply within two business days.'; form.reset(); })
        .catch(function () { status.textContent = 'That did not go through. Email annatar.ai@proton.me directly.'; });
    } else {
      status.textContent = 'The form is not connected yet. Email annatar.ai@proton.me directly.';
    }
  });
})();
