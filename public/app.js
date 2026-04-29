/* DigFlat Media Booking — client JS (no frameworks, no bundler) */
'use strict';

// =====================================================================
// HOME — service picker + live price calc
// =====================================================================
(function initHome() {
  if (!document.getElementById('booking-form')) return;
  const pricing = window.PRICING;
  if (!pricing) return;

  const sqftInput     = document.getElementById('sqft');
  const bundleRadios  = () => [...document.querySelectorAll('.bundle-radio')];
  const pkgRadios     = () => [...document.querySelectorAll('.pkg-radio')];
  const addonChecks   = () => [...document.querySelectorAll('.addon-check')];
  const rushCheck     = document.getElementById('rush-check');
  const summary       = document.getElementById('price-summary');
  const form          = document.getElementById('booking-form');
  const continueBtn   = document.getElementById('continue-btn');

  // Sqft hint → auto-select package.
  sqftInput?.addEventListener('input', () => {
    const sqft = parseInt(sqftInput.value) || 0;
    if (!sqft) return;
    const pkg = recommendPackage(sqft);
    if (!pkg) return;
    // Clear bundle selection, select matching package.
    bundleRadios().forEach(r => r.checked = false);
    const pr = document.querySelector(`.pkg-radio[value="${pkg.id}"]`);
    if (pr) pr.checked = true;
    updateSummary();
  });

  // Bundle selection → auto-select matching package + addons, deselect others.
  bundleRadios().forEach(r => r.addEventListener('change', () => {
    if (!r.checked) return;
    const bundleId = r.value;
    const b = pricing.bundles.find(x => x.id === bundleId);
    if (!b) return;
    // Set package radio.
    pkgRadios().forEach(p => { p.checked = p.value === b.includes_package_ids[0]; });
    // Set addon checkboxes.
    addonChecks().forEach(c => { c.checked = b.includes_addon_ids.includes(c.value); });
    updateSummary();
  }));

  // Package / addon changes → clear bundle selection.
  pkgRadios().forEach(r => r.addEventListener('change', () => {
    bundleRadios().forEach(b => b.checked = false);
    updateSummary();
  }));
  addonChecks().forEach(c => c.addEventListener('change', () => {
    bundleRadios().forEach(b => b.checked = false);
    // Enforce requires.
    if (c.checked) {
      const card = c.closest('.addon-card');
      const req = card?.dataset.requires?.split(',').filter(Boolean) || [];
      req.forEach(rid => {
        const dep = document.querySelector(`.addon-check[value="${rid}"]`);
        if (dep && !dep.checked) dep.checked = true;
      });
    }
    updateSummary();
  }));
  rushCheck?.addEventListener('change', updateSummary);

  // Submit → build GET URL with selections.
  form.addEventListener('submit', e => {
    e.preventDefault();
    const { packageId, addonIds, rush, bundleId } = getSelection();
    const params = new URLSearchParams();
    params.set('package', packageId);
    if (addonIds.length) params.set('addons', addonIds.join(','));
    if (rush) params.set('rush', '1');
    if (bundleId) params.set('bundle', bundleId);
    window.location.href = '/book?' + params.toString();
  });

  updateSummary();

  // ── helpers ──────────────────────────────────────────────────────

  function getSelection() {
    const pkgR = pkgRadios().find(r => r.checked);
    const packageId = pkgR?.value || pricing.photo_packages.find(p => p.is_default)?.id || pricing.photo_packages[0].id;
    const addonIds = addonChecks().filter(c => c.checked).map(c => c.value);
    const rush = rushCheck?.checked || false;
    const bundleR = bundleRadios().find(r => r.checked);
    const bundleId = bundleR?.value || null;
    return { packageId, addonIds, rush, bundleId };
  }

  function recommendPackage(sqft) {
    return pricing.photo_packages.find(p => sqft >= p.sqft_min && (p.sqft_max == null || sqft <= p.sqft_max))
      || pricing.photo_packages[pricing.photo_packages.length - 1];
  }

  function updateSummary() {
    const { packageId, addonIds, rush, bundleId } = getSelection();
    const result = calc(packageId, addonIds, rush);
    if (!result) { summary.innerHTML = '<div class="ps-loading">Select a package to see pricing</div>'; return; }

    // Detect bundle match.
    const matchedBundle = result.bundleMatch;
    const suggestion = !matchedBundle ? suggestBundle(packageId, addonIds) : null;

    let lines = result.lineItems.map(li => `<span class="ps-item">${li.name}: <strong>$${li.amount.toFixed(2)}</strong></span>`).join('');
    if (matchedBundle) lines += `<span class="ps-bundle-badge">Bundle: ${matchedBundle.name} (Save $${matchedBundle.savings})</span>`;
    if (suggestion) lines += `<span style="font-size:12px;color:var(--gold)"> · Add ${suggestion.missing.map(id => labelFor(id)).join(' + ')} to unlock ${suggestion.bundle.name} and save $${suggestion.bundle.savings}</span>`;

    summary.innerHTML = `
      <div class="ps-lines">${lines}</div>
      <div style="text-align:right">
        ${result.tax > 0 ? `<div class="ps-tax">+$${result.tax.toFixed(2)} OH tax</div>` : ''}
        <div class="ps-total">$${result.total.toFixed(2)}</div>
      </div>`;
  }

  function calc(packageId, addonIds, rush) {
    const pkg = pricing.photo_packages.find(p => p.id === packageId);
    if (!pkg) return null;
    const taxRate = (pricing.tax?.default_rate_percentage || 0) / 100;
    const rushFee = pricing.policies?.turnaround?.rush_fee ?? 75;

    // Check for bundle match.
    let bundleMatch = null;
    for (const b of pricing.bundles || []) {
      const sel = new Set([packageId, ...addonIds]);
      const items = new Set([...(b.includes_package_ids||[]), ...(b.includes_addon_ids||[])]);
      if (items.size === sel.size && [...items].every(x => sel.has(x))) { bundleMatch = b; break; }
    }

    const lineItems = [];
    let subtotal = 0;
    if (bundleMatch) {
      lineItems.push({ name: bundleMatch.name, amount: bundleMatch.price });
      subtotal += bundleMatch.price;
    } else {
      lineItems.push({ name: pkg.name + ' Photos', amount: pkg.price });
      subtotal += pkg.price;
      for (const aid of addonIds) {
        const a = pricing.add_ons.find(x => x.id === aid);
        if (a) { lineItems.push({ name: a.name, amount: a.price }); subtotal += a.price; }
      }
    }
    if (rush) { lineItems.push({ name: 'Rush turnaround', amount: rushFee }); subtotal += rushFee; }
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = subtotal + tax;
    return { lineItems, subtotal, tax, taxRate, total, bundleMatch };
  }

  function suggestBundle(packageId, addonIds) {
    const sel = new Set([packageId, ...addonIds]);
    let best = null;
    for (const b of pricing.bundles || []) {
      const items = [...(b.includes_package_ids||[]), ...(b.includes_addon_ids||[])];
      if (!items.includes(packageId)) continue;
      const missing = items.filter(x => !sel.has(x));
      if (missing.length > 0 && missing.length <= 2 && (!best || missing.length < best.missing.length)) {
        best = { bundle: b, missing };
      }
    }
    return best;
  }

  function labelFor(id) {
    const a = pricing.add_ons.find(x => x.id === id);
    if (a) return a.name;
    const p = pricing.photo_packages.find(x => x.id === id);
    return p?.name || id;
  }
})();

