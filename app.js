'use strict';
/* ════════════════════════════════════════════
   MDB ANALYSER — app.js v2 (Apple 2025)
════════════════════════════════════════════ */

// ── IndexedDB ────────────────────────────────
let db;
const DB_NAME = 'mdb_analyser', DB_VER = 1;

function initDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('dossiers')) d.createObjectStore('dossiers', { keyPath: 'dossier_id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = e => { db = e.target.result; res(); };
    r.onerror = rej;
  });
}
const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
const dbGet = (store, key) => new Promise((res, rej) => { const r = tx(store).get(key); r.onsuccess = e => res(e.target.result); r.onerror = rej; });
const dbPut = (store, obj) => new Promise((res, rej) => { const r = tx(store, 'readwrite').put(obj); r.onsuccess = res; r.onerror = rej; });
const dbDel = (store, key) => new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = res; r.onerror = rej; });
const dbAll = (store) => new Promise((res, rej) => { const r = tx(store).getAll(); r.onsuccess = e => res(e.target.result); r.onerror = rej; });

// ── Settings ─────────────────────────────────
const DEFS = { taux_frais_notaire_defaut: 0.075, seuil_rapide_jours: 180, seuil_marge_forte_pct: 0.20, is_defaut_pct: 0.25, seuil_risque_haut: 70 };
let S = { ...DEFS };
async function loadSettings() { for (const k of Object.keys(DEFS)) { const r = await dbGet('settings', k); if (r) S[k] = r.value; } }
async function saveSetting(k, v) { await dbPut('settings', { key: k, value: v }); S[k] = v; }

// ── Format helpers ────────────────────────────
const fmt = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtEur = n => n == null ? '—' : fmt(n) + '\u202f€';
const fmtPct = n => n == null ? '—' : (n * 100).toFixed(1) + '\u202f%';
const dateDiff = (a, b) => (!a || !b) ? null : Math.round((new Date(b) - new Date(a)) / 86400000);

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Compute ───────────────────────────────────
function computeMarge(d) {
  const achat = +d.prix_achat || null, revente = +d.prix_revente_total || null, travaux = +d.travaux_estimes || 0;
  let fn = 0;
  if (achat) {
    fn = d.frais_notaire_mode === 'Manuel'
      ? (+d.frais_notaire_montant_manuel || achat * S.taux_frais_notaire_defaut)
      : achat * (+d.frais_notaire_taux || S.taux_frais_notaire_defaut);
  }
  const cout = achat ? achat + fn + travaux : null;
  const brute = (cout && revente) ? revente - cout : null;
  const pct = (brute !== null && cout) ? brute / cout : null;
  const pm2a = (achat && d.surface_m2) ? achat / d.surface_m2 : null;
  const pm2r = (revente && d.surface_m2) ? revente / d.surface_m2 : null;
  return { fn, brute, pct, pm2_achat: pm2a, pm2_revente: pm2r, cout_total: cout, achat, revente };
}

function computeRisk(d) {
  let score = 0; const details = [];
  if (d.copro) { score += 20; details.push('Copro +20'); }
  if (d.risque_urbanisme) { score += 20; details.push('Urbanisme +20'); }
  if (d.type_operation === 'VEFA') { score += 15; details.push('VEFA +15'); }
  if (d.division_cadastrale) { score += 15; details.push('Division cadastrale +15'); }
  if (d.tva_type === 'Total') { score += 10; details.push('TVA total +10'); }
  if (d.delais_risque === 'Élevé') { score += 10; details.push('Délais +10'); }
  if (d.risque_requalification === 'Élevé') { score += 10; details.push('Requalification +10'); }
  return { score: Math.min(100, score), details };
}

function computeTags(d) {
  const tags = [];
  const dur = dateDiff(d.date_achat, d.date_revente);
  const m = computeMarge(d);
  const r = computeRisk(d);
  if (dur !== null && dur < S.seuil_rapide_jours) tags.push('Rapide');
  if (m.pct !== null && m.pct > S.seuil_marge_forte_pct) tags.push('Marge forte');
  if (d.tva_type === 'Total' || d.type_operation === 'VEFA' || (d.bien_statut && d.bien_statut !== 'Ancien')) tags.push('TVA sensible');
  if (d.copro) tags.push('Copro');
  if (d.risque_urbanisme || d.permis || d.division_cadastrale) tags.push('Urbanisme');
  if (r.score >= S.seuil_risque_haut) tags.push('Risque haut');
  if (d.gain_negociation_achat) tags.push('Négociation');
  if (d.gain_information) tags.push('Info asymétrique');
  if (d.gain_optimisation_fiscale) tags.push('Optim. fiscale');
  if (d.gain_decoupe_intelligente) tags.push('Découpe');
  if (d.gain_timing) tags.push('Timing');
  return tags;
}

