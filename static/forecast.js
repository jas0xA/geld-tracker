(function () {
    const { money, reduce, countUp, setSegActive } = window.UI;
    const root = document.getElementById('forecast');
    const D = JSON.parse(root.dataset.forecast);
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const C = { income: v('--income'), expense: v('--expense'), accent: v('--accent'), muted: v('--muted'),
                line: v('--line'), lineSoft: v('--line-soft'), surface2: v('--surface-2'), cream: v('--cream'), text: v('--text') };

    const fmtDay = (iso) => new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const state = { price: 0, when: 'now' };
    const shown = new Map();

    const series = () => D.fixed;
    function withPurchase(s) {
        if (!state.price) return null;
        const from = state.when === 'now' ? 0 : D.end_this.index + 1;
        return s.map((x, i) => (i >= from ? x - state.price : x));
    }
    function lowest(s) {
        let idx = 0;
        s.forEach((x, i) => { if (x < s[idx]) idx = i; });
        return { value: s[idx], date: D.labels[idx] };
    }
    function animateNumber(el, cents, signed) {
        const from = shown.has(el) ? shown.get(el) : 0;
        shown.set(el, cents);
        countUp(el, cents, signed, from);
        el.classList.toggle('neg', cents < 0);
        el.classList.toggle('pos', cents >= 0);
    }
    function deltaText(cents) {
        const diff = cents - D.start;
        const cls = diff >= 0 ? 'pos' : 'neg';
        return `<span class="chip ${cls}">${diff >= 0 ? '▲' : '▼'} ${money(Math.abs(diff))}</span> vs now`;
    }

    // ------------------------------------------------------------------ chart
    Chart.defaults.color = C.muted;
    Chart.defaults.font.family = 'Georgia, "Palatino Linotype", Palatino, serif';
    Chart.defaults.animation = reduce ? false : Chart.defaults.animation;
    Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: C.surface2, borderColor: C.line, borderWidth: 1, cornerRadius: 3,
        titleColor: C.cream, bodyColor: C.text, padding: 10, boxPadding: 4, usePointStyle: true });
    Object.assign(Chart.defaults.plugins.legend.labels, { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, padding: 16 });

    const eventDays = new Set(D.events.map((e) => e.date));
    const eventsByDay = {};
    D.events.forEach((e) => (eventsByDay[e.date] = eventsByDay[e.date] || []).push(e));
    let chart;

    function progressive(points) {
        const step = 1200 / Math.max(points, 1);
        const base = (ctx) => ctx.chart.scales.y.getPixelForValue(D.start);
        const prevY = (ctx) => {
            if (ctx.index === 0) return base(ctx);
            const el = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1];
            const y = el && el.getProps(['y'], true).y;
            return Number.isFinite(y) ? y : base(ctx);
        };
        const delay = (key) => (ctx) => {
            if (ctx.type !== 'data' || ctx[key]) return 0;
            ctx[key] = true;
            return ctx.index * step;
        };
        return {
            x: { type: 'number', easing: 'linear', duration: step, from: NaN, delay: delay('xs') },
            y: { type: 'number', easing: 'linear', duration: step, from: prevY, delay: delay('ys') },
        };
    }

    function draw() {
        const s = series();
        const p = withPurchase(s);
        chart?.destroy();
        chart = new Chart(document.getElementById('fc-chart'), {
            type: 'line',
            data: {
                labels: D.labels,
                datasets: [
                    {
                        label: 'Projected balance',
                        data: s,
                        stepped: 'after',
                        borderColor: C.accent, borderWidth: 2.5,
                        segment: { borderColor: (ctx) => (ctx.p1.parsed.y < 0 ? C.expense : C.accent) },
                        fill: { target: 'origin', above: C.accent + '1f', below: C.expense + '33' },
                        pointRadius: D.labels.map((d) => (eventDays.has(d) ? (D.labels.length > 120 ? 2.5 : 4) : 0)),
                        pointBackgroundColor: D.labels.map((d) => {
                            const sum = (eventsByDay[d] || []).reduce((a, e) => a + e.cents, 0);
                            return sum >= 0 ? C.income : C.expense;
                        }),
                        pointBorderColor: C.surface2, pointBorderWidth: 1.5, pointHoverRadius: 6,
                    },
                    ...(p ? [{
                        label: 'After buying', data: p, stepped: 'after',
                        borderColor: C.cream, borderDash: [6, 5], borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, fill: false,
                    }] : []),
                ],
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                animation: reduce ? false : progressive(D.labels.length),
                scales: {
                    x: { grid: { display: false }, border: { color: C.line },
                         ticks: { autoSkip: true, maxRotation: 0, autoSkipPadding: 14, callback: (val) => fmtDay(D.labels[val]) } },
                    y: { border: { display: false }, ticks: { maxTicksLimit: 6, callback: (val) => '€' + Math.round(val / 100).toLocaleString('en-US') },
                         grid: { color: (ctx) => (ctx.tick && ctx.tick.value === 0 ? C.muted : C.lineSoft), lineWidth: (ctx) => (ctx.tick && ctx.tick.value === 0 ? 1.5 : 1) } },
                },
                plugins: {
                    legend: { align: 'end' },
                    tooltip: {
                        callbacks: {
                            title: (items) => fmtDay(D.labels[items[0].dataIndex]),
                            label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.parsed.y)}`,
                            afterBody: (items) => (eventsByDay[D.labels[items[0].dataIndex]] || [])
                                .map((e) => `${e.cents > 0 ? '+' : '−'} ${e.description} ${money(Math.abs(e.cents))}`),
                        },
                    },
                },
            },
        });
    }

    // ------------------------------------------------------------------ numbers, verdict
    function update(redraw) {
        const s = series();
        document.querySelectorAll('[data-fc-index]').forEach((el) => animateNumber(el, s[+el.dataset.fcIndex], false));
        document.querySelectorAll('[data-fc-delta]').forEach((el) => (el.innerHTML = deltaText(s[+el.dataset.fcDelta])));
        const low = lowest(s);
        document.getElementById('fc-lowest').innerHTML = low.value < 0
            ? `Goes below zero: lowest <strong class="neg">${money(low.value)}</strong> on ${fmtDay(low.date)}`
            : `Lowest point: <strong>${money(low.value)}</strong> on ${fmtDay(low.date)}`;

        const verdict = document.getElementById('verdict');
        const p = withPurchase(s);
        if (!p) {
            verdict.innerHTML = '<p class="sub">Type a price to see if you\'ll still have enough.</p>';
        } else {
            const lowP = lowest(p);
            const end = p[D.horizon.index];
            const ok = lowP.value >= 0;
            verdict.innerHTML = `
                <div class="verdict-head ${ok ? 'pos' : 'neg'}">${ok ? 'Yes, you can afford it' : 'Not right now'}</div>
                <div class="stat-row"><span>End of ${D.horizon.label}</span><strong class="${end >= 0 ? 'pos' : 'neg'}">${money(end)}</strong></div>
                <div class="stat-row"><span>Lowest point</span><strong class="${ok ? '' : 'neg'}">${money(lowP.value)} · ${fmtDay(lowP.date)}</strong></div>
                ${ok ? '' : `<p class="sub">You'd be ${money(-lowP.value)} short around ${fmtDay(lowP.date)}.</p>`}`;
            verdict.classList.remove('flash-in'); void verdict.offsetWidth; verdict.classList.add('flash-in');
        }
        if (redraw) draw();
        else if (chart) {
            // Only the purchase line changed: update in place instead of redrawing from scratch.
            const ds = chart.data.datasets;
            if (p && ds[1]) ds[1].data = p;
            else if (p || ds[1]) return draw();
            chart.update();
        }
    }

    const parse = (raw) => {
        let s = (raw || '').replace(/[€\s ]/g, '');
        if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
        else s = s.replace(',', '.');
        const n = Math.round(parseFloat(s) * 100);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };

    const whenSeg = document.getElementById('afford-when');
    whenSeg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-when]');
        if (!b) return;
        state.when = b.dataset.when;
        setSegActive(whenSeg, (x) => x === b);
        update(false);
    });
    let t;
    document.getElementById('afford').addEventListener('input', (e) => {
        clearTimeout(t);
        t = setTimeout(() => { state.price = parse(e.target.value); update(false); }, 120);
    });

    animateNumber(document.getElementById('fc-now'), D.start, false);
    setTimeout(() => update(true), reduce ? 0 : 200);
})();