// =====================================================================
// BOOK — calendar + slots + form validation
// =====================================================================
(function initBook() {
  const cfg = window.BOOK_CONFIG;
  if (!cfg) return;

  const calContainer = document.getElementById('calendar-grid');
  const monthLabel   = document.getElementById('cal-month-label');
  const prevBtn      = document.getElementById('cal-prev');
  const nextBtn      = document.getElementById('cal-next');
  const slotsSection = document.getElementById('slots-section');
  const slotsGrid    = document.getElementById('slots-grid');
  const slotsEmpty   = document.getElementById('slots-empty');
  const startISOInput = document.getElementById('startISO');
  const submitBtn    = document.getElementById('submit-btn');
  const submitHint   = document.getElementById('submit-hint');
  const agreeCheck   = document.getElementById('agree-check');
  const form         = document.getElementById('book-form');

  let currentYear, currentMonth, selectedDate = null, selectedSlot = null;
  const today = new Date();
  const minDate = new Date(cfg.minDate);
  const maxDate = new Date(cfg.maxDate);
  currentYear  = today.getFullYear();
  currentMonth = today.getMonth();

  renderCalendar();
  prevBtn?.addEventListener('click', () => { currentMonth--; if (currentMonth < 0) { currentMonth = 11; currentYear--; } renderCalendar(); });
  nextBtn?.addEventListener('click', () => { currentMonth++; if (currentMonth > 11) { currentMonth = 0; currentYear++; } renderCalendar(); });
  agreeCheck?.addEventListener('change', validateSubmit);
  form?.addEventListener('submit', e => {
    if (!selectedSlot || !agreeCheck?.checked) { e.preventDefault(); return; }
    startISOInput.value = selectedSlot;
  });

  function renderCalendar() {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthLabel.textContent = `${months[currentMonth]} ${currentYear}`;
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    let html = days.map(d => `<div class="cal-dayname">${d}</div>`).join('');
    for (let i = 0; i < firstDay; i++) html += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(currentYear, currentMonth, d);
      const ymd = fmt(date);
      const isToday = ymd === fmt(today);
      const isPast = date < minDate;
      const isTooFar = date > maxDate;
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const isSelected = ymd === selectedDate;
      let cls = 'cal-day';
      if (isSelected) cls += ' selected';
      else if (isPast || isTooFar || isWeekend) cls += ' unavailable past';
      else cls += ' available has-slots';
      if (isToday) cls += ' today';
      html += `<button type="button" class="${cls}" data-ymd="${ymd}">${d}</button>`;
    }
    calContainer.innerHTML = html;
    calContainer.querySelectorAll('.cal-day.available').forEach(btn => {
      btn.addEventListener('click', () => selectDate(btn.dataset.ymd));
    });
  }

  async function selectDate(ymd) {
    selectedDate = ymd;
    selectedSlot = null;
    startISOInput.value = '';
    validateSubmit();
    renderCalendar();
    slotsSection.style.display = 'none';
    slotsEmpty.style.display = 'none';
    slotsGrid.innerHTML = '<div style="color:#999;font-size:13px">Loading…</div>';
    slotsSection.style.display = '';

    const params = new URLSearchParams({
      date: ymd,
      packageId: cfg.packageId,
      addons: cfg.addonIds.join(','),
    });
    try {
      const r = await fetch('/api/availability?' + params);
      const data = await r.json();
      if (!data.slots?.length) {
        slotsGrid.innerHTML = '';
        slotsEmpty.style.display = '';
        return;
      }
      slotsGrid.innerHTML = data.slots.map(s =>
        `<button type="button" class="slot-btn" data-iso="${s.start}">${s.label}</button>`
      ).join('');
      slotsGrid.querySelectorAll('.slot-btn').forEach(btn => {
        btn.addEventListener('click', () => selectSlot(btn.dataset.iso));
      });
    } catch (e) {
      slotsGrid.innerHTML = '<div style="color:#c0392b;font-size:13px">Could not load times. Refresh and try again.</div>';
    }
  }

  function selectSlot(iso) {
    selectedSlot = iso;
    startISOInput.value = iso;
    slotsGrid.querySelectorAll('.slot-btn').forEach(b => b.classList.toggle('selected', b.dataset.iso === iso));
    validateSubmit();
  }

  function validateSubmit() {
    const ready = selectedSlot && agreeCheck?.checked;
    submitBtn.disabled = !ready;
    submitHint.textContent = !selectedSlot ? 'Select a date and time to continue.'
      : !agreeCheck?.checked ? 'Agree to the booking policies to continue.'
      : '';
  }

  function fmt(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
})();