// ── Tag color map ─────────────────────────────
const TAG_CLASS = {
  'Marge forte': 'green', 'Rapide': 'teal', 'TVA sensible': 'amber',
  'Risque haut': 'rose', 'Copro': 'violet', 'Urbanisme': 'amber',
  'Négociation': 'gold', 'Info asymétrique': 'gold', 'Optim. fiscale': 'gold',
  'Découpe': 'teal', 'Timing': 'teal'
};
const tagHtml = tags => tags.map(t => `<span class="tag ${TAG_CLASS[t]||''}">${t}</span>`).join('');

// ── Navigation ────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if (page === 'dossiers') renderDossiersList();
  if (page === 'insights') renderInsights();
  if (page === 'parametres') renderSettings();
  if (page === 'export') renderExport();
}

// ── Accordions ────────────────────────────────
function initAccordions() {
  document.querySelectorAll('.accordion-header, .accordion > .accordion-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.accordion').classList.toggle('open'));
  });
}

// ── Form ──────────────────────────────────────
let editingId = null;

function clearForm() {
  editingId = null;
  document.getElementById('form-dossier').querySelectorAll('input,select,textarea').forEach(el => {
    if (el.type === 'checkbox') el.checked = false;
    else if (el.type === 'range') { el.value = 5; updateSlider(); }
    else el.value = '';
  });
  document.getElementById('frais_notaire_taux').value = S.taux_frais_notaire_defaut;
  document.getElementById('is_estime_pct').value = S.is_defaut_pct;
  document.getElementById('btn-supprimer').classList.add('hidden');
  document.querySelector('#page-nouveau h1').textContent = 'Nouvelle fiche';
  document.querySelectorAll('#page-nouveau .accordion').forEach((a, i) => a.classList.toggle('open', i === 0));
  updateComputed();
}

function loadIntoForm(d) {
  editingId = d.dossier_id;
  Object.keys(d).forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!d[k];
    else if (el.type === 'range') { el.value = d[k] || 5; updateSlider(); }
    else el.value = d[k] ?? '';
  });
  document.getElementById('btn-supprimer').classList.remove('hidden');
  document.querySelector('#page-nouveau h1').textContent = d.dossier_id;
  document.querySelectorAll('#page-nouveau .accordion').forEach(a => a.classList.add('open'));
  updateComputed();
  navigate('nouveau');
}

function collectForm() {
  const g = id => {
    const el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') return el.value !== '' ? parseFloat(el.value) : null;
    return el.value;
  };
  return {
    dossier_id: g('dossier_id'), type_operation: g('type_operation'), structure: g('structure'),
    localisation_ville: g('localisation_ville'), localisation_cp: g('localisation_cp'),
    copro: g('copro'), surface_m2: g('surface_m2'), nb_lots: g('nb_lots'),
    date_achat: g('date_achat'), date_revente: g('date_revente'),
    question_strategique_pourquoi: g('question_strategique_pourquoi'),
    prix_achat: g('prix_achat'), prix_revente_total: g('prix_revente_total'),
    travaux_estimes: g('travaux_estimes'), frais_notaire_mode: g('frais_notaire_mode'),
    frais_notaire_taux: g('frais_notaire_taux'), frais_notaire_montant_manuel: g('frais_notaire_montant_manuel'),
    tva_type: g('tva_type'), tva_montant: g('tva_montant'), bien_statut: g('bien_statut'),
    risque_requalification: g('risque_requalification'), is_estime_pct: g('is_estime_pct'),
    commentaire_fiscal: g('commentaire_fiscal'), risque_urbanisme: g('risque_urbanisme'),
    permis: g('permis'), division_cadastrale: g('division_cadastrale'),
    marche_tendu: g('marche_tendu'), delais_risque: g('delais_risque'), risques_notes: g('risques_notes'),
    gain_negociation_achat: g('gain_negociation_achat'), gain_information: g('gain_information'),
    gain_optimisation_fiscale: g('gain_optimisation_fiscale'), gain_decoupe_intelligente: g('gain_decoupe_intelligente'),
    gain_timing: g('gain_timing'), pattern_note: g('pattern_note'),
    verdict: g('verdict'), modifications_a_faire: g('modifications_a_faire'),
    note_confiance: parseFloat(document.getElementById('note_confiance').value),
    resume_30s: g('resume_30s'), updated_at: new Date().toISOString()
  };
}

