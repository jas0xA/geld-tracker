(function () {
    const { money, reduce } = window.UI;
    const form = document.getElementById('balance-form');
    const tracked = JSON.parse(form.dataset.tracked || '{}');
    const cardInput = document.getElementById('card');
    const typedInput = document.getElementById('cash-typed');
    const denoms = [...document.querySelectorAll('.denom')];

    // Same rules as the server: "12,50", "1.234,56", "1,234.56", "-20".
    function parse(raw, allowNegative) {
        let s = (raw || '').replace(/[€\s ]/g, '');
        if (!s) return 0;
        if (s.includes(',') && s.includes('.')) {
            s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
        } else s = s.replace(',', '.');
        if (!/^-?\d*\.?\d*$/.test(s) || s === '-' || s === '.') return null;
        const cents = Math.round(parseFloat(s) * 100);
        if (!Number.isFinite(cents) || (cents < 0 && !allowNegative)) return null;
        return cents;
    }

    // Animated number that eases from its current value to the new one.
    const shown = new Map();
    function animateTo(el, cents) {
        const from = shown.get(el) ?? 0;
        shown.set(el, cents);
        if (reduce || from === cents) { el.textContent = money(cents); return; }
        const start = performance.now();
        const step = (now) => {
            if (shown.get(el) !== cents) return;           // a newer value took over
            const p = Math.min(1, (now - start) / 350);
            el.textContent = money(Math.round(from + (cents - from) * (1 - Math.pow(1 - p, 3))));
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    function recalc() {
        const card = parse(cardInput.value, true);
        const typed = parse(typedInput.value, false);
        cardInput.classList.toggle('invalid', card === null);
        typedInput.classList.toggle('invalid', typed === null);
        let notes = 0, coins = 0;
        denoms.forEach((d) => {
            const n = +d.querySelector('input').value;
            const sub = n * +d.dataset.cents;
            if (d.classList.contains('note')) notes += sub; else coins += sub;
        });
        const counted = notes + coins;
        const total = (card || 0) + (typed || 0) + counted;
        animateTo(document.getElementById('sum-card'), card || 0);
        animateTo(document.getElementById('sum-typed'), typed || 0);
        animateTo(document.getElementById('sum-counted'), counted);
        animateTo(document.getElementById('sum-total'), total);
        animateTo(document.getElementById('bar-total'), total);
        document.getElementById('notes-total').textContent = money(notes);
        document.getElementById('coins-total').textContent = money(coins);

        const diffEl = document.getElementById('sum-diff');
        if (diffEl && tracked.total !== undefined) {
            const diff = total - tracked.total;
            diffEl.innerHTML = diff === 0
                ? `Matches your tracked balance of <strong>${money(tracked.total)}</strong>.`
                : `Tracked balance is ${money(tracked.total)}. This is <span class="chip ${diff > 0 ? 'pos' : 'neg'}">${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}</span> ${diff > 0 ? 'more' : 'less'}.`;
        }
    }

    function setCount(d, n) {
        n = Math.max(0, Math.min(100000, n));
        d.querySelector('input').value = n;
        const badge = d.querySelector('.denom-count');
        badge.textContent = n;
        d.classList.toggle('has', n > 0);
        recalc();
    }

    function floatLabel(d, text) {
        if (reduce) return;
        const f = document.createElement('span');
        f.className = 'float-label';
        f.textContent = text;
        d.appendChild(f);
        setTimeout(() => f.remove(), 700);
    }

    denoms.forEach((d) => {
        const cents = +d.dataset.cents;
        const label = cents >= 100 ? '+€' + cents / 100 : '+' + cents + 'c';
        d.querySelector('.denom-add').addEventListener('click', () => {
            setCount(d, +d.querySelector('input').value + 1);
            d.classList.remove('pop'); void d.offsetWidth; d.classList.add('pop');
            floatLabel(d, label);
        });
        d.querySelector('.denom-minus').addEventListener('click', () => {
            setCount(d, +d.querySelector('input').value - 1);
        });
    });

    document.getElementById('reset-cash').addEventListener('click', () => {
        typedInput.value = '';
        denoms.forEach((d) => setCount(d, 0));
    });

    cardInput.addEventListener('input', recalc);
    typedInput.addEventListener('input', recalc);

    form.addEventListener('submit', (e) => {
        if (parse(cardInput.value, true) === null || parse(typedInput.value, false) === null) {
            e.preventDefault();
            (parse(cardInput.value, true) === null ? cardInput : typedInput).focus();
            return;
        }
        form.querySelectorAll('button[type=submit]').forEach((b) => b.classList.add('loading'));
    });

    recalc();
})();
