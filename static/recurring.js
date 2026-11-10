(function () {
    // "Once" means a planned one-off: rename the date field and hide the end date.
    const freq = document.getElementById('frequency');
    const label = document.getElementById('next-label');
    const end = document.querySelector('.end-field');
    function sync() {
        const once = freq.value === 'once';
        label.textContent = once ? 'Date' : 'Next date';
        end.hidden = once;
        if (once) end.querySelector('input').value = '';
    }
    freq.addEventListener('change', sync);
    sync();
})();