async function saveDossier(dup = false) {
  const d = collectForm();
  if (!d.dossier_id?.trim()) { showToast('ID dossier requis'); return; }
  d.dossier_id = d.dossier_id.trim();
  const existing = await dbGet('dossiers', d.dossier_id);
  d.created_at = existing?.created_at || new Date().toISOString();
  await dbPut('dossiers', d);
  showToast(dup ? 'Dupliqué — modifiez l\'ID' : 'Dossier enregistré');
  if (dup) {
    document.getElementById('dossier_id').value = d.dossier_id + '_copy';
    editingId = d.dossier_id + '_copy';
  } else navigate('dossiers');
}

async function deleteDossier() {
  if (!editingId || !confirm(`Supprimer "${editingId}" ?`)) return;
  await dbDel('dossiers', editingId);
  showToast('Dossier supprimé');
  clearForm(); navigate('dossiers');
}

// ── Live computed ─────────────────────────────
function updateComputed() {
  const d = collectForm();
  const m = computeMarge(d);
  const r = computeRisk(d);
  const is_pct = parseFloat(document.getElementById('is_estime_pct')?.value) || S.is_defaut_pct;

  setEl('computed-fn', fmtEur(m.fn));
  const mb = document.getElementById('computed-marge-brute');
  const mp = document.getElementById('computed-marge-pct');
  if (mb) { mb.textContent = fmtEur(m.brute); mb.className = 'computed-val ' + (m.brute == null ? '' : m.brute >= 0 ? 'positive' : 'negative'); }
  if (mp) { mp.textContent = fmtPct(m.pct); mp.className = 'computed-val ' + (m.pct == null ? '' : m.pct >= 0 ? 'positive' : 'negative'); }
  setEl('computed-pm2-achat', m.pm2_achat ? fmtEur(m.pm2_achat) + '/m²' : '—');
  setEl('computed-pm2-revente', m.pm2_revente ? fmtEur(m.pm2_revente) + '/m²' : '—');
  if (m.brute !== null && m.brute > 0) {
    const is_m = m.brute * is_pct;
    setEl('computed-is', fmtEur(is_m));
    const ap = document.getElementById('computed-ap-is');
    if (ap) { ap.textContent = fmtEur(m.brute - is_m); ap.className = 'computed-val ' + (m.brute - is_m >= 0 ? 'positive' : 'negative'); }
  } else { setEl('computed-is', '—'); setEl('computed-ap-is', '—'); }

  const fill = document.getElementById('risk-bar-fill');
  if (fill) {
    fill.style.width = r.score + '%';
    fill.style.background = r.score >= 70 ? 'var(--rose)' : r.score >= 40 ? 'var(--amber)' : 'var(--green)';
  }
  const rn = document.getElementById('risk-score-num');
  if (rn) { rn.textContent = r.score; rn.style.color = r.score >= 70 ? 'var(--rose)' : r.score >= 40 ? 'var(--amber)' : 'var(--green)'; }
  setEl('risk-detail', r.details.join(' · ') || 'Aucun facteur de risque identifié');
}

function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val ?? '—'; }
function updateSlider() { const s = document.getElementById('note_confiance'); const d = document.getElementById('note_confiance_display'); if (s && d) d.textContent = s.value; }

// ── DOSSIERS LIST ─────────────────────────────
let allDossiers = [];
let filters = { type: '', verdict: '', tag: '', margeMin: '', margeMax: '', search: '' };
let sortCol = 'updated_at', sortAsc = false;

async function renderDossiersList() {
  allDossiers = await dbAll('dossiers');
  renderFiltered();
}

function verdictClass(v) {
  return { 'Je fais': 'faire', 'Je refuse': 'refuser', 'Je modifie': 'modifier', 'À étudier': 'etudier' }[v] || 'none';
}

