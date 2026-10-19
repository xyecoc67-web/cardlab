import { mountStripeTest } from './stripe-client.mjs';
import { normalizeMask, generateCards, validateCard, serializeCard, selectCards } from './core.mjs';

const $ = id => document.getElementById(id);
const state = { cards: [], filter: 'all', phase: 'ready', cursor: 0, timer: null, toastTimer: null };
const labels = { waiting: '—', valid: 'Format OK', invalid: 'Invalid', unknown: 'Unknown' };
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function showError(message = '', field = 'bin') {
  $('error').textContent = message; $('error').hidden = !message;
  $('bin').setAttribute('aria-invalid', String(Boolean(message) && field === 'bin'));
  $('count').setAttribute('aria-invalid', String(Boolean(message) && field === 'count'));
}
function announce(message) { $('announcer').textContent = message; }
function toast(message) { clearTimeout(state.toastTimer); $('toast').textContent = message; $('toast').hidden = false; state.toastTimer = setTimeout(() => $('toast').hidden = true, 1800); }
function filtered() { const cards = selectCards(state.cards, state.filter); return $('sort').value === 'original' ? cards.sort((a,b) => a.id-b.id) : cards; }
function renderRows() {
  const cards = filtered(); $('table').hidden = !cards.length; $('empty').hidden = Boolean(cards.length);
  $('rows').innerHTML = cards.map(card => `<tr><td class="row-index">${String(card.id).padStart(2, '0')}</td><td><code>${escapeHTML(card.pan)}<span class="separator">|</span>${escapeHTML(card.month)}<span class="separator">|</span>${escapeHTML(card.year)}<span class="separator">|</span>${escapeHTML(card.cvv)}</code></td><td><span class="network">${escapeHTML(card.network)}</span></td><td><span class="status ${card.status}" title="${escapeHTML(card.reason)}">${labels[card.status]}</span></td><td><button class="icon-button row-copy" data-copy="${card.id}" aria-label="Copy card ${card.id}"><svg><use href="#i-copy"/></svg></button></td></tr>`).join('');
  $('copy').disabled = !cards.length; $('export').disabled = !cards.length;
}
function renderProgress() {
  const counts = { all: state.cards.length, valid: 0, invalid: 0, unknown: 0 };
  state.cards.forEach(card => { if (card.status !== 'waiting') counts[card.status]++; });
  for (const kind of Object.keys(counts)) $(kind + '-count').textContent = counts[kind];
  $('total-count').textContent = state.cards.length; $('table-total').textContent = state.cards.length;
  for (const kind of ['valid','invalid','unknown']) $('metric-' + kind).textContent = counts[kind];
  const percent = state.cards.length ? Math.round(state.cursor / state.cards.length * 100) : 0;
  $('percentage').textContent = `${percent}%`; $('progress-fill').style.width = `${percent}%`;
  $('progress').setAttribute('aria-valuenow', String(percent)); $('processed').textContent = `${state.cursor} / ${state.cards.length}`;
  const phaseLabels = { ready:'Ready', running:'Checking', paused:'Paused', done:'Done' };
  $('phase').textContent = phaseLabels[state.phase];
  const action = state.phase === 'running' ? 'Pause' : state.phase === 'paused' ? 'Resume' : state.phase === 'done' ? 'Recheck' : 'Check cards';
  const buttonLabel = action === 'Check cards' ? 'Start' : action;
  $('scan').disabled = !state.cards.length;
  if ($('scan').getAttribute('aria-label') !== action) {
    $('scan').title = action; $('scan').setAttribute('aria-label',action);
    $('scan').innerHTML = `<svg aria-hidden="true"><use href="#i-${state.phase === 'running' ? 'pause' : 'play'}"/></svg><span>${buttonLabel}</span>`;
  }
  document.querySelector('.scanner').classList.toggle('running', state.phase === 'running');
}
function render() { renderProgress(); renderRows(); }
function chooseFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('[data-filter]').forEach(tab => { const active = tab.dataset.filter === filter; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
  renderRows();
}
$('bin').addEventListener('input', () => { showError(); updatePreview(); });
$('bin').addEventListener('blur', () => { if (!$('bin').value.trim()) return; try { $('bin').value = normalizeMask($('bin').value); showError(); } catch(error) { showError(error.message); } });
$('count').addEventListener('input', () => { showError(); updatePresets(); });
$('generator').addEventListener('submit', event => {
  event.preventDefault(); showError();
  let bin;
  try { bin = normalizeMask($('bin').value); } catch(error) { showError(error.message); $('bin').focus(); return; }
  const count = Number($('count').value);
  if (!Number.isInteger(count) || count < 1 || count > 500) { showError('Count must be an integer from 1 to 500.', 'count'); $('count').focus(); return; }
  let cards;
  try { cards = generateCards(bin, count); } catch(error) { showError(error.message); $('bin').focus(); return; }
  clearTimeout(state.timer); state.cards = cards; state.cursor = 0; state.phase = 'ready'; $('bin').value = bin; updatePreview(); updatePresets();
  chooseFilter('all'); render(); document.querySelector('.table-scroll').scrollTop = 0;
  announce(`${count} test cards generated.`);
});
function tick() {
  if (state.phase !== 'running') return;
  const batch = Math.max(1, Math.ceil(state.cards.length / 60));
  for (let i = 0; i < batch && state.cursor < state.cards.length; i++) {
    const card = state.cards[state.cursor++];
    Object.assign(card, validateCard(card));
  }
  if (state.cursor === state.cards.length) { state.phase = 'done'; announce('Structural validation complete.'); }
  render();
  if (state.phase === 'running') state.timer = setTimeout(tick, 35);
}
$('scan').addEventListener('click', () => {
  if (!state.cards.length) return;
  if (state.phase === 'running') { clearTimeout(state.timer); state.phase = 'paused'; renderProgress(); return; }
  if (state.phase === 'done') { state.cursor = 0; state.cards.forEach(card => { card.status = 'waiting'; card.reason = ''; }); }
  state.phase = 'running'; render(); state.timer = setTimeout(tick, 80);
});
document.querySelectorAll('[data-filter]').forEach(tab => tab.addEventListener('click', () => chooseFilter(tab.dataset.filter)));
document.querySelector('.tabs').addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('[data-filter]')]; let index = tabs.indexOf(document.activeElement);
  if (index < 0 || !['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
  event.preventDefault(); index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  chooseFilter(tabs[index].dataset.filter); tabs[index].focus();
});
async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && globalThis.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea'); field.value = text; field.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(field); field.select();
      let success; try { success = document.execCommand('copy'); } finally { field.remove(); }
      if (!success) throw new Error('Clipboard unavailable');
    }
    toast('Copied');
  } catch { toast('Clipboard unavailable'); }
}
$('copy').addEventListener('click', () => copyText(filtered().map(serializeCard).join('\n')));
$('rows').addEventListener('click', event => { const button = event.target.closest('[data-copy]'); if (!button) return; const card = state.cards.find(card => card.id === Number(button.dataset.copy)); if (card) copyText(serializeCard(card)); });
$('sort').addEventListener('change', renderRows);
function updatePresets() {
  document.querySelectorAll('[data-count]').forEach(button => { const selected = Number(button.dataset.count) === Number($('count').value); button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
}
function updatePreview() {
  const raw = $('bin').value.trim();
  if (!raw) { $('sample-number').textContent = '••••  ••••  ••••  ••••'; return; }
  try { $('sample-number').textContent = normalizeMask(raw).replaceAll('x','•').match(/.{1,4}/g).join('  '); } catch {}
}
document.querySelectorAll('[data-count]').forEach(button => button.addEventListener('click', () => { $('count').value = button.dataset.count; showError(); updatePresets(); }));
for (const [id, change] of [['decrease', -1],['increase', 1]]) $(id).addEventListener('click', () => { const previous = Number($('count').value); $('count').value = Math.max(1, Math.min(500, (Number.isFinite(previous) ? previous : 10) + change)); showError(); updatePresets(); });
$('export').addEventListener('click', () => {
  const cards = filtered(); if (!cards.length) return;
  const url = URL.createObjectURL(new Blob([cards.map(serializeCard).join('\n') + '\n'], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = `cardlab-${state.filter}-${cards.length}.txt`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
});
// Deliberately keep BIN empty on every page load. No saved defaults.
$('bin').value = '';
chooseFilter('all'); render();

mountStripeTest();
