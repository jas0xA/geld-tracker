/* Shared UI behaviour: entrance staggering, sliding segmented controls, ripples,
   toasts, count-up numbers, animated removals. */
(function () {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
    const money = (cents, signed) => {
        const s = fmt.format(Math.abs(cents) / 100);
        return (cents < 0 ? '-' : (signed && cents > 0 ? '+' : '')) + s;
    };

    // ---- staggered entrance
    document.querySelectorAll('[data-animate]').forEach((el, i) => el.style.setProperty('--i', i));
    document.querySelectorAll('[data-i]').forEach((el) => el.style.setProperty('--i', Math.min(+el.dataset.i, 14) + 4));

    // ---- segmented controls with a sliding indicator
    function activeItem(seg) {
        return seg.querySelector('button.active, a.active') || seg.querySelector('input:checked + label');
    }
    function updateSeg(seg, instant) {
        const ind = seg.querySelector('.seg-indicator');
        const item = activeItem(seg);
        if (!ind || !item) return;
        if (instant) ind.style.transition = 'none';
        ind.style.width = item.offsetWidth + 'px';
        ind.style.transform = `translateX(${item.offsetLeft}px)`;
        const checked = seg.querySelector('input:checked');
        ind.classList.toggle('expense', !!checked && checked.value === 'expense');
        ind.classList.toggle('income', !!checked && checked.value === 'income');
        if (instant) { ind.offsetWidth; ind.style.transition = ''; }
    }
    function initSeg(seg) {
        const ind = document.createElement('span');
        ind.className = 'seg-indicator';
        seg.prepend(ind);
        seg.classList.add('js');
        updateSeg(seg, true);
        seg.addEventListener('change', () => updateSeg(seg));
    }
    const segs = [...document.querySelectorAll('[data-seg]')];
    segs.forEach(initSeg);
    // fonts/layout can shift after load; keep indicators aligned
    window.addEventListener('load', () => segs.forEach((s) => updateSeg(s, true)));
    window.addEventListener('resize', () => segs.forEach((s) => updateSeg(s, true)));

    function setSegActive(seg, matchFn) {
        seg.querySelectorAll('button').forEach((b) => {
            const on = matchFn(b);
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on);
        });
        updateSeg(seg);
    }

    // ---- ripple on buttons
    document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.btn, .fab');
        if (!btn || reduce) return;
        const r = btn.getBoundingClientRect();
        const dot = document.createElement('span');
        dot.className = 'ripple';
        dot.style.left = (e.clientX - r.left) + 'px';
        dot.style.top = (e.clientY - r.top) + 'px';
        btn.appendChild(dot);
        setTimeout(() => dot.remove(), 650);
    });

    // ---- toasts: auto dismiss, click to dismiss
    function dismiss(t) {
        t.classList.add('leaving');
        setTimeout(() => t.remove(), 320);
    }
    document.querySelectorAll('.toast').forEach((t, i) => {
        t.style.animationDelay = (250 + i * 120) + 'ms';
        t.addEventListener('click', () => dismiss(t));
        setTimeout(() => dismiss(t), 4800 + i * 120);
    });

    // ---- top bar shadow once scrolled
    const topbar = document.getElementById('topbar');
    if (topbar) {
        const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 4);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    // ---- count-up numbers
    function countUp(el, to, signed, from = 0) {
        if (reduce) { el.textContent = money(to, signed); return; }
        const start = performance.now();
        const dur = 1100;
        const step = (now) => {
            const p = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - p, 4);
            el.textContent = money(Math.round(from + (to - from) * eased), signed);
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }
    setTimeout(() => {
        document.querySelectorAll('[data-count]').forEach((el) => countUp(el, +el.dataset.count, el.dataset.signed === '1'));
        document.querySelectorAll('[data-width]').forEach((el) => (el.style.width = el.dataset.width + '%'));
    }, reduce ? 0 : 250);

    // ---- category picker: add your own / remove your own
    const csrf = () => document.querySelector('input[name="csrf_token"]')?.value || '';
    async function post(url, fields) {
        const body = new FormData();
        body.append('csrf_token', csrf());
        Object.entries(fields || {}).forEach(([k, val]) => body.append(k, val));
        const res = await fetch(url, { method: 'POST', body, credentials: 'same-origin' });
        let data = {};
        try { data = await res.json(); } catch (_) { /* not JSON */ }
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
    }
    function chipFor(id, name) {
        const span = document.createElement('span');
        span.className = 'cat-chip custom chip-new';
        span.dataset.id = id;
        const input = document.createElement('input');
        Object.assign(input, { type: 'radio', name: 'category', id: 'cat-c' + id, value: name });
        const label = document.createElement('label');
        label.htmlFor = input.id;
        label.textContent = name;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'chip-x';
        x.setAttribute('aria-label', 'Remove category ' + name);
        x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        span.append(input, label, x);
        return span;
    }
    document.querySelectorAll('[data-cat-picker]').forEach((picker) => {
        const wrap = picker.parentElement;
        const input = wrap.querySelector('[data-cat-input]');
        const addBtn = wrap.querySelector('[data-cat-add]');
        const err = wrap.querySelector('[data-cat-error]');
        const showError = (msg) => { err.textContent = msg; err.hidden = !msg; };

        async function add() {
            const name = input.value.trim().replace(/\s+/g, ' ');
            if (!name) { input.focus(); return; }
            const existing = [...picker.querySelectorAll('input')].find((i) => i.value.toLowerCase() === name.toLowerCase());
            if (existing) { existing.checked = true; input.value = ''; showError(''); return; }
            addBtn.classList.add('loading');
            try {
                const c = await post(picker.dataset.addUrl, { name });
                const chip = chipFor(c.id, c.name);
                picker.appendChild(chip);
                chip.querySelector('input').checked = true;
                input.value = '';
                showError('');
            } catch (ex) {
                showError(ex.message);
            } finally {
                addBtn.classList.remove('loading');
            }
        }
        addBtn.addEventListener('click', add);
        // Enter in the type bar adds the category instead of submitting the whole form.
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
        input.addEventListener('input', () => showError(''));

        picker.addEventListener('click', async (e) => {
            const x = e.target.closest('.chip-x');
            if (!x) return;
            const chip = x.closest('.cat-chip');
            const name = chip.querySelector('input').value;
            if (!confirm(`Remove the category "${name}"? Entries that use it keep the name.`)) return;
            try {
                await post(picker.dataset.deleteUrl.replace('/0/', '/' + chip.dataset.id + '/'));
                const wasChecked = chip.querySelector('input').checked;
                chip.classList.add('chip-leaving');
                setTimeout(() => {
                    chip.remove();
                    if (wasChecked) picker.querySelector('input').checked = true;
                }, reduce ? 0 : 250);
            } catch (ex) {
                showError(ex.message);
            }
        });
    });

    // ---- animated removal for delete forms
    document.addEventListener('submit', (e) => {
        const form = e.target;
        if (!form.matches('[data-remove]')) return;
        if (form.dataset.confirm && !confirm(form.dataset.confirm)) { e.preventDefault(); return; }
        e.preventDefault();
        const row = form.closest('li');
        if (row) row.classList.add('removing');
        setTimeout(() => form.submit(), reduce ? 0 : 320);
    });

    window.UI = { reduce, money, countUp, updateSeg, setSegActive, post };
})();