function renderFiltered() {
  const f = filters;
  let list = allDossiers.map(d => ({ ...d, _tags: computeTags(d), _m: computeMarge(d), _r: computeRisk(d) }));
  if (f.type) list = list.filter(d => d.type_operation === f.type);
  if (f.verdict) list = list.filter(d => d.verdict === f.verdict);
  if (f.tag) list = list.filter(d => d._tags.includes(f.tag));
  if (f.margeMin !== '') list = list.filter(d => d._m.pct !== null && d._m.pct * 100 >= parseFloat(f.margeMin));
  if (f.margeMax !== '') list = list.filter(d => d._m.pct !== null && d._m.pct * 100 <= parseFloat(f.margeMax));
  if (f.search) {
    const s = f.search.toLowerCase();
    list = list.filter(d => [d.dossier_id, d.localisation_ville, d.risques_notes, d.resume_30s].some(v => (v || '').toLowerCase().includes(s)));
  }
  // Sort
  list.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (sortCol === '_marge') { va = a._m.pct ?? -999; vb = b._m.pct ?? -999; }
    if (sortCol === '_risk') { va = a._r.score; vb = b._r.score; }
    if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortAsc ? (va - vb) : (vb - va);
  });

  document.getElementById('dossiers-count').textContent = `${list.length} dossier${list.length !== 1 ? 's' : ''}`;
  const wrap = document.getElementById('dossiers-list-wrap');

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">◻</div><p>${allDossiers.length === 0 ? 'Aucun dossier. Commencez par créer une analyse.' : 'Aucun résultat pour ces filtres.'}</p></div>`;
    return;
  }

  // Check screen width for table vs cards
  const useTable = window.innerWidth > 680;
  if (useTable) {
    const thSort = (col, label) => `<th data-sort="${col}">${label}${sortCol === col ? (sortAsc ? ' ↑' : ' ↓') : ''}</th>`;
    wrap.innerHTML = `<div style="overflow-x:auto"><table class="dossier-table">
      <thead><tr>
        ${thSort('dossier_id', 'ID dossier')}
        ${thSort('type_operation', 'Type d\'opération')}
        <th>Ville / CP</th>
        <th>Durée</th>
        ${thSort('_marge', 'Marge (%)')}
        ${thSort('_risk', 'Risque')}
        ${thSort('verdict', 'Verdict')}
        <th>Tags</th>
      </tr></thead>
      <tbody>
        ${list.map(d => {
          const dur = dateDiff(d.date_achat, d.date_revente);
          return `<tr data-id="${d.dossier_id}">
            <td><strong>${d.dossier_id}</strong></td>
            <td class="dim">${d.type_operation || '—'}</td>
            <td class="dim">${[d.localisation_ville, d.localisation_cp].filter(Boolean).join(' ') || '—'}</td>
            <td class="dim">${dur !== null ? dur + '\u202fj' : '—'}</td>
            <td style="color:${d._m.pct == null ? 'var(--text3)' : d._m.pct >= S.seuil_marge_forte_pct ? 'var(--green)' : d._m.pct < 0 ? 'var(--rose)' : 'var(--text)'}">${fmtPct(d._m.pct)}</td>
            <td style="color:${d._r.score >= S.seuil_risque_haut ? 'var(--rose)' : d._r.score >= 40 ? 'var(--amber)' : 'var(--green)'}">${d._r.score}</td>
            <td><span class="vbadge ${verdictClass(d.verdict)}">${d.verdict || '—'}</span></td>
            <td>${d._tags.slice(0, 3).map(t => `<span class="tag ${TAG_CLASS[t]||''}">${t}</span>`).join(' ')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
    wrap.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        if (sortCol === th.dataset.sort) sortAsc = !sortAsc;
        else { sortCol = th.dataset.sort; sortAsc = false; }
        renderFiltered();
      });
    });
  } else {
    wrap.innerHTML = `<div style="padding:10px 0">` + list.map(d => {
      const dur = dateDiff(d.date_achat, d.date_revente);
      return `<div class="dossier-card" data-id="${d.dossier_id}">
        <div class="dossier-card-top">
          <div>
            <div class="dossier-card-id">${d.dossier_id}</div>
            <div class="dossier-card-type">${d.type_operation || '—'} · ${[d.localisation_ville, d.localisation_cp].filter(Boolean).join(' ')}</div>
          </div>
          <span class="vbadge ${verdictClass(d.verdict)}">${d.verdict || '—'}</span>
        </div>
        <div class="dossier-card-meta">
          ${dur !== null ? `<span class="dossier-card-metric">⏱ <strong>${dur}j</strong></span>` : ''}
          <span class="dossier-card-metric">◈ <strong>${fmtPct(d._m.pct)}</strong></span>
          <span class="dossier-card-metric">⚡ <strong>${d._r.score}/100</strong></span>
        </div>
        ${d._tags.length ? `<div class="tags mt8">${tagHtml(d._tags)}</div>` : ''}
      </div>`;
    }).join('') + '</div>';
  }

  wrap.querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', () => openDetail(el.dataset.id)));
}

