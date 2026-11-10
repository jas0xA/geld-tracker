(function () {
    const { reduce, money, setSegActive } = window.UI;
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    const C = {
        income: v('--income'), expense: v('--expense'), accent: v('--accent'), muted: v('--muted'),
        line: v('--line'), lineSoft: v('--line-soft'), surface: v('--surface'), surface2: v('--surface-2'),
        cream: v('--cream'), text: v('--text'),
    };
    const CAT_COLORS = Array.from({ length: 10 }, (_, i) => v('--cat-' + (i + 1)));
    const CATEGORY_ORDER = [...document.querySelectorAll('.cat-picker input')].map((i) => i.value);
    const catColor = (name) => CAT_COLORS[Math.max(0, CATEGORY_ORDER.indexOf(name)) % CAT_COLORS.length];
    const isMobile = () => window.matchMedia('(max-width: 720px)').matches;

    // ------------------------------------------------------------------ chart defaults
    Chart.defaults.color = C.muted;
    Chart.defaults.font.family = 'Georgia, "Palatino Linotype", Palatino, serif';
    Chart.defaults.borderColor = C.lineSoft;
    Chart.defaults.animation = reduce ? false : Chart.defaults.animation;
    Object.assign(Chart.defaults.plugins.tooltip, {
        backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, cornerRadius: 3,
        titleColor: C.cream, bodyColor: C.text, padding: 10, boxPadding: 4, usePointStyle: true,
        titleFont: { weight: '600' },
    });
    Object.assign(Chart.defaults.plugins.legend.labels, { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, padding: 16 });

    const yAxis = {
        grid: { color: C.lineSoft },
        border: { display: false },
        ticks: { maxTicksLimit: 6, callback: (val) => '€' + Math.round(val / 100).toLocaleString('en-US') },
    };
    const xAxis = { grid: { display: false }, border: { color: C.line }, ticks: { autoSkip: true, maxRotation: 0, autoSkipPadding: 8 } };
    const moneyTooltip = { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.parsed.y ?? ctx.parsed)}` } };

    const state = {
        period: 'month', metric: 'expense',
        data: JSON.parse(document.getElementById('charts').dataset.initial),
    };
    const charts = {};

    // ------------------------------------------------------------------ bar chart (grows bar by bar)
    function drawBars() {
        const d = state.data;
        charts.bars?.destroy();
        charts.bars = new Chart(document.getElementById('chart-bars'), {
            type: 'bar',
            data: {
                labels: d.labels,
                datasets: [
                    { label: 'Earned', data: d.income, backgroundColor: C.income, hoverBackgroundColor: C.cream, borderRadius: 2, maxBarThickness: 34 },
                    { label: 'Spent', data: d.expense, backgroundColor: C.expense, hoverBackgroundColor: C.cream, borderRadius: 2, maxBarThickness: 34 },
                ],
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                animation: reduce ? false : {
                    duration: 800, easing: 'easeOutQuart',
                    delay: (ctx) => (ctx.type === 'data' && ctx.mode === 'default' ? ctx.dataIndex * (600 / d.labels.length) + ctx.datasetIndex * 90 : 0),
                },
                scales: { x: xAxis, y: { ...yAxis, beginAtZero: true } },
                plugins: { tooltip: moneyTooltip, legend: { align: 'end' } },
            },
        });
    }

    // ------------------------------------------------------------------ comparison line (draws itself left to right)
    function cumulative(values, upTo) {
        let sum = 0;
        return values.map((x, i) => { sum += x; return i <= upTo ? sum : null; });
    }
    function metricSeries(d) {
        const net = (a, b) => a.map((x, i) => x - b[i]);
        const pick = {
            expense: [d.expense, d.prev_expense],
            income: [d.income, d.prev_income],
            net: [net(d.income, d.expense), net(d.prev_income, d.prev_expense)],
        }[state.metric];
        return { cur: cumulative(pick[0], d.now_index), prev: cumulative(pick[1], Infinity) };
    }
    function progressiveAnimation(points) {
        const step = 1300 / Math.max(points, 1);
        const baseline = (ctx) => ctx.chart.scales.y.getPixelForValue(0);
        const prevY = (ctx) => {
            if (ctx.index === 0) return baseline(ctx);
            const el = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1];
            const y = el && el.getProps(['y'], true).y;
            return Number.isFinite(y) ? y : baseline(ctx);
        };
        const delay = (key) => (ctx) => {
            if (ctx.type !== 'data' || ctx[key]) return 0;
            ctx[key] = true;
            return ctx.index * step + ctx.datasetIndex * 150;
        };
        return {
            x: { type: 'number', easing: 'linear', duration: step, from: NaN, delay: delay('xStarted') },
            y: { type: 'number', easing: 'linear', duration: step, from: prevY, delay: delay('yStarted') },
        };
    }
    function drawCompare() {
        const d = state.data;
        const s = metricSeries(d);
        const noun = state.period;
        const curColor = state.metric === 'income' ? C.income : state.metric === 'expense' ? C.expense : C.accent;
        charts.compare?.destroy();
        charts.compare = new Chart(document.getElementById('chart-compare'), {
            type: 'line',
            data: {
                labels: d.labels,
                datasets: [
                    { label: 'This ' + noun, data: s.cur, borderColor: curColor, backgroundColor: curColor + '22', fill: 'origin',
                      borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: curColor, cubicInterpolationMode: 'monotone' },
                    { label: 'Last ' + noun, data: s.prev, borderColor: C.muted, backgroundColor: C.muted,
                      borderWidth: 1.8, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 4, cubicInterpolationMode: 'monotone' },
                ],
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                animation: reduce ? false : progressiveAnimation(d.labels.length),
                scales: { x: xAxis, y: yAxis },
                plugins: { tooltip: moneyTooltip, legend: { align: 'end' } },
            },
        });

        const rows = [['income', 'Earned'], ['expense', 'Spent'], ['net', 'Net']];
        document.getElementById('compare-body').innerHTML = rows.map(([key, name]) => {
            const pct = d.change[key];
            let cell = '<td>—</td>';
            if (pct !== null) {
                const good = key === 'expense' ? pct < 0 : pct > 0;
                const cls = pct === 0 ? '' : (good ? 'pos' : 'neg');
                cell = `<td><span class="chip ${cls}">${pct > 0 ? '▲' : pct < 0 ? '▼' : '–'} ${Math.abs(pct)}%</span></td>`;
            }
            return `<tr><td>${name}</td><td class="num">${money(d.totals[key])}</td><td class="num">${money(d.prev_totals[key])}</td>${cell}</tr>`;
        }).join('');
    }

    // ------------------------------------------------------------------ category donut
    function drawDonut() {
        const cats = state.data.categories;
        const total = cats.reduce((a, c) => a + c.cents, 0);
        charts.donut?.destroy();
        charts.donut = new Chart(document.getElementById('chart-donut'), {
            type: 'doughnut',
            data: {
                labels: cats.length ? cats.map((c) => c.name) : ['Nothing yet'],
                datasets: [{
                    data: cats.length ? cats.map((c) => c.cents) : [1],
                    backgroundColor: cats.length ? cats.map((c) => catColor(c.name)) : [C.surface2],
                    borderColor: C.surface, borderWidth: 3, hoverOffset: 8, spacing: 1,
                }],
            },
            options: {
                maintainAspectRatio: false, cutout: '70%',
                animation: reduce ? false : { animateRotate: true, animateScale: true, duration: 1100, easing: 'easeOutQuart' },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: cats.length > 0, callbacks: { label: (ctx) => ` ${ctx.label}: ${money(ctx.parsed)}` } },
                },
            },
        });
        window.UI.countUp(document.getElementById('donut-total'), total, false);

        const list = document.getElementById('cat-list');
        if (!cats.length) {
            list.innerHTML = '<li class="sub">No spending in this period yet.</li>';
            return;
        }
        list.innerHTML = cats.slice(0, 6).map((c, i) => {
            const pct = total ? Math.round(c.cents / total * 100) : 0;
            return `<li data-pct="${pct}" data-color="${catColor(c.name)}" data-idx="${i}">
                <div class="cat-row"><span><i class="dot"></i>${escapeHtml(c.name)}</span><span class="num">${money(c.cents)} · ${pct}%</span></div>
                <div class="cat-bar"><i></i></div></li>`;
        }).join('');
        list.querySelectorAll('li').forEach((li) => {
            li.style.setProperty('--i', li.dataset.idx);
            li.querySelector('.dot').style.backgroundColor = li.dataset.color;
            const bar = li.querySelector('.cat-bar i');
            bar.style.backgroundColor = li.dataset.color;
            requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = li.dataset.pct + '%')));
        });
    }
    function escapeHtml(s) {
        return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function renderAll() {
        const d = state.data;
        document.querySelectorAll('.noun').forEach((el) => (el.textContent = state.period));
        document.getElementById('cmp-ranges').textContent = `${d.label} vs ${d.prev_label}`;
        const label = document.getElementById('range-label');
        label.classList.add('swap');
        setTimeout(() => { label.textContent = d.label; label.classList.remove('swap'); }, reduce ? 0 : 180);
        // everything is redrawn now, so stop waiting for lazy first draws
        Object.keys(drawers).forEach((id) => { drawn.add(id); io.unobserve(document.getElementById(id)); });
        drawBars();
        drawCompare();
        drawDonut();
    }

    // ------------------------------------------------------------------ period + metric switching
    const periodTabs = document.getElementById('period-tabs');
    const chartPanels = document.querySelectorAll('.chart-panel');
    let loadToken = 0;
    periodTabs.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-period]');
        if (!btn || btn.dataset.period === state.period) return;
        const period = btn.dataset.period;
        const token = ++loadToken;
        setSegActive(periodTabs, (b) => b === btn);   // move the indicator immediately
        chartPanels.forEach((p) => p.classList.add('loading'));
        try {
            const res = await fetch('/api/stats?period=' + encodeURIComponent(period), { credentials: 'same-origin' });
            if (res.status === 401) { location.reload(); return; }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (token !== loadToken) return;          // a newer click won
            state.period = period;
            state.data = data;
            renderAll();
        } catch (err) {
            setSegActive(periodTabs, (b) => b.dataset.period === state.period);
            console.error('Could not load stats', err);
        } finally {
            if (token === loadToken) chartPanels.forEach((p) => p.classList.remove('loading'));
        }
    });

    const metricTabs = document.getElementById('metric-tabs');
    metricTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-metric]');
        if (!btn || btn.dataset.metric === state.metric) return;
        state.metric = btn.dataset.metric;
        setSegActive(metricTabs, (b) => b === btn);
        drawCompare();
    });

    // Draw charts when they scroll into view, so their animation is actually seen.
    const drawn = new Set();
    const drawers = { charts: drawBars, compare: drawCompare, categories: drawDonut };
    const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
            if (en.isIntersecting && !drawn.has(en.target.id)) {
                drawn.add(en.target.id);
                drawers[en.target.id]();
                io.unobserve(en.target);
            }
        });
    }, { threshold: 0.25 });
    document.getElementById('cmp-ranges').textContent = `${state.data.label} vs ${state.data.prev_label}`;
    Object.keys(drawers).forEach((id) => io.observe(document.getElementById(id)));

    // ------------------------------------------------------------------ greeting + live clock
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const g = document.getElementById('greeting');
    g.textContent = g.textContent.replace('Welcome back', greet);
    // Date & time field: follows the clock until the user picks another moment.
    const when = document.getElementById('when');
    const whenText = document.getElementById('when-text');
    const pad = (n) => String(n).padStart(2, '0');
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    let followNow = true;
    function describe() {
        if (followNow) { whenText.textContent = 'Saved as right now. Pick another date if it happened earlier.'; return; }
        const d = new Date(when.value);
        if (isNaN(d)) { whenText.textContent = 'Pick a date and time.'; return; }
        const future = d > new Date();
        whenText.textContent = future
            ? 'That is in the future. Use Recurring → Once to plan it.'
            : 'Saved on ' + d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + '.';
        when.classList.toggle('invalid', future);
    }
    function tick() {
        const now = local(new Date());
        when.max = now;
        if (followNow) when.value = now;
    }
    when.addEventListener('input', () => { followNow = false; describe(); });
    document.querySelectorAll('.when-quick [data-when]').forEach((b) => b.addEventListener('click', () => {
        const days = +b.dataset.when;
        followNow = days === 0;
        const d = new Date();
        if (days) { d.setDate(d.getDate() - days); }
        when.value = local(d);
        when.classList.remove('invalid');
        describe();
    }));
    tick();
    describe();
    setInterval(tick, 15000);

    // ------------------------------------------------------------------ add form
    const form = document.getElementById('add-form');
    form.addEventListener('submit', () => form.querySelector('button[type="submit"]').classList.add('loading'));

    // ------------------------------------------------------------------ mobile bottom sheet
    const sheet = document.getElementById('add');
    const fab = document.getElementById('fab');
    const backdrop = document.getElementById('sheet-backdrop');
    function openSheet() {
        if (!isMobile()) { document.getElementById('amount').focus(); return; }
        sheet.classList.add('open');
        backdrop.classList.add('open');
        fab.classList.add('open');
        fab.setAttribute('aria-expanded', 'true');
        document.body.classList.add('sheet-open');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        setTimeout(() => document.getElementById('amount').focus(), reduce ? 0 : 350);
    }
    function closeSheet() {
        sheet.classList.remove('open');
        sheet.style.transform = '';
        backdrop.classList.remove('open');
        fab.classList.remove('open');
        fab.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('sheet-open');
        sheet.removeAttribute('role');
        sheet.removeAttribute('aria-modal');
    }
    fab.addEventListener('click', () => (sheet.classList.contains('open') ? closeSheet() : openSheet()));
    backdrop.addEventListener('click', closeSheet);
    sheet.querySelector('.sheet-close').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet(); });
    window.addEventListener('resize', () => { if (!isMobile() && sheet.classList.contains('open')) closeSheet(); });
    if (location.hash === '#add') openSheet();

    // swipe the sheet down to close
    let startY = null;
    const handle = sheet.querySelector('.sheet-handle');
    [handle, sheet.querySelector('.panel-head')].forEach((el) => {
        el.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; sheet.classList.add('dragging'); }, { passive: true });
    });
    sheet.addEventListener('touchmove', (e) => {
        if (startY === null) return;
        const dy = Math.max(0, e.touches[0].clientY - startY);
        sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', (e) => {
        if (startY === null) return;
        const dy = e.changedTouches[0].clientY - startY;
        startY = null;
        sheet.classList.remove('dragging');
        sheet.style.transform = '';
        if (dy > 90) closeSheet();
    });

    // ------------------------------------------------------------------ mobile: swipeable cards + dots
    const cards = document.getElementById('cards');
    const dots = [...document.querySelectorAll('#card-dots span')];
    cards.addEventListener('scroll', () => {
        const w = cards.firstElementChild.getBoundingClientRect().width + 12;
        const idx = Math.round(cards.scrollLeft / w);
        dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    }, { passive: true });

    // ------------------------------------------------------------------ mobile: tap an entry to reveal delete
    document.querySelectorAll('.entry').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (!isMobile() || e.target.closest('form')) return;
            document.querySelectorAll('.entry.open').forEach((r) => r !== row && r.classList.remove('open'));
            row.classList.toggle('open');
        });
    });

})();
