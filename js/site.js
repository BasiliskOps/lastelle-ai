(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('y').textContent = new Date().getFullYear();

  // entrance
  requestAnimationFrame(function () { setTimeout(function () { document.body.classList.add('loaded'); }, 120); });
  var canvasHost = document.getElementById('hero-canvas');
  var waitReady = setInterval(function () {
    if (window.__heroReady) { canvasHost.classList.add('ready'); clearInterval(waitReady); }
  }, 60);

  // nav state + hero recede on scroll
  var nav = document.getElementById('nav');
  var card = document.getElementById('hero-card');
  var ticking = false;
  function onScroll() {
    var y = window.scrollY;
    nav.classList.toggle('scrolled', y > 8);
    if (!reduced && card) {
      var h = card.offsetHeight;
      var p = Math.min(1, Math.max(0, y / h));
      card.style.transform = 'scale(' + (1 - p * 0.035).toFixed(4) + ')';
    }
    ticking = false;
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();

  // mobile menu
  var menu = document.getElementById('menu');
  var links = document.getElementById('nav-links');
  menu.addEventListener('click', function () {
    var open = links.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', function (e) {
    if (e.target.closest('a')) { links.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }
  });

  // reveal
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
  document.querySelectorAll('[data-reveal]').forEach(function (el) { io.observe(el); });

  // plates: light follows the pointer, slight tilt
  if (!reduced && window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('[data-tilt]').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
        el.style.transform = 'translateY(-4px) rotateX(' + ((0.5 - y) * 3).toFixed(2) + 'deg) rotateY(' + ((x - 0.5) * 3).toFixed(2) + 'deg)';
      });
      el.addEventListener('pointerleave', function () { el.style.transform = ''; el.style.setProperty('--my', '0%'); el.style.setProperty('--mx', '50%'); });
    });
  }

  // contact form: Formspree when configured, otherwise a prefilled email
  var form = document.getElementById('contact-form');
  var status = document.getElementById('form-status');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var endpoint = form.getAttribute('data-endpoint') || '';
    var fd = new FormData(form);
    if (endpoint && endpoint.indexOf('REPLACE_ME') === -1) {
      status.textContent = 'Sending';
      fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json' }, body: fd })
        .then(function (res) {
          if (!res.ok) throw new Error();
          status.textContent = 'Received. I will reply within two business days.';
          form.reset();
        })
        .catch(function () { status.textContent = 'That did not go through. Email annatar.ai@proton.me directly.'; });
    } else {
      var name = String(fd.get('name') || '').trim();
      var subject = encodeURIComponent('Project inquiry' + (name ? ' from ' + name : ''));
      var body = encodeURIComponent('Name: ' + name + '\nEmail: ' + fd.get('email') + '\n\n' + fd.get('message'));
      window.location.href = 'mailto:annatar.ai@proton.me?subject=' + subject + '&body=' + body;
      status.textContent = 'Opening your email app';
    }
  });
})();