// ── Detail modal ──────────────────────────────
async function openDetail(id) {
  const d = await dbGet('dossiers', id);
  if (!d) return;
  const tags = computeTags(d), m = computeMarge(d), r = computeRisk(d);
  const dur = dateDiff(d.date_achat, d.date_revente);
  const body = document.getElementById('detail-modal-body');
  const row = (lbl, val) => `<div class="modal-item"><label>${lbl}</label><span>${val || '—'}</span></div>`;

  body.innerHTML = `
    <div class="modal-header">
      <div>
        <h1 style="font-size:20px;margin-bottom:3px">${d.dossier_id}</h1>
        <div style="font-size:12px;color:var(--text3)">${d.type_operation || ''} · ${d.localisation_ville || ''}${d.localisation_cp ? ' ' + d.localisation_cp : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="vbadge ${verdictClass(d.verdict)}">${d.verdict || '—'}</span>
        <button class="modal-close" id="det-edit-btn" style="width:auto;padding:6px 12px;border-radius:8px;font-size:12px;color:var(--violet)">Modifier</button>
        <button class="modal-close" id="det-close-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
    ${tags.length ? `<div class="tags" style="margin-bottom:18px">${tagHtml(tags)}</div>` : ''}
    <div class="modal-section">
      <div class="modal-section-title">Identité</div>
      <div class="modal-grid">
        ${row('Structure', d.structure)} ${row('Surface', d.surface_m2 ? d.surface_m2 + ' m²' : null)}
        ${row('Lots', d.nb_lots)} ${row('Copro', d.copro ? 'Oui' : 'Non')}
        ${row("Date d'achat", d.date_achat)} ${row('Date revente', d.date_revente)}
        ${row('Durée', dur !== null ? dur + ' jours' : null)}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Mécanique financière</div>
      <div class="modal-grid">
        ${row("Prix d'achat", fmtEur(m.achat))} ${row('Prix de revente', fmtEur(m.revente))}
        ${row('Travaux', fmtEur(d.travaux_estimes))} ${row('Frais notaire', fmtEur(m.fn))}
        ${row('Marge brute', fmtEur(m.brute))} ${row('Marge %', fmtPct(m.pct))}
        ${row('Prix/m² achat', m.pm2_achat ? fmtEur(m.pm2_achat) : null)} ${row('Prix/m² revente', m.pm2_revente ? fmtEur(m.pm2_revente) : null)}
      </div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Risque — ${r.score}/100</div>
      <div class="risk-bar-bg" style="margin-bottom:8px"><div style="height:4px;width:${r.score}%;border-radius:2px;background:${r.score>=70?'var(--rose)':r.score>=40?'var(--amber)':'var(--green)'}"></div></div>
      <div style="font-size:11px;color:var(--text3)">${r.details.join(' · ') || 'Aucun facteur identifié'}</div>
    </div>
    ${d.resume_30s ? `<div class="modal-section"><div class="modal-section-title">Résumé 30s</div><div style="font-size:13px;color:var(--text2);font-style:italic;line-height:1.7">"${d.resume_30s}"</div></div>` : ''}
  `;
  document.getElementById('detail-modal').classList.add('visible');
  document.getElementById('det-close-btn').onclick = () => document.getElementById('detail-modal').classList.remove('visible');
  document.getElementById('det-edit-btn').onclick = () => { document.getElementById('detail-modal').classList.remove('visible'); loadIntoForm(d); };
}

