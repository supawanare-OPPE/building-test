const state = {
  all: [], filtered: [], options: {}, stats: {}, canEdit: false, editEnabled: false,
  editPin: '', page: 1, pageSize: 15, current: null, lastSync: null, autoRefreshSeconds: 120
};

const cfg = window.APP_CONFIG || {};

document.addEventListener('DOMContentLoaded', () => {
  state.autoRefreshSeconds = Number(cfg.AUTO_REFRESH_SECONDS || 120);
  refreshData(true);
});

function apiUrl(params = {}) {
  const base = String(cfg.API_URL || '').trim();
  if (!base || !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/i.test(base)) {
    throw new Error('ยังไม่ได้ตั้งค่า API_URL ในไฟล์ config.js');
  }
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

// Apps Script ContentService does not provide a normal CORS API surface for every browser case.
// Read requests therefore use JSONP, which Apps Script officially supports for browser calls.
function apiGet(action) {
  return new Promise((resolve, reject) => {
    let script;
    let timer;
    const callbackName = '__muBuilding_' + Date.now() + '_' + Math.random().toString(36).slice(2).replace(/[^a-z0-9_]/gi, '');
    const cleanup = () => {
      clearTimeout(timer);
      if (script && script.parentNode) script.parentNode.removeChild(script);
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
    };
    window[callbackName] = payload => {
      cleanup();
      if (payload && payload.ok === false) reject(new Error(payload.error || 'เกิดข้อผิดพลาดจาก API'));
      else resolve(payload);
    };
    try {
      script = document.createElement('script');
      script.async = true;
      script.src = apiUrl({ action, callback: callbackName, t: Date.now() });
      script.onerror = () => { cleanup(); reject(new Error('โหลดข้อมูลจาก Apps Script ไม่สำเร็จ')); };
      timer = setTimeout(() => { cleanup(); reject(new Error('การเชื่อมต่อ Apps Script ใช้เวลานานเกินไป')); }, 20000);
      document.head.appendChild(script);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

// Write requests submit a normal HTML form to a hidden iframe. The Apps Script response
// posts the result back to this page with window.postMessage, avoiding fetch/CORS issues.
function apiPost(action, fields = {}) {
  return new Promise((resolve, reject) => {
    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const frameName = 'gasPostFrame_' + requestId.replace(/[^a-zA-Z0-9_]/g, '_');
    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      setTimeout(() => iframe.remove(), 100);
    };

    const onMessage = event => {
      const allowedOrigin = event.origin === 'https://script.google.com' || /\.googleusercontent\.com$/i.test(new URL(event.origin).hostname || '');
      if (!allowedOrigin) return;
      const msg = event.data || {};
      if (msg.source !== 'mahidol-building-api' || msg.requestId !== requestId) return;
      cleanup();
      if (msg.ok === false) reject(new Error(msg.error || 'เกิดข้อผิดพลาดจาก API'));
      else resolve(msg);
    };
    window.addEventListener('message', onMessage);

    let actionUrl;
    try { actionUrl = apiUrl(); }
    catch (err) { cleanup(); reject(err); return; }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = actionUrl;
    form.target = frameName;
    form.style.display = 'none';
    const data = { action, requestId, parentOrigin: window.location.origin, ...fields };
    Object.entries(data).forEach(([key, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = String(value ?? '');
      form.appendChild(input);
    });
    document.body.appendChild(form);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ไม่ได้รับผลตอบกลับจาก Apps Script ภายในเวลาที่กำหนด'));
    }, 25000);

    form.submit();
    form.remove();
  });
}

async function refreshData(initial = false) {
  if (document.getElementById('modal').classList.contains('open') && !initial) return;
  setLoading(true);
  setStatus('กำลังเชื่อมต่อฐานข้อมูล...', 'offline');
  try {
    const res = await apiGet('bootstrap');
    hydrate(res.data || res);
    setStatus(`เชื่อมต่อแล้ว • อัปเดตล่าสุด ${new Date(state.lastSync).toLocaleString('th-TH')}`, 'online');
  } catch (err) {
    setStatus('เชื่อมต่อฐานข้อมูลไม่ได้', 'error');
    fail(err);
  } finally {
    setLoading(false);
  }
}

function hydrate(data) {
  state.all = Array.isArray(data.buildings) ? data.buildings : [];
  state.options = data.options || {};
  state.stats = data.stats || {};
  state.editEnabled = data.editEnabled === true;
  state.lastSync = data.lastSync || new Date().toISOString();
  state.autoRefreshSeconds = Number(data.autoRefreshSeconds || cfg.AUTO_REFRESH_SECONDS || 120);
  populateFilters();
  renderKpis();
  applyFilters();
  updateEditUi();
  scheduleAutoRefresh();
}

function updateEditUi() {
  document.getElementById('addBtn').style.display = state.canEdit ? '' : 'none';
  document.getElementById('lockBtn').style.display = state.canEdit ? '' : 'none';
  document.getElementById('unlockBtn').style.display = state.canEdit ? 'none' : '';
  const note = document.getElementById('readonlyNote');
  if (state.canEdit) {
    note.textContent = 'ปลดล็อกการแก้ไขแล้ว • การบันทึกจะเขียนกลับ Google Sheet โดยตรง';
    note.classList.add('show');
  } else if (!state.editEnabled) {
    note.textContent = 'โหมดดูข้อมูล • ฝั่ง Apps Script ยังไม่ได้ตั้งค่า EDIT_PIN จึงปิดการแก้ไขจากหน้าเว็บ';
    note.classList.add('show');
  } else {
    note.textContent = 'โหมดดูข้อมูล • หากต้องการเพิ่มหรือแก้ไข ให้กด “ปลดล็อกแก้ไข” และใส่ PIN ผู้ดูแลระบบ';
    note.classList.add('show');
  }
}

async function unlockEditing() {
  if (!state.editEnabled) {
    showToast('ยังไม่ได้ตั้งค่า EDIT_PIN ใน Apps Script', true);
    return;
  }
  const pin = window.prompt('กรอก PIN สำหรับแก้ไขฐานข้อมูล');
  if (pin === null) return;
  if (!pin.trim()) { showToast('กรุณากรอก PIN', true); return; }
  setLoading(true);
  try {
    const res = await apiPost('verifyEditPin', { editPin: pin });
    if (!res.authorized) throw new Error('PIN ไม่ถูกต้อง');
    state.editPin = pin;
    state.canEdit = true;
    updateEditUi();
    showToast('ปลดล็อกการแก้ไขแล้ว');
  } catch (err) {
    state.editPin = '';
    state.canEdit = false;
    updateEditUi();
    fail(err);
  } finally {
    setLoading(false);
  }
}

function lockEditing() {
  state.editPin = '';
  state.canEdit = false;
  updateEditUi();
  showToast('ล็อกการแก้ไขแล้ว');
}

let refreshTimer;
function scheduleAutoRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshData(false), Math.max(30, state.autoRefreshSeconds) * 1000);
}

function renderKpis() {
  const s = state.stats;
  text('kpiBuildings', fmt(s.totalBuildings, 0));
  text('kpiArea', fmt(s.totalArea, 0));
  text('kpiInspect', fmt(s.inspectionCount, 0));
  text('kpiBudget', moneyShort(s.totalBudget));
}

function populateFilters() {
  setSelect('ownerFilter', state.options.owners || [], 'ทุกส่วนงาน');
  setSelect('masterFilter', state.options.masterplanTypes || [], 'ทุกประเภทตามผังแม่บท');
  setSelect('legalFilter', state.options.legalTypes || [], 'ทุกประเภทตามกฎหมาย');
  setDatalist('ownerList', state.options.owners || []);
  setDatalist('masterList', state.options.masterplanTypes || []);
}

function setSelect(id, values, placeholder) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + values.map(v => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('');
  if (values.includes(current)) el.value = current;
}
function setDatalist(id, values) { document.getElementById(id).innerHTML = values.map(v => `<option value="${escapeAttr(v)}"></option>`).join(''); }

function applyFilters() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const owner = document.getElementById('ownerFilter').value;
  const master = document.getElementById('masterFilter').value;
  const legal = document.getElementById('legalFilter').value;
  const inspect = document.getElementById('inspectFilter').value;
  state.filtered = state.all.filter(b => {
    if (owner && b.owner !== owner) return false;
    if (master && b.masterplanType !== master) return false;
    if (legal && b.legalType !== legal) return false;
    if (inspect === 'yes' && b.inspectionRequired !== true) return false;
    if (inspect === 'no' && b.inspectionRequired === true) return false;
    if (q) {
      const hay = [b.name,b.code,b.owner,b.designer,b.contractor,b.masterplanType,b.legalType,b.renovation,b.renovationContractor].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  state.page = 1;
  renderTable();
  renderMasterChart();
  text('resultHint', `แสดง ${fmt(state.filtered.length,0)} จาก ${fmt(state.all.length,0)} รายการ`);
}

function resetFilters() {
  ['searchInput','ownerFilter','masterFilter','legalFilter','inspectFilter'].forEach(id => document.getElementById(id).value = '');
  applyFilters();
}

function renderTable() {
  const start = (state.page - 1) * state.pageSize;
  const rows = state.filtered.slice(start, start + state.pageSize);
  const body = document.getElementById('tableBody');
  body.innerHTML = rows.map(b => `
    <tr>
      <td class="name-cell">${escapeHtml(b.name || '—')}<div class="muted">${escapeHtml(b.code || '')}</div></td>
      <td>${escapeHtml(b.owner || '—')}</td>
      <td class="num">${b.floors === '' ? '—' : fmt(b.floors,0)}</td>
      <td class="num">${b.area === '' ? '—' : fmt(b.area,2)}</td>
      <td class="num">${b.openYear === '' ? '—' : fmt(b.openYear,0)}</td>
      <td>${escapeHtml(b.masterplanType || '—')}</td>
      <td>${escapeHtml(b.legalType || '—')}</td>
      <td>${b.inspectionRequired ? '<span class="badge badge-yes">ต้องตรวจสอบ</span>' : '<span class="badge badge-no">ไม่เข้าข่าย</span>'}</td>
      <td><button class="btn btn-white btn-sm" onclick="openView(${Number(b.__row)})">ดูรายละเอียด</button></td>
    </tr>`).join('');
  document.getElementById('emptyState').style.display = rows.length ? 'none' : 'block';
  text('tableCount', `(${fmt(state.filtered.length,0)} รายการ)`);
  renderPager();
}

function renderPager() {
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  let html = `<button onclick="goPage(${state.page-1})" ${state.page<=1?'disabled':''}>‹</button>`;
  const pages = pageWindow(state.page, totalPages);
  pages.forEach(p => { html += p === '…' ? '<span class="muted">…</span>' : `<button class="${p===state.page?'active':''}" onclick="goPage(${p})">${p}</button>`; });
  html += `<button onclick="goPage(${state.page+1})" ${state.page>=totalPages?'disabled':''}>›</button>`;
  document.getElementById('pager').innerHTML = html;
}
function pageWindow(cur,total) { if(total<=7) return Array.from({length:total},(_,i)=>i+1); const out=[1]; if(cur>4) out.push('…'); for(let p=Math.max(2,cur-1); p<=Math.min(total-1,cur+1); p++) out.push(p); if(cur<total-3) out.push('…'); out.push(total); return out; }
function goPage(p) { const total=Math.max(1,Math.ceil(state.filtered.length/state.pageSize)); state.page=Math.max(1,Math.min(total,p)); renderTable(); document.querySelector('.table-card').scrollIntoView({behavior:'smooth',block:'start'}); }

function renderMasterChart() {
  const counts = {};
  state.filtered.forEach(b => { const k=(b.masterplanType||'ไม่ระบุ').trim() || 'ไม่ระบุ'; counts[k]=(counts[k]||0)+1; });
  const items = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const max = Math.max(1, ...items.map(x=>x[1]));
  document.getElementById('masterChart').innerHTML = items.slice(0,9).map(([label,val]) => `
    <div class="bar-row" title="${escapeAttr(label)}">
      <div class="bar-label">${escapeHtml(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(val/max*100)}%"></div></div>
      <div class="bar-num">${val}</div>
    </div>`).join('') || '<div class="muted">ไม่มีข้อมูล</div>';
  text('categoryTotal', `${fmt(items.length,0)} ประเภท`);
}

function openView(row) {
  const b = state.all.find(x => Number(x.__row) === Number(row));
  if (!b) return;
  state.current = b;
  fillForm(b);
  document.getElementById('modalTitle').textContent = b.name || 'รายละเอียดอาคาร';
  setFormDisabled(!state.canEdit);
  document.getElementById('saveBtn').style.display = state.canEdit ? '' : 'none';
  document.getElementById('modal').classList.add('open');
}

function openAdd() {
  if (!state.canEdit) { showToast('กรุณาปลดล็อกการแก้ไขก่อน', true); return; }
  state.current = null;
  fillForm({});
  document.getElementById('modalTitle').textContent = 'เพิ่มข้อมูลอาคาร';
  setFormDisabled(false);
  document.getElementById('saveBtn').style.display = '';
  document.getElementById('modal').classList.add('open');
  setTimeout(()=>document.getElementById('fName').focus(),60);
}

function fillForm(b) {
  setVal('fRow', b.__row || ''); setVal('fName', b.name || ''); setVal('fCode', b.code || ''); setVal('fOwner', b.owner || '');
  setVal('fFloors', b.floors ?? ''); setVal('fHeight', b.height ?? ''); setVal('fArea', b.area ?? ''); setVal('fYear', b.openYear ?? '');
  setVal('fDesigner', b.designer || ''); setVal('fContractor', b.contractor || ''); setVal('fBudget', b.budget ?? '');
  setVal('fMaster', b.masterplanType || ''); setVal('fLegal', b.legalType || ''); document.getElementById('fInspect').checked = b.inspectionRequired === true;
  setVal('fRenovation', b.renovation || ''); setVal('fRenovationContractor', b.renovationContractor || '');
}

function collectForm() {
  return {
    __row: val('fRow'), name: val('fName'), code: val('fCode'), owner: val('fOwner'), floors: val('fFloors'), height: val('fHeight'), area: val('fArea'), openYear: val('fYear'),
    designer: val('fDesigner'), contractor: val('fContractor'), budget: val('fBudget'), masterplanType: val('fMaster'), legalType: val('fLegal'), inspectionRequired: document.getElementById('fInspect').checked,
    renovation: val('fRenovation'), renovationContractor: val('fRenovationContractor')
  };
}

async function saveCurrent() {
  if (!state.canEdit || !state.editPin) { showToast('กรุณาปลดล็อกการแก้ไขก่อน', true); return; }
  const form = document.getElementById('buildingForm');
  if (!form.reportValidity()) return;
  const payload = collectForm();
  setLoading(true);
  try {
    const res = await apiPost('saveBuilding', { editPin: state.editPin, payload: JSON.stringify(payload) });
    hydrate(res.data);
    closeModal();
    showToast(res.message || 'บันทึกข้อมูลแล้ว');
  } catch (err) {
    fail(err);
  } finally {
    setLoading(false);
  }
}

function setFormDisabled(disabled) { document.querySelectorAll('#buildingForm input:not([type=hidden]), #buildingForm textarea').forEach(el => el.disabled = disabled); }
function closeModal() { document.getElementById('modal').classList.remove('open'); state.current=null; scheduleAutoRefresh(); }
function backdropClose(e) { if (e.target.id === 'modal') closeModal(); }

function exportCsv() {
  const headers = ['ลำดับ','ส่วนงานเจ้าของอาคาร/ผู้ดูแล','รหัสอาคาร','ชื่ออาคาร','ผู้ออกแบบ','ผู้รับเหมาก่อสร้าง','งบประมาณค่าก่อสร้าง','ปีที่เปิดใช้งาน (พ.ศ.)','จำนวนชั้น','ความสูง (ม.)','พื้นที่อาคาร (ตรม.)','ประเภทตามผังแม่บท','ประเภทตามกฎหมาย','เข้าข่ายอาคารที่ต้องตรวจสอบ','การปรับปรุงอาคาร','ผู้รับเหมางานปรับปรุง'];
  const rows = state.filtered.map(b => [b.seq,b.owner,b.code,b.name,b.designer,b.contractor,b.budget,b.openYear,b.floors,b.height,b.area,b.masterplanType,b.legalType,b.inspectionRequired?'ใช่':'ไม่ใช่',b.renovation,b.renovationContractor]);
  const csv = '\ufeff' + [headers,...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='mahidol-salaya-buildings.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function csvCell(v) { const s=String(v ?? ''); return '"'+s.replace(/"/g,'""')+'"'; }

function setStatus(message, mode) {
  text('syncText', message);
  const dot = document.getElementById('statusDot');
  dot.classList.remove('offline','error');
  if (mode === 'offline') dot.classList.add('offline');
  if (mode === 'error') dot.classList.add('error');
}
function setLoading(on) { document.getElementById('loading').classList.toggle('show', !!on); }
function fail(err) { showToast((err && err.message) ? err.message : String(err || 'เกิดข้อผิดพลาด'), true); }
function showToast(msg, error=false) { const el=document.getElementById('toast'); el.textContent=msg; el.className='toast show'+(error?' error':''); clearTimeout(showToast.t); showToast.t=setTimeout(()=>el.classList.remove('show'),4200); }
function moneyShort(n) { n=Number(n||0); if(n>=1e9) return `${(n/1e9).toLocaleString('th-TH',{maximumFractionDigits:2})} พันล้าน`; if(n>=1e6) return `${(n/1e6).toLocaleString('th-TH',{maximumFractionDigits:1})} ล้าน`; return fmt(n,0); }
function fmt(n,d=0) { const x=Number(n); return Number.isFinite(x) ? x.toLocaleString('th-TH',{minimumFractionDigits:0,maximumFractionDigits:d}) : '—'; }
function text(id,s) { document.getElementById(id).textContent=s; }
function val(id) { return document.getElementById(id).value; }
function setVal(id,v) { document.getElementById(id).value = (v === null || v === undefined) ? '' : v; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(s) { return escapeHtml(s).replace(/`/g,'&#96;'); }
