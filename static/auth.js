(function () {
    const card = document.querySelector('.auth-card');
    const seg = card.querySelector('[data-seg]');
    const tabs = { login: document.getElementById('tab-login'), signup: document.getElementById('tab-signup') };
    const forms = { login: document.getElementById('form-login'), signup: document.getElementById('form-signup') };

    function show(which, focus) {
        window.UI.setSegActive(seg, (b) => b === tabs[which]);
        for (const key of Object.keys(forms)) forms[key].classList.toggle('active', key === which);
        if (focus) forms[which].querySelector('input:not([type=hidden])').focus({ preventScroll: true });
    }

    tabs.login.addEventListener('click', () => show('login', true));
    tabs.signup.addEventListener('click', () => show('signup', true));
    show(card.dataset.activeTab === 'signup' ? 'signup' : 'login');

    // show / hide password
    card.querySelectorAll('.pw-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            const hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            btn.textContent = hidden ? 'Hide' : 'Show';
            btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
        });
    });

    // spinner on submit
    Object.values(forms).forEach((f) => f.addEventListener('submit', () => f.querySelector('.btn').classList.add('loading')));
})();