// ── Insights ──────────────────────────────────
async function renderInsights() {
  const all = await dbAll('dossiers');
  const cont = document.getElementById('insights-content');
  if (all.length === 0) { cont.innerHTML = '<div class="empty-state"><div class="empty-icon">◻</div><p>Pas encore de données à analyser.</p></div>'; return; }

  const E = all.map(d => ({ ...d, _tags: computeTags(d), _m: computeMarge(d), _r: computeRisk(d), _dur: dateDiff(d.date_achat, d.date_revente) }));
  const wM = E.filter(d => d._m.pct !== null);
  const avg = (arr, fn) => arr.length ? arr.reduce((s, d) => s + fn(d), 0) / arr.length : null;
  const avgM = wM.length ? avg(wM, d => d._m.pct) : null;
  const avgR = avg(E, d => d._r.score);
  const wD = E.filter(d => d._dur !== null);
  const avgD = wD.length ? Math.round(avg(wD, d => d._dur)) : null;

  // By type
  const byType = {};
  E.forEach(d => { const t = d.type_operation || 'Inconnu'; (byType[t] = byType[t] || []).push(d); });
  const typeRanked = Object.entries(byType)
    .map(([t, arr]) => { const wm = arr.filter(d => d._m.pct !== null); return { t, count: arr.length, avgM: wm.length ? avg(wm, d => d._m.pct) : null, avgR: Math.round(avg(arr, d => d._r.score)), avgD: avg(arr.filter(d => d._dur !== null), d => d._dur) }; })
    .sort((a, b) => (b.avgM ?? -1) - (a.avgM ?? -1));

  // By ville
  const byVille = {};
  E.forEach(d => { const v = d.localisation_ville || d.localisation_cp || '?'; (byVille[v] = byVille[v] || []).push(d); });
  const topVilles = Object.entries(byVille).filter(([, a]) => a.length >= 2).map(([v, a]) => { const wm = a.filter(d => d._m.pct !== null); return { v, count: a.length, avgM: wm.length ? avg(wm, d => d._m.pct) : null }; }).filter(v => v.avgM !== null).sort((a, b) => b.avgM - a.avgM).slice(0, 8);

  // Tags
  const tagC = {};
  E.forEach(d => d._tags.forEach(t => tagC[t] = (tagC[t] || 0) + 1));
  const topTags = Object.entries(tagC).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Compare fn
  const cmp = (f1, f2) => {
    const g1 = E.filter(f1).filter(d => d._m.pct !== null), g2 = E.filter(f2).filter(d => d._m.pct !== null);
    const a1 = g1.length ? avg(g1, d => d._m.pct) : null, a2 = g2.length ? avg(g2, d => d._m.pct) : null;
    return { a1, a2, n1: g1.length, n2: g2.length };
  };

  const patterns = detectPatterns(E);

  cont.innerHTML = `
    <!-- Stats globales -->
    <div class="stats-grid">
      <div class="stat-widget"><div class="stat-widget-value">${E.length}</div><div class="stat-widget-label">Dossiers</div></div>
      <div class="stat-widget gold"><div class="stat-widget-value">${avgM !== null ? fmtPct(avgM) : '—'}</div><div class="stat-widget-label">Marge moyenne</div><div class="stat-widget-sub">${wM.length} avec revente</div></div>
      <div class="stat-widget violet"><div class="stat-widget-value">${avgD !== null ? avgD : '—'}<span> j</span></div><div class="stat-widget-label">Durée moyenne</div></div>
      <div class="stat-widget teal"><div class="stat-widget-value">${Math.round(avgR)}</div><div class="stat-widget-label">Risque moyen <span style="font-size:10px">/100</span></div></div>
    </div>

    <!-- Top 3 types -->
    <div class="type-rank-card">
      <div class="type-rank-hd">Top types d'opération</div>
      ${typeRanked.slice(0, 5).map(({ t, count, avgM, avgR, avgD }) => `
      <div class="type-rank-item">
        <div><div class="type-rank-name">${t}</div><div class="type-rank-sub">${count} dossier${count > 1 ? 's' : ''}</div></div>
        <div class="type-rank-col"><div class="type-rank-col-label">Marge</div><div class="type-rank-val gold">${avgM !== null ? fmtPct(avgM) : '—'}</div></div>
        <div class="type-rank-col"><div class="type-rank-col-label">Risque</div><div class="type-rank-val teal">${avgR}</div></div>
        <div class="type-rank-col"><div class="type-rank-col-label">Durée</div><div class="type-rank-val">${avgD ? Math.round(avgD) + 'j' : '—'}</div></div>
      </div>`).join('')}
    </div>

    <!-- Insights grid -->
    <div class="insights-layout">
      ${topVilles.length ? `<div class="insight-card">
        <div class="insight-card-hd">Top villes (≥ 2 dossiers)</div>
        <div class="insight-card-bd">
          ${topVilles.map(({ v, count, avgM }) => `<div class="stat-row"><span class="stat-label">${v} (${count})</span><span class="stat-val gold">${fmtPct(avgM)}</span></div>`).join('')}
        </div>
      </div>` : ''}

      <div class="insight-card">
        <div class="insight-card-hd">Comparaisons croisées</div>
        <div class="insight-card-bd">
          ${(() => {
            const groups = [
              { label: 'Copro', pairs: [['Oui', d => d.copro], ['Non', d => !d.copro]] },
              { label: 'TVA', pairs: [['Marge', d => d.tva_type === 'Marge'], ['Total', d => d.tva_type === 'Total']] },
              { label: 'Urbanisme', pairs: [['Oui', d => d.risque_urbanisme], ['Non', d => !d.risque_urbanisme]] },
            ];
            return groups.map(g => {
              return `<div style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text3);margin:10px 0 4px">${g.label}</div>` +
                g.pairs.map(([lbl, fn]) => {
                  const arr = E.filter(fn).filter(d => d._m.pct !== null);
                  const a = arr.length ? avg(arr, d => d._m.pct) : null;
                  return `<div class="stat-row"><span class="stat-label">${lbl} (${arr.length})</span><span class="stat-val ${a !== null && a >= S.seuil_marge_forte_pct ? 'green' : ''}">${a !== null ? fmtPct(a) : '—'}</span></div>`;
                }).join('');
            }).join('');
          })()}
        </div>
      </div>
    </div>

    <!-- Verdicts -->
    <div class="insights-layout">
      <div class="insight-card">
        <div class="insight-card-hd">Marge par verdict</div>
        <div class="insight-card-bd">
          ${['Je fais','Je modifie','Je refuse','À étudier'].map(v => {
            const arr = E.filter(d => d.verdict === v && d._m.pct !== null);
            const a = arr.length ? avg(arr, d => d._m.pct) : null;
            return `<div class="stat-row"><span class="stat-label"><span class="vbadge ${verdictClass(v)}">${v}</span></span><span class="stat-val">${a !== null ? fmtPct(a) : '—'}</span></div>`;
          }).join('')}
        </div>
      </div>

      ${topTags.length ? `<div class="insight-card">
        <div class="insight-card-hd">Tags fréquents</div>
        <div class="insight-card-bd">
          ${topTags.map(([t, c]) => `<div class="stat-row"><span class="stat-label"><span class="tag ${TAG_CLASS[t]||''}">${t}</span></span><span class="stat-val">${c}</span></div>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <!-- Patterns -->
    <div class="insight-card" style="margin-bottom:0">
      <div class="insight-card-hd">3 patterns détectés — logique visible</div>
      <div class="insight-card-bd">
        ${patterns.length
          ? patterns.map(p => `<div class="pattern-card"><div style="display:flex;align-items:flex-start;gap:0"><span class="pattern-dot" style="margin-top:5px;flex-shrink:0"></span><span class="pattern-text">${p.label}</span></div><div class="pattern-logic">${p.logic}</div></div>`).join('')
          : `<div class="pattern-card"><span class="pattern-text" style="color:var(--text3)">Pas encore assez de données. Minimum 4 dossiers.</span></div>`}
      </div>
    </div>
  `;
}

function detectPatterns(E) {
  if (E.length < 4) return [];
  const avg = (arr, fn) => arr.length ? arr.reduce((s, d) => s + fn(d), 0) / arr.length : null;
  const patterns = [];

  const g1 = E.filter(d => d.type_operation === 'Découpe' && !d.copro && d.tva_type === 'Marge' && d._m.pct !== null);
  const rest1 = E.filter(d => !(d.type_operation === 'Découpe' && !d.copro && d.tva_type === 'Marge') && d._m.pct !== null);
  if (g1.length >= 2 && rest1.length >= 2) {
    const a1 = avg(g1, d => d._m.pct), a2 = avg(rest1, d => d._m.pct);
    if (a1 > a2) patterns.push({ label: `Découpe + sans copro + TVA marge → marge moy. ${fmtPct(a1)} (vs ${fmtPct(a2)})`, logic: `Observé sur ${g1.length} dossier(s). Filtres : type=Découpe AND copro=Non AND TVA=Marge.` });
  }

  const hi = E.filter(d => d._r.score >= 50 && d._m.pct !== null), lo = E.filter(d => d._r.score < 50 && d._m.pct !== null);
  if (hi.length >= 2 && lo.length >= 2) {
    const ah = avg(hi, d => d._m.pct), al = avg(lo, d => d._m.pct);
    patterns.push({ label: `Risque ≥ 50 → marge moy. ${fmtPct(ah)} (vs ${fmtPct(al)} pour risque < 50)`, logic: `${hi.length} dossiers à risque élevé vs ${lo.length} à risque modéré/bas.` });
  }

  const fast = E.filter(d => d._dur !== null && d._dur < S.seuil_rapide_jours && d._m.pct !== null);
  const slow = E.filter(d => d._dur !== null && d._dur >= S.seuil_rapide_jours && d._m.pct !== null);
  if (fast.length >= 2 && slow.length >= 2) {
    const af = avg(fast, d => d._m.pct), as_ = avg(slow, d => d._m.pct);
    patterns.push({ label: `Opérations < ${S.seuil_rapide_jours}j → marge moy. ${fmtPct(af)} (vs ${fmtPct(as_)})`, logic: `${fast.length} rapides vs ${slow.length} lentes. Durée = date achat → date revente.` });
  }
  return patterns;
}

// ── Settings ──────────────────────────────────
function renderSettings() {
  const items = [
    { k: 'taux_frais_notaire_defaut', label: 'Taux frais notaire', sub: 'Ex : 0.075 pour 7,5 %' },
    { k: 'seuil_rapide_jours', label: 'Seuil "Rapide" (jours)', sub: 'En dessous = tag Rapide' },
    { k: 'seuil_marge_forte_pct', label: 'Seuil "Marge forte"', sub: 'Ex : 0.20 pour 20 %' },
    { k: 'is_defaut_pct', label: 'IS par défaut', sub: 'Ex : 0.25 pour 25 %' },
    { k: 'seuil_risque_haut', label: 'Seuil risque haut', sub: 'Score ≥ → tag Risque haut' }
  ];
  document.getElementById('settings-items').innerHTML = items.map(i => `
    <div class="setting-item">
      <div><div class="setting-label">${i.label}</div><div class="setting-sub">${i.sub}</div></div>
      <input class="setting-input" type="number" step="any" id="s-${i.k}" value="${S[i.k]}">
    </div>
  `).join('');
  items.forEach(i => {
    document.getElementById(`s-${i.k}`).addEventListener('change', async e => {
      await saveSetting(i.k, parseFloat(e.target.value));
      showToast('Paramètre sauvegardé');
    });
  });
}

// ── Export / Import ───────────────────────────
async function renderExport() {
  const all = await dbAll('dossiers');
  document.getElementById('export-count').textContent = all.length;
}

async function exportJSON() {
  const all = await dbAll('dossiers');
  const blob = new Blob([JSON.stringify({ version: 1, exported_at: new Date().toISOString(), dossiers: all }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `mdb-export-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); URL.revokeObjectURL(a.href);
  showToast('Export téléchargé');
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    const arr = Array.isArray(data.dossiers) ? data.dossiers : Array.isArray(data) ? data : null;
    if (!arr) { showToast('Format non reconnu'); return; }
    let n = 0;
    for (const d of arr) { if (d.dossier_id) { await dbPut('dossiers', d); n++; } }
    showToast(`${n} dossier(s) importés`); renderExport();
  } catch { showToast('Fichier JSON invalide'); }
}

// ── INIT ──────────────────────────────────────
async function init() {
  await initDB(); await loadSettings();

  // Nav
  document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));

  // Accordions
  document.querySelectorAll('.accordion-header').forEach(h => h.addEventListener('click', () => h.closest('.accordion').classList.toggle('open')));

  // Form live
  document.querySelectorAll('#form-dossier input, #form-dossier select, #form-dossier textarea').forEach(el => el.addEventListener('input', updateComputed));
  document.getElementById('note_confiance').addEventListener('input', updateSlider);

  // Buttons
  document.getElementById('btn-enregistrer').addEventListener('click', () => saveDossier(false));
  document.getElementById('btn-dupliquer').addEventListener('click', () => saveDossier(true));
  document.getElementById('btn-supprimer').addEventListener('click', deleteDossier);
  document.getElementById('btn-nouveau').addEventListener('click', () => { clearForm(); navigate('nouveau'); });

  // Filters
  ['filter-type', 'filter-verdict', 'filter-tag'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', e => { filters[id.replace('filter-', '')] = e.target.value; renderFiltered(); });
  });
  document.getElementById('filter-search')?.addEventListener('input', e => { filters.search = e.target.value; renderFiltered(); });
  document.getElementById('filter-marge-min')?.addEventListener('input', e => { filters.margeMin = e.target.value; renderFiltered(); });
  document.getElementById('filter-marge-max')?.addEventListener('input', e => { filters.margeMax = e.target.value; renderFiltered(); });

  // Export
  document.getElementById('btn-export')?.addEventListener('click', exportJSON);
  document.getElementById('btn-import-trigger')?.addEventListener('click', () => document.getElementById('file-import').click());
  document.getElementById('file-import')?.addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); });

  // Modal backdrop
  document.getElementById('detail-modal').addEventListener('click', e => { if (e.target === document.getElementById('detail-modal')) document.getElementById('detail-modal').classList.remove('visible'); });

  // Set defaults
  document.getElementById('frais_notaire_taux').value = S.taux_frais_notaire_defaut;
  document.getElementById('is_estime_pct').value = S.is_defaut_pct;

  navigate('dossiers');
  updateSlider();
  updateComputed();
}

document.addEventListener('DOMContentLoaded', init);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(console.error);
