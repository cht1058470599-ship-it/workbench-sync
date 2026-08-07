// 主入口：导航、模块逻辑、加载 AI 注入数据
import { loadData, saveData, uid, todayStr } from './storage.js';
import { initTheme } from './theme.js';
import { initSync, subscribe, getStatus, pullNow, localSet } from './sync.js';
import config from './config.js';

let currentAssets = null; // 资产编辑态（内存）

/* 初始化在文件末尾执行（见 bootstrap()）。
   原因：planState / TYPE_META / PLAN_STORE 是 let/const，存在暂时性死区，
   若在此处调用 initPlan() 会抛 "Cannot access 'planState' before initialization"，
   并连带导致 renderFinance() 不执行、资金页空白。 */

/* ---------- 导航切换 ---------- */
function initNav() {
  const titles = {
    plan: '计划与安排', finance: '资金', notes: '备忘录', ideas: '灵感',
    learning: '学习', habits: '习惯与健康', automations: '自动化一览', settings: '开发者配置',
  };
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const t = item.dataset.target;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-' + t).classList.add('active');
      document.getElementById('viewTitle').textContent = titles[t];
    });
  });
}

/* ---------- 子标签（计划模块） ---------- */
function initSubtabs() {
  document.querySelectorAll('.subtabs').forEach(group => {
    group.querySelectorAll('.subtab').forEach(tab => {
      tab.addEventListener('click', () => {
        group.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const g = group.dataset.group;
        document.querySelectorAll(`.subpane`).forEach(p => p.classList.remove('active'));
        document.getElementById('sub-' + tab.dataset.sub).classList.add('active');
      });
    });
  });
}

/* ---------- 加载 AI 注入数据 ---------- */
async function loadAiData() {
  let data = null;
  // 1) 优先从腾讯云后端读取资产（统一数据源，任何设备改都改云端，手机电脑一致）
  try {
    const ep = (config.sync && config.sync.nasEndpoint) || '';
    const tk = (config.sync && config.sync.token) || '';
    if (ep) {
      const res = await fetch(ep.replace(/\/$/, '') + '/data.json', {
        headers: tk ? { 'x-sync-token': tk } : {}, cache: 'no-store'
      });
      if (res.ok) {
        const doc = await res.json();
        if (doc && doc.keys && doc.keys.ai_data) data = doc.keys.ai_data;
      }
    }
  } catch (e) { console.warn('[工作台] 后端资产拉取失败，回退内联数据：', e); }
  // 2) 兜底：构建时内联种子
  if (!data && window.__AI_DATA_SEED && window.__AI_DATA_SEED.assets) data = window.__AI_DATA_SEED;
  // 3) 兜底：本地文件
  if (!data) {
    try {
      const res = await fetch('data/ai-injected.json');
      const text = await res.text();
      if (text && text.trim()) data = JSON.parse(text);
    } catch (e) { /* ignore */ }
  }
  window.__aiData = data || { todayTodos: [], assets: null };
  initAssetsEditor();
  const txt = data && data.lastRefresh ? `最近刷新：${data.lastRefresh}` : '最近刷新：—';
  const el = document.getElementById('lastRefresh');
  if (el) el.textContent = txt;
  // 两个渲染互相隔离：任一出错都不能连累另一个
  safe('renderPlanHeader', renderPlanHeader);
  safe('renderFinance', renderFinance);
}

function initAssetsEditor() {
  const a = window.__aiData && window.__aiData.assets;
  currentAssets = a ? structuredClone(a) : null;
}

/* 统一的错误隔离包装：某个模块炸了不影响其他模块，并在控制台留下明确线索 */
function safe(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[工作台] ${name} 执行失败：`, err);
    return err;
  }
  return null;
}

/* ---------- 计划模块：四周日程窗 ---------- */
const TYPE_META = {
  block: { label: '执行块', color: '#3b82f6', bg: 'rgba(59,130,246,.15)' },
  fixed: { label: '固定行程', color: '#2ecc71', bg: 'rgba(46,204,113,.15)' },
  deadline: { label: '截止日', color: '#e74c3c', bg: 'rgba(231,76,60,.15)' },
  node: { label: '项目节点', color: '#9b59b6', bg: 'rgba(155,89,182,.15)' },
};

const PLAN_STORE = {
  events: 'plan_events', tracks: 'plan_tracks', selectedDate: 'plan_selectedDate',
  viewStart: 'plan_viewStart', unscheduled: 'plan_unscheduled'
};

let planState = { events: [], tracks: [], unscheduled: [], selectedDate: '', viewStart: '', activeTrack: null };

function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseLocalDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(str, days) {
  const d = parseLocalDate(str); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getMonday(str) {
  const d = parseLocalDate(str); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d.getFullYear(), d.getMonth(), diff);
  return `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
}
function fmtMd(d) { return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtDateFull(str) {
  const d = parseLocalDate(str);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${week}`;
}
function getDefaultTracks() {
  return [
    { id: uid(), name: 'Content', color: '#3b82f6' },
    { id: uid(), name: 'Deals', color: '#2ecc71' },
    { id: uid(), name: 'Film', color: '#f39c12' },
    { id: uid(), name: 'Renovation', color: '#9b59b6' },
    { id: uid(), name: 'Fitness', color: '#e74c3c' },
    { id: uid(), name: 'Relationship', color: '#1abc9c' },
  ];
}
function getDefaultUnscheduled() {
  return [
    { id: uid(), title: '整理本周三个选题证据' },
    { id: uid(), title: '完成全身力量训练' },
    { id: uid(), title: '发布工作流复盘视频' },
  ];
}
function getDefaultEvents(tracks) {
  const start = getMonday(localTodayStr());
  const tIds = tracks || getDefaultTracks();
  const find = name => (tIds.find(t => t.name === name) || tIds[0] || {}).id;
  return [
    { id: uid(), title: '品牌 B 脚本审核', date: addDays(start, 2), time: '10:00', type: 'block', track: find('Content'), done: false },
    { id: uid(), title: '短视频角色测试', date: addDays(start, 2), time: '15:00', type: 'node', track: find('Film'), done: false },
    { id: uid(), title: '装修图纸确认', date: addDays(start, 3), time: '14:00', type: 'deadline', track: find('Renovation'), done: false },
    { id: uid(), title: '全身力量训练', date: addDays(start, 4), time: '19:00', type: 'fixed', track: find('Fitness'), done: false },
    { id: uid(), title: '城市 A 合作会议', date: addDays(start, 4), time: '09:00', type: 'fixed', track: find('Deals'), done: false },
    { id: uid(), title: '灯光与布景方案', date: addDays(start, 5), time: '20:00', type: 'node', track: find('Film'), done: false },
    { id: uid(), title: '核对柜体尺寸', date: addDays(start, 6), time: '13:30', type: 'deadline', track: find('Renovation'), done: false },
    { id: uid(), title: '材料样板选定', date: addDays(start, 10), time: '10:00', type: 'block', track: find('Renovation'), done: false },
    { id: uid(), title: '影片粗剪审片', date: addDays(start, 17), time: '15:00', type: 'node', track: find('Film'), done: false },
    { id: uid(), title: '木作复尺', date: addDays(start, 20), time: '14:00', type: 'block', track: find('Renovation'), done: false },
  ];
}

function initPlan() {
  planState.tracks = loadData(PLAN_STORE.tracks, null);
  if (!planState.tracks || !planState.tracks.length) {
    planState.tracks = getDefaultTracks();
    saveData(PLAN_STORE.tracks, planState.tracks);
  }
  planState.unscheduled = loadData(PLAN_STORE.unscheduled, getDefaultUnscheduled());

  planState.events = loadData(PLAN_STORE.events, null);
  if (!planState.events) {
    planState.events = getDefaultEvents(planState.tracks);
    saveData(PLAN_STORE.events, planState.events);
  } else {
    // 修复历史坏数据：事件挂了不存在的轨道 id 会导致筛选后日历全空
    const validIds = new Set(planState.tracks.map(t => t.id));
    const refMap = {};
    getDefaultEvents(planState.tracks).forEach(r => { refMap[r.title] = r.track; });
    let fixed = false;
    planState.events.forEach(e => {
      if (e.track && !validIds.has(e.track)) {
        e.track = refMap[e.title] || null;  // 按标题映射回正确轨道，映射不到则置空
        fixed = true;
      }
    });
    if (fixed) saveData(PLAN_STORE.events, planState.events);
  }

  planState.selectedDate = loadData(PLAN_STORE.selectedDate, localTodayStr());
  planState.viewStart = loadData(PLAN_STORE.viewStart, null);
  if (!planState.viewStart) { planState.viewStart = getMonday(localTodayStr()); saveData(PLAN_STORE.viewStart, planState.viewStart); }

  document.getElementById('planPrev').addEventListener('click', () => shiftWeeks(-28));
  document.getElementById('planNext').addEventListener('click', () => shiftWeeks(28));
  document.getElementById('planToday').addEventListener('click', () => {
    planState.viewStart = getMonday(localTodayStr());
    planState.selectedDate = localTodayStr();
    saveData(PLAN_STORE.viewStart, planState.viewStart);
    saveData(PLAN_STORE.selectedDate, planState.selectedDate);
    renderPlan();
  });
  document.getElementById('dayAdd').addEventListener('click', addDayEvent);
  document.getElementById('dayContentInput').addEventListener('keydown', e => { if (e.key === 'Enter') addDayEvent(); });
  // 清除时间：设为全天事件
  document.getElementById('dayTimeClear').addEventListener('click', () => {
    document.getElementById('dayTimeInput').value = '';
    toast('已设为全天');
  });
  document.getElementById('trackAdd').addEventListener('click', addTrack);
  document.getElementById('trackInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTrack(); });
  document.getElementById('unschedAdd').addEventListener('click', addUnscheduled);
  document.getElementById('unschedInput').addEventListener('keydown', e => { if (e.key === 'Enter') addUnscheduled(); });

  renderPlan();
}

function shiftWeeks(days) {
  planState.viewStart = addDays(planState.viewStart, days);
  saveData(PLAN_STORE.viewStart, planState.viewStart);
  renderPlan();
}

function renderPlan() {
  renderPlanHeader();
  renderTracks();
  renderCalendar();
  renderDayDetail();
  renderUnscheduled();
}

function renderPlanHeader() {
  document.getElementById('planNodeCount').textContent = planState.events.length;
  document.getElementById('planTaskCount').textContent = planState.unscheduled.length + planState.events.filter(e => !e.done).length;
  const start = parseLocalDate(planState.viewStart);
  const end = new Date(start.getTime() + 27 * 86400000);
  document.getElementById('planRange').textContent = `${fmtMd(start)} — ${fmtMd(end)}`;
}

function renderTracks() {
  const list = document.getElementById('trackList');
  list.innerHTML = '';
  planState.tracks.forEach(t => {
    const li = document.createElement('li');
    li.className = planState.activeTrack === t.id ? 'active' : '';
    li.innerHTML = `<span class="track-dot" style="background:${esc(t.color)}"></span><span class="track-name">${esc(t.name)}</span><button class="del" data-id="${t.id}">×</button>`;
    li.querySelector('.track-name').addEventListener('click', () => {
      planState.activeTrack = planState.activeTrack === t.id ? null : t.id;
      renderPlan();
      toast(planState.activeTrack ? `只看轨道：${t.name}（再点一次取消）` : '已显示全部轨道');
    });
    li.querySelector('.del').addEventListener('click', () => {
      planState.tracks = planState.tracks.filter(x => x.id !== t.id);
      planState.events = planState.events.filter(x => x.track !== t.id);
      if (planState.activeTrack === t.id) planState.activeTrack = null;
      saveData(PLAN_STORE.tracks, planState.tracks);
      saveData(PLAN_STORE.events, planState.events);
      renderPlan();
    });
    list.appendChild(li);
  });
}

function getEventsForDate(dateStr) {
  return planState.events.filter(e => {
    if (e.date !== dateStr) return false;
    if (planState.activeTrack && e.track !== planState.activeTrack) return false;
    return true;
  });
}

function renderCalendar() {
  const grid = document.getElementById('planCalendar');
  grid.innerHTML = '';
  const today = localTodayStr();
  const currentMonth = parseLocalDate(today).getMonth();

  for (let i = 0; i < 28; i++) {
    const dateStr = addDays(planState.viewStart, i);
    const d = parseLocalDate(dateStr);
    const cell = document.createElement('div');
    cell.className = 'plan-cell';
    if (dateStr === planState.selectedDate) cell.classList.add('selected');
    if (dateStr === today) cell.classList.add('today');
    if (d.getMonth() !== currentMonth) cell.classList.add('other-month');

    cell.innerHTML = `<div class="plan-cell-num">${d.getDate()}</div>`;
    const events = getEventsForDate(dateStr);
    const wrap = document.createElement('div');
    wrap.className = 'plan-cell-events';
    events.slice(0, 3).forEach(e => {
      const row = document.createElement('div');
      row.className = 'plan-cell-event' + (e.done ? ' done' : '');
      row.draggable = true;
      row.title = `${e.time || '全天'} ${e.title}（拖动可改期）`;
      row.innerHTML = `<span class="dot" style="background:${esc(TYPE_META[e.type].color)}"></span><span class="event-title">${esc(e.title)}</span>`;
      row.addEventListener('dragstart', ev => {
        ev.stopPropagation();
        ev.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'event', id: e.id }));
        ev.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('click', ev => {
        ev.stopPropagation();
        selectDate(dateStr);
        highlightEvent(e.id);
      });
      wrap.appendChild(row);
    });
    if (events.length > 3) {
      const more = document.createElement('div');
      more.className = 'plan-cell-more';
      more.textContent = `+${events.length - 3} 更多`;
      wrap.appendChild(more);
    }
    cell.appendChild(wrap);

    cell.addEventListener('click', () => selectDate(dateStr));
    cell.addEventListener('dblclick', () => {
      selectDate(dateStr);
      const inp = document.getElementById('dayContentInput');
      inp.focus();
      inp.classList.add('flash-focus');
      setTimeout(() => inp.classList.remove('flash-focus'), 800);
    });

    // 拖拽接收：事件改期 / 待安排项落到某天
    cell.addEventListener('dragover', ev => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', ev => {
      ev.preventDefault();
      cell.classList.remove('drag-over');
      let payload;
      try { payload = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
      if (!payload) return;

      if (payload.kind === 'event') {
        const target = planState.events.find(x => x.id === payload.id);
        if (target && target.date !== dateStr) {
          target.date = dateStr;
          saveData(PLAN_STORE.events, planState.events);
          selectDate(dateStr);
          toast(`「${target.title}」已移到 ${dateStr}`);
        }
      } else if (payload.kind === 'unscheduled') {
        const u = planState.unscheduled.find(x => x.id === payload.id);
        if (u) {
          planState.events.push({ id: uid(), title: u.title, date: dateStr, time: '', type: 'block', track: planState.activeTrack, done: false });
          planState.unscheduled = planState.unscheduled.filter(x => x.id !== u.id);
          saveData(PLAN_STORE.events, planState.events);
          saveData(PLAN_STORE.unscheduled, planState.unscheduled);
          selectDate(dateStr);
          toast(`「${u.title}」已安排到 ${dateStr}`);
        }
      }
    });

    grid.appendChild(cell);
  }
}

function selectDate(dateStr) {
  planState.selectedDate = dateStr;
  saveData(PLAN_STORE.selectedDate, dateStr);
  renderPlan();
}

function highlightEvent(id) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.plan-timeline-item[data-id="${id}"]`);
    if (!el) return;
    el.classList.add('highlight');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => el.classList.remove('highlight'), 1400);
  });
}

/* 轻量提示 */
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('planToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'planToast';
    el.className = 'plan-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

function renderDayDetail() {
  document.getElementById('selectedDate').textContent = fmtDateFull(planState.selectedDate);
  const timeline = document.getElementById('dayTimeline');
  timeline.innerHTML = '';
  const events = getEventsForDate(planState.selectedDate).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (!events.length) {
    timeline.innerHTML = '<p class="empty-tip">当天暂无安排。双击日历格子，或用上方输入框添加。</p>';
  } else {
    events.forEach(e => {
      const item = document.createElement('div');
      item.className = 'plan-timeline-item' + (e.done ? ' done' : '');
      item.dataset.id = e.id;
      item.draggable = true;
      item.style.borderLeftColor = TYPE_META[e.type].color;
      const track = planState.tracks.find(t => t.id === e.track);
      item.innerHTML = `
        <span class="tl-check${e.done ? ' checked' : ''}" title="标记完成">${e.done ? '✓' : ''}</span>
        <div class="plan-tl-time" title="点击改时间">${esc(e.time || '全天')}</div>
        <div class="plan-tl-main">
          <div class="plan-tl-title" title="点击编辑">${esc(e.title)}</div>
          <div class="plan-tl-meta">
            <span class="type-tag" style="background:${TYPE_META[e.type].bg};color:${TYPE_META[e.type].color}">${TYPE_META[e.type].label}</span>
            ${track ? `<span class="track-tag" style="background:${track.color}22;color:${track.color}">${esc(track.name)}</span>` : ''}
          </div>
        </div>
        <button class="del" title="删除">×</button>`;

      item.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'event', id: e.id }));
        ev.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));

      item.querySelector('.tl-check').addEventListener('click', () => {
        e.done = !e.done;
        saveData(PLAN_STORE.events, planState.events);
        renderPlan();
        toast(e.done ? `已完成：${e.title}` : `已取消完成：${e.title}`);
      });

      item.querySelector('.del').addEventListener('click', () => {
        deleteEvent(e.id);
        toast(`已删除：${e.title}`);
      });

      // 点击标题内联编辑
      item.querySelector('.plan-tl-title').addEventListener('click', () => {
        inlineEdit(item.querySelector('.plan-tl-title'), e.title, val => {
          if (val && val !== e.title) {
            e.title = val;
            saveData(PLAN_STORE.events, planState.events);
            toast('已更新标题');
          }
          renderPlan();
        });
      });

      // 点击时间改时间
      item.querySelector('.plan-tl-time').addEventListener('click', () => {
        const holder = item.querySelector('.plan-tl-time');
        const inp = document.createElement('input');
        inp.type = 'time';
        inp.value = e.time || '';
        inp.className = 'inline-time';
        holder.replaceWith(inp);
        inp.focus();
        const commit = () => {
          e.time = inp.value;
          saveData(PLAN_STORE.events, planState.events);
          renderPlan();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); });
      });

      timeline.appendChild(item);
    });
  }
}

/* 内联编辑：把元素换成输入框，回车/失焦提交，Esc 取消 */
function inlineEdit(el, initial, onCommit) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = initial;
  inp.className = 'inline-edit';
  el.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; onCommit(inp.value.trim()); };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') inp.blur();
    else if (ev.key === 'Escape') { done = true; onCommit(initial); }
  });
}

function addDayEvent() {
  const time = document.getElementById('dayTimeInput').value.trim();
  const title = document.getElementById('dayContentInput').value.trim();
  const type = document.getElementById('dayTypeInput').value;
  if (!title) return;
  planState.events.push({ id: uid(), title, date: planState.selectedDate, time, type, track: planState.activeTrack, done: false });
  saveData(PLAN_STORE.events, planState.events);
  document.getElementById('dayContentInput').value = '';
  renderPlan();
  toast(`已添加：${title}`);
}

function deleteEvent(id) {
  planState.events = planState.events.filter(x => x.id !== id);
  saveData(PLAN_STORE.events, planState.events);
  renderPlan();
}

function addTrack() {
  const inp = document.getElementById('trackInput');
  const v = inp.value.trim();
  if (!v) return;
  const colors = ['#3b82f6', '#2ecc71', '#f39c12', '#9b59b6', '#e74c3c', '#1abc9c', '#e91e63', '#00bcd4'];
  const color = colors[planState.tracks.length % colors.length];
  planState.tracks.push({ id: uid(), name: v, color });
  saveData(PLAN_STORE.tracks, planState.tracks);
  inp.value = '';
  renderPlan();
}

function renderUnscheduled() {
  const list = document.getElementById('unscheduledList');
  list.innerHTML = '';
  if (!planState.unscheduled.length) {
    list.innerHTML = '<li class="empty-tip">暂无待安排事项</li>';
    return;
  }
  planState.unscheduled.forEach(u => {
    const li = document.createElement('li');
    li.draggable = true;
    li.title = '拖到日历任意一天，或点「填入」放到选中日';
    li.innerHTML = `<span class="drag-handle">⠿</span><span class="text">${esc(u.title)}</span><button class="use btn-mini" data-id="${u.id}">填入</button><button class="del" data-id="${u.id}">×</button>`;
    li.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'unscheduled', id: u.id }));
      ev.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.querySelector('.use').addEventListener('click', () => {
      planState.events.push({ id: uid(), title: u.title, date: planState.selectedDate, time: '', type: 'block', track: planState.activeTrack, done: false });
      planState.unscheduled = planState.unscheduled.filter(x => x.id !== u.id);
      saveData(PLAN_STORE.events, planState.events);
      saveData(PLAN_STORE.unscheduled, planState.unscheduled);
      renderPlan();
      toast(`「${u.title}」已填入 ${planState.selectedDate}`);
    });
    li.querySelector('.del').addEventListener('click', () => {
      planState.unscheduled = planState.unscheduled.filter(x => x.id !== u.id);
      saveData(PLAN_STORE.unscheduled, planState.unscheduled);
      renderPlan();
    });
    list.appendChild(li);
  });
}

function addUnscheduled() {
  const inp = document.getElementById('unschedInput');
  const v = inp.value.trim();
  if (!v) return;
  planState.unscheduled.push({ id: uid(), title: v });
  saveData(PLAN_STORE.unscheduled, planState.unscheduled);
  inp.value = '';
  renderPlan();
}

/* ---------- 资金模块 ---------- */
function renderFinance() {
  const holder = document.getElementById('financeHolder');
  if (!currentAssets) {
    holder.innerHTML = '<p class="empty-tip">暂无资产数据。提供腾讯文档表格链接后，AI 会读取并填充。</p>';
    return;
  }
  const a = currentAssets;
  let html = '';

  if (a.sourceUrl) {
    html += '<div class="fund-source">数据来源：<a href="' + esc(a.sourceUrl) + '" target="_blank" rel="noopener">' + esc(a.source || '腾讯文档') + '</a> · 最新：<strong>' + esc(a.latestDate || '—') + '</strong> <span class="edit-tag">· 可直接编辑</span></div>';
  }

  const sm = a.summary || {};
  html += '<div class="asset-summary">';
  html += editStat('总计', 'summary.total', sm.total);
  html += editStat('总计流动', 'summary.totalLiu', sm.totalLiu);
  html += editStat('总计扣原有', 'summary.totalKou', sm.totalKou);
  html += '</div>';

  const diff = computeDiff(a.history);
  if (diff) {
    a.diff = diff;
    a.latestDate = a.history[a.history.length - 1].date;
    a.previousDate = a.history[a.history.length - 2].date;
    const dt = diff.total, dtUp = dt.change >= 0;
    html += '<div class="fund-diff-section"><div class="fund-diff-title">环比变化 <span class="fund-diff-dates">' + esc(a.latestDate) + ' vs ' + esc(a.previousDate) + '</span></div><div class="fund-diff-cards">';
    html += '<div class="diff-card ' + (dtUp ? 'up' : 'down') + '"><div class="diff-label">总计</div><div class="diff-values"><span class="diff-now">' + esc(sm.total) + '</span></div><div class="diff-change">' + (dtUp ? '▲' : '▼') + ' ' + esc(dt.changeStr) + ' <span class="diff-percent">(' + esc(dt.percent) + ')</span></div><div class="diff-prev">上次 ' + esc(a.previousDate) + '：' + formatMoney(dt.previous) + '</div></div>';
    const dk = diff.totalKou, dkUp = dk.change >= 0;
    html += '<div class="diff-card ' + (dkUp ? 'up' : 'down') + '"><div class="diff-label">总计扣原有</div><div class="diff-values"><span class="diff-now">' + esc(sm.totalKou) + '</span></div><div class="diff-change">' + (dkUp ? '▲' : '▼') + ' ' + esc(dk.changeStr) + ' <span class="diff-percent">(' + esc(dk.percent) + ')</span></div><div class="diff-prev">上次 ' + esc(a.previousDate) + '：' + formatMoney(dk.previous) + '</div></div>';
    html += '</div></div>';
  }

  html += '<h3 class="fund-section-title">资产明细 <button class="btn-mini" id="assetAddRow" type="button">+ 添加</button></h3>';
  html += '<table class="asset-table"><thead><tr><th>位置</th><th>类型</th><th>金额</th><th></th></tr></thead><tbody>';
  a.items.forEach(function (item, i) {
    html += '<tr><td><input class="asset-in" data-k="items.' + i + '.name" value="' + esc(item.name || '') + '"></td>'
      + '<td><input class="asset-in" data-k="items.' + i + '.type" value="' + esc(item.type || '') + '"></td>'
      + '<td><input class="asset-in num" data-k="items.' + i + '.amount" value="' + esc(item.amount || '') + '"></td>'
      + '<td><button class="asset-del" data-i="' + i + '" type="button">×</button></td></tr>';
  });
  html += '</tbody></table>';

  const hist = a.history;
  if (hist && hist.length) {
    html += '<h3 class="fund-section-title">历史趋势 <button class="btn-mini" id="histAddRow" type="button">+ 添加</button></h3>';
    html += '<div class="fund-history-edit"><table class="asset-table"><thead><tr><th>日期</th><th>总计</th><th>扣原有</th><th></th></tr></thead><tbody>';
    hist.forEach(function (h, i) {
      html += '<tr><td><input class="asset-in" data-k="history.' + i + '.date" value="' + esc(h.date || '') + '"></td>'
        + '<td><input class="asset-in num" data-k="history.' + i + '.total" value="' + esc(h.total || '') + '"></td>'
        + '<td><input class="asset-in num" data-k="history.' + i + '.totalKou" value="' + esc(h.totalKou || '') + '"></td>'
        + '<td><button class="asset-del" data-hi="' + i + '" type="button">×</button></td></tr>';
    });
    html += '</tbody></table></div>';
  }

  const predHtml = buildPredictionChart(a.history);
  if (predHtml) { html += '<h3 class="fund-section-title">百万目标预测</h3>' + predHtml; }

  html += '<div class="asset-actions"><button class="btn" id="assetSaveLocal" type="button">保存到本机</button><button class="btn primary" id="assetSyncDoc" type="button">同步到腾讯文档</button><span id="assetMsg" class="asset-msg"></span></div>';

  holder.innerHTML = html;
  bindAssetInputs();
}

function editStat(label, key, val) {
  return '<div class="asset-stat"><div class="label">' + label + '</div><div class="value"><input class="asset-in num" data-k="' + key + '" value="' + esc(val || '') + '"></div></div>';
}

function setByPath(obj, path, val) {
  const parts = String(path).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (o[k] === undefined || o[k] === null) o[k] = (/^\d+$/.test(parts[i + 1]) ? [] : {});
    o = o[k];
  }
  o[parts[parts.length - 1]] = val;
}

function bindAssetInputs() {
  document.querySelectorAll('#financeHolder .asset-in').forEach(function (inp) {
    inp.addEventListener('input', function () { setByPath(currentAssets, inp.dataset.k, inp.value); });
  });
  const add = document.getElementById('assetAddRow');
  if (add) add.onclick = function () { currentAssets.items.push({ name: '', type: '', amount: '' }); renderFinance(); };
  const hadd = document.getElementById('histAddRow');
  if (hadd) hadd.onclick = function () { currentAssets.history.push({ date: '', total: '', totalKou: '' }); renderFinance(); };
  document.querySelectorAll('#financeHolder .asset-del[data-i]').forEach(function (b) {
    b.onclick = function () { currentAssets.items.splice(Number(b.dataset.i), 1); renderFinance(); };
  });
  document.querySelectorAll('#financeHolder .asset-del[data-hi]').forEach(function (b) {
    b.onclick = function () { currentAssets.history.splice(Number(b.dataset.hi), 1); renderFinance(); };
  });
  const sl = document.getElementById('assetSaveLocal');
  if (sl) sl.onclick = function () {
    const seed = window.__aiData || {};
    const full = { assets: currentAssets, todayTodos: seed.todayTodos || [], lastRefresh: new Date().toLocaleString('zh-CN') };
    try { localStorage.setItem('pw_ai_data', JSON.stringify(full)); } catch (e) {}
    try { localSet('ai_data', full); } catch (e) { console.warn('[资产] 推送云端失败：', e); }
    const m = document.getElementById('assetMsg'); if (m) m.textContent = '已保存到云端（同步中）';
  };
  const sd = document.getElementById('assetSyncDoc');
  if (sd) sd.onclick = function () { exportAssetsForSync(); };
}

function computeDiff(hist) {
  if (!hist || hist.length < 2) return null;
  const last = hist[hist.length - 1], prev = hist[hist.length - 2];
  const lv = parseMoney(last.total || '0'), pv = parseMoney(prev.total || '0');
  const kLast = parseMoney(last.totalKou || '0'), kPrev = parseMoney(prev.totalKou || '0');
  const ch = lv - pv, kch = kLast - kPrev;
  return {
    total: { latest: lv, previous: pv, change: ch, changeStr: fmtChange(ch), percent: pct(ch, pv) },
    totalKou: { latest: kLast, previous: kPrev, change: kch, changeStr: fmtChange(kch), percent: pct(kch, kPrev) }
  };
}

function fmtChange(n) {
  return (n >= 0 ? '+' : '-') + '¥' + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(ch, base) {
  if (!base) return '0%';
  return (ch >= 0 ? '+' : '') + (ch / base * 100).toFixed(2) + '%';
}

function exportAssetsForSync() {
  const seed = window.__aiData || {};
  const payload = Object.assign({}, seed, { lastRefresh: new Date().toLocaleString('zh-CN'), assets: currentAssets });
  const json = JSON.stringify(payload, null, 2);
  const done = function () {
    const m = document.getElementById('assetMsg');
    if (m) m.textContent = '已复制，请到 WorkBuddy 发送「更新腾讯文档」并粘贴数据';
    alert('资产数据已复制到剪贴板。\n请在 WorkBuddy 对话发送：「更新腾讯文档」，并把剪贴板里的数据粘贴给我。');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(done).catch(function () { prompt('复制以下资产数据发给我：', json); });
  } else {
    prompt('复制以下资产数据发给我：', json);
  }
}

/* ---------- 百万目标预测 ---------- */
function buildPredictionChart(hist) {
  if (!hist || hist.length < 3) return '';

  const YEAR = 2026;
  const dayMs = 86400000;

  // Parse history data into points with Date objects and day offsets
  const pts = hist.map(h => {
    const m = h.date.match(/(\d+)月(\d+)日/);
    const date = m ? new Date(YEAR, +m[1] - 1, +m[2]) : new Date();
    return { date, total: parseMoney(h.total), totalKou: parseMoney(h.totalKou), day: 0 };
  });
  const firstTime = pts[0].date.getTime();
  pts.forEach(p => { p.day = Math.round((p.date.getTime() - firstTime) / dayMs); });

  // Linear regression: y = slope * x + intercept
  function linReg(arr) {
    const n = arr.length;
    const sx = arr.reduce((s, p) => s + p.x, 0);
    const sy = arr.reduce((s, p) => s + p.y, 0);
    const sxy = arr.reduce((s, p) => s + p.x * p.y, 0);
    const sx2 = arr.reduce((s, p) => s + p.x * p.x, 0);
    const denom = n * sx2 - sx * sx;
    if (denom === 0) return { slope: 0, intercept: sy / n };
    return { slope: (n * sxy - sx * sy) / denom, intercept: (sy - ((n * sxy - sx * sy) / denom) * sx) / n };
  }

  const regT = linReg(pts.map(p => ({ x: p.day, y: p.total })));
  const regK = linReg(pts.map(p => ({ x: p.day, y: p.totalKou })));
  const TARGET = 1000000;

  const daysT = regT.slope > 0 ? (TARGET - regT.intercept) / regT.slope : Infinity;
  const daysK = regK.slope > 0 ? (TARGET - regK.intercept) / regK.slope : Infinity;
  const predDateT = isFinite(daysT) ? new Date(firstTime + daysT * dayMs) : null;
  const predDateK = isFinite(daysK) ? new Date(firstTime + daysK * dayMs) : null;

  const latest = pts[pts.length - 1];
  const now = new Date();
  const daysRemT = predDateT ? Math.max(0, Math.ceil((predDateT.getTime() - now.getTime()) / dayMs)) : null;
  const daysRemK = predDateK ? Math.max(0, Math.ceil((predDateK.getTime() - now.getTime()) / dayMs)) : null;

  function fmtDate(d) {
    if (!d) return '无法预测';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // Chart geometry
  const nearer = Math.min(isFinite(daysT) ? daysT : Infinity, isFinite(daysK) ? daysK : Infinity);
  const chartEndDay = isFinite(nearer) ? nearer * 1.2 : pts[pts.length - 1].day + 30;
  const W = 680, H = 360;
  const padL = 72, padR = 28, padT = 35, padB = 55;
  const cw = W - padL - padR, ch = H - padT - padB;
  const maxY = TARGET * 1.12;

  const xMap = day => padL + (day / chartEndDay) * cw;
  const yMap = val => padT + ch - (Math.max(0, Math.min(val, maxY)) / maxY) * ch;

  // Historical polylines
  const histTLine = pts.map(p => `${xMap(p.day).toFixed(1)},${yMap(p.total).toFixed(1)}`).join(' ');
  const histKLine = pts.map(p => `${xMap(p.day).toFixed(1)},${yMap(p.totalKou).toFixed(1)}`).join(' ');

  // Projected polylines (from last data point forward)
  const lastP = pts[pts.length - 1];
  const projTEndDay = isFinite(daysT) ? Math.min(daysT, chartEndDay) : chartEndDay;
  const projKEndDay = isFinite(daysK) ? Math.min(daysK, chartEndDay) : chartEndDay;
  const projTVal = Math.min(regT.intercept + regT.slope * projTEndDay, TARGET);
  const projKVal = Math.min(regK.intercept + regK.slope * projKEndDay, TARGET * 0.6);
  const projTLine = `${xMap(lastP.day).toFixed(1)},${yMap(lastP.total).toFixed(1)} ${xMap(projTEndDay).toFixed(1)},${yMap(projTVal).toFixed(1)}`;
  const projKLine = `${xMap(lastP.day).toFixed(1)},${yMap(lastP.totalKou).toFixed(1)} ${xMap(projKEndDay).toFixed(1)},${yMap(projKVal).toFixed(1)}`;

  // Y-axis ticks
  const yTicks = [0, 200000, 400000, 600000, 800000, 1000000];
  // X-axis ticks
  const xTickCount = 5;
  const xTicks = [];
  for (let i = 0; i <= xTickCount; i++) {
    const day = (chartEndDay / xTickCount) * i;
    const d = new Date(firstTime + day * dayMs);
    xTicks.push({ day, label: `${d.getMonth() + 1}/${d.getDate()}` });
  }

  const nowDay = Math.round((now.getTime() - firstTime) / dayMs);
  const nowX = xMap(Math.max(0, Math.min(nowDay, chartEndDay)));
  const targetY = yMap(TARGET);

  // Build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="pred-svg" preserveAspectRatio="xMidYMid meet">`;

  // Y-axis grid + labels
  yTicks.forEach(val => {
    const y = yMap(val);
    const isTarget = val === TARGET;
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${isTarget ? '#e74c3c' : 'var(--color-border)'}" stroke-width="1" stroke-dasharray="${isTarget ? '6,4' : '2,3'}" opacity="${isTarget ? '0.8' : '0.5'}" />`;
    const label = val === 0 ? '¥0' : val >= 1000000 ? '¥100万' : `¥${val / 10000}万`;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="${isTarget ? '#e74c3c' : 'var(--color-text-secondary)'}" font-size="11">${label}</text>`;
  });

  // X-axis labels
  xTicks.forEach(t => {
    svg += `<text x="${xMap(t.day).toFixed(1)}" y="${padT + ch + 20}" text-anchor="middle" fill="var(--color-text-secondary)" font-size="11">${t.label}</text>`;
  });

  // Target line label
  svg += `<text x="${W - padR}" y="${targetY - 7}" text-anchor="end" fill="#e74c3c" font-size="12" font-weight="600">目标 ¥100万</text>`;

  // Today vertical line
  if (nowDay > 0 && nowDay < chartEndDay) {
    svg += `<line x1="${nowX.toFixed(1)}" y1="${padT}" x2="${nowX.toFixed(1)}" y2="${padT + ch}" stroke="var(--color-text-tertiary)" stroke-width="1" stroke-dasharray="3,3" opacity="0.5" />`;
    svg += `<text x="${nowX.toFixed(1)}" y="${padT - 8}" text-anchor="middle" fill="var(--color-text-tertiary)" font-size="11">今天</text>`;
  }

  // 总计: historical (solid) + projected (dashed)
  svg += `<polyline points="${histTLine}" fill="none" stroke="var(--color-accent)" stroke-width="2.5" stroke-linejoin="round" />`;
  svg += `<polyline points="${projTLine}" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-dasharray="7,4" opacity="0.45" stroke-linejoin="round" />`;

  // 总计扣原有: historical (solid) + projected (dashed)
  svg += `<polyline points="${histKLine}" fill="none" stroke="#f39c12" stroke-width="2.5" stroke-linejoin="round" />`;
  svg += `<polyline points="${projKLine}" fill="none" stroke="#f39c12" stroke-width="2" stroke-dasharray="7,4" opacity="0.45" stroke-linejoin="round" />`;

  // Data point dots
  pts.forEach(p => {
    svg += `<circle cx="${xMap(p.day).toFixed(1)}" cy="${yMap(p.total).toFixed(1)}" r="3.5" fill="var(--color-accent)" />`;
    svg += `<circle cx="${xMap(p.day).toFixed(1)}" cy="${yMap(p.totalKou).toFixed(1)}" r="3.5" fill="#f39c12" />`;
  });

  // Predicted target point for 总计
  if (isFinite(daysT) && daysT <= chartEndDay) {
    svg += `<circle cx="${xMap(daysT).toFixed(1)}" cy="${targetY.toFixed(1)}" r="5.5" fill="#e74c3c" stroke="var(--color-bg-secondary)" stroke-width="2.5" />`;
    svg += `<text x="${xMap(daysT).toFixed(1)}" y="${targetY + 22}" text-anchor="middle" fill="#e74c3c" font-size="11" font-weight="600">${predDateT.getMonth() + 1}/${predDateT.getDate()}</text>`;
  }

  // Legend
  svg += `<g transform="translate(${padL + 8}, ${padT + 8})">`;
  svg += `<rect x="0" y="0" width="148" height="56" fill="var(--color-bg-secondary)" opacity="0.92" rx="6" />`;
  svg += `<line x1="10" y1="16" x2="28" y2="16" stroke="var(--color-accent)" stroke-width="2.5" />`;
  svg += `<text x="34" y="20" fill="var(--color-text)" font-size="11">总计（含原有）</text>`;
  svg += `<line x1="10" y1="38" x2="28" y2="38" stroke="#f39c12" stroke-width="2.5" />`;
  svg += `<text x="34" y="42" fill="var(--color-text)" font-size="11">总计扣原有</text>`;
  svg += `</g>`;

  svg += `</svg>`;

  // Summary cards
  let cards = '<div class="pred-cards">';

  // 总计 card
  cards += '<div class="pred-card">';
  cards += `<div class="pred-card-label"><span class="pred-dot" style="background:var(--color-accent)"></span>总计（含原有）</div>`;
  cards += `<div class="pred-card-current">当前 ${formatMoney(latest.total)}</div>`;
  if (isFinite(daysT)) {
    cards += `<div class="pred-card-date">预计 <strong>${fmtDate(predDateT)}</strong></div>`;
    cards += `<div class="pred-card-days">还需约 <strong>${daysRemT}</strong> 天</div>`;
    cards += `<div class="pred-card-rate">日均增长 ${formatMoney(regT.slope)}</div>`;
  } else {
    cards += '<div class="pred-card-date">增长趋势不足，无法预测</div>';
  }
  cards += '</div>';

  // 总计扣原有 card
  cards += '<div class="pred-card">';
  cards += `<div class="pred-card-label"><span class="pred-dot" style="background:#f39c12"></span>总计扣原有</div>`;
  cards += `<div class="pred-card-current">当前 ${formatMoney(latest.totalKou)}</div>`;
  if (isFinite(daysK)) {
    cards += `<div class="pred-card-date">预计 <strong>${fmtDate(predDateK)}</strong></div>`;
    cards += `<div class="pred-card-days">还需约 <strong>${daysRemK}</strong> 天</div>`;
    cards += `<div class="pred-card-rate">日均增长 ${formatMoney(regK.slope)}</div>`;
  } else {
    cards += '<div class="pred-card-date">增长趋势不足，无法预测</div>';
  }
  cards += '</div>';
  cards += '</div>';

  // Progress bars
  const progressT = Math.min(100, (latest.total / TARGET) * 100);
  const progressK = Math.min(100, (latest.totalKou / TARGET) * 100);
  let bars = '<div class="pred-progress-wrap">';
  bars += `<div class="pred-progress-item"><div class="pred-progress-label"><span>总计</span><span>${progressT.toFixed(1)}%</span></div><div class="pred-progress-bar"><div class="pred-progress-fill" style="width:${progressT}%;background:var(--color-accent)"></div></div></div>`;
  bars += `<div class="pred-progress-item"><div class="pred-progress-label"><span>总计扣原有</span><span>${progressK.toFixed(1)}%</span></div><div class="pred-progress-bar"><div class="pred-progress-fill" style="width:${progressK}%;background:#f39c12"></div></div></div>`;
  bars += '</div>';

  return cards + '<div class="pred-chart-wrap">' + svg + '</div>' + bars;
}

/* 解析金额字符串为数字 */
function parseMoney(str) {
  if (typeof str === 'number') return str;
  return parseFloat(String(str || '0').replace(/[¥,\s]/g, '')) || 0;
}

/* 格式化数字为 ¥ 金额 */
function formatMoney(num) {
  const n = typeof num === 'number' ? num : parseMoney(num);
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- 个人记录：备忘录/灵感/学习 ---------- */
function initRecords() {
  setupRecord('ideaInput', 'ideaAdd', 'ideaList', 'rec_ideas');
}

function setupRecord(inputId, btnId, listId, storeKey) {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const add = () => {
    const v = inp.value.trim();
    if (!v) return;
    const list = loadData(storeKey, []);
    list.unshift({ id: uid(), text: v, time: Date.now() });
    saveData(storeKey, list);
    inp.value = '';
    renderRecord(listId, storeKey);
  };
  btn.addEventListener('click', add);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  renderRecord(listId, storeKey);
}

function renderRecord(listId, storeKey) {
  const list = document.getElementById(listId);
  const items = loadData(storeKey, []);
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<li style="border:none;color:var(--color-text-tertiary)">暂无记录</li>'; return; }
  items.forEach(it => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="text">${esc(it.text)}</span><span class="meta">${fmtTime(it.time)}</span>`;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×';
    del.addEventListener('click', () => {
      saveData(storeKey, loadData(storeKey, []).filter(x => x.id !== it.id));
      renderRecord(listId, storeKey);
    });
    li.appendChild(del);
    list.appendChild(li);
  });
}

/* ---------- 学习：分类 + 进度条 + 完成时间估算 ---------- */
const LEARN_TYPES = {
  book:  { label: '书籍', unit: '页', color: '#3b82f6' },
  video: { label: '视频', unit: '集', color: '#2ecc71' },
  audio: { label: '音频', unit: '集', color: '#9b59b6' },
  other: { label: '其它', unit: '项', color: '#f39c12' },
};
const LEARN_KEY = 'rec_learning';

// 读取并规范化（兼容旧备忘录式文本数据）
function loadLearning() {
  let list = loadData(LEARN_KEY, []);
  if (!Array.isArray(list)) list = [];
  let changed = false;
  list.forEach(it => {
    if (it.total == null) { it.type = it.type || 'other'; it.total = 1; it.current = 1; it.unit = '项'; it.pace = 0; it.done = true; changed = true; }
    if (it.current == null) { it.current = 0; changed = true; }
    if (!it.unit) { it.unit = (LEARN_TYPES[it.type] || LEARN_TYPES.other).unit; changed = true; }
    if (it.pace == null) { it.pace = 0; changed = true; }
    if (it.done == null) { it.done = it.current >= it.total; changed = true; }
  });
  if (changed) saveData(LEARN_KEY, list);
  return list;
}

function initLearning() {
  let filter = 'all';
  const add = () => {
    const nameInp = document.getElementById('learnName');
    const urlInp = document.getElementById('learnUrl');
    const title = nameInp.value.trim();
    const rawUrl = urlInp.value.trim();
    if (!title && !rawUrl) return;
    // 规范化网址：自动补全协议；若无效则保留原文
    let url = '';
    if (rawUrl) {
      try {
        url = new URL(rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : 'https://' + rawUrl).href;
      } catch {
        url = rawUrl;
      }
    }
    let finalTitle = title || '未命名';
    if (!title && url) {
      try { finalTitle = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    }
    const list = loadLearning();
    list.unshift({
      id: uid(),
      title: finalTitle,
      url,
      type: 'other',
      total: 1,
      current: 0,
      unit: LEARN_TYPES.other.unit,
      pace: 0,
      done: false,
    });
    saveData(LEARN_KEY, list);
    nameInp.value = '';
    urlInp.value = '';
    renderLearning(filter);
    toast(url ? `已添加学习链接：${title || url}` : `已添加学习项：${title}`);
  };
  document.getElementById('learnAdd').addEventListener('click', add);
  document.getElementById('learnName').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  document.getElementById('learnUrl').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  initLearnEditModal(filter);
  document.querySelectorAll('#learnTabs .learn-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#learnTabs .learn-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      filter = tab.dataset.type;
      renderLearning(filter);
    });
  });
  renderLearning(filter);
}

function initLearnEditModal(filter) {
  const modal = document.getElementById('learnEditModal');
  modal.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('focus', () => inp.select());
  });
  const close = () => { modal.hidden = true; };
  document.getElementById('learnEditClose').addEventListener('click', close);
  document.getElementById('learnEditCancel').addEventListener('click', close);
  document.querySelector('.modal-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
  document.getElementById('learnEditSave').addEventListener('click', () => {
    const id = document.getElementById('learnEditId').value;
    const all = loadLearning();
    const it = all.find(x => x.id === id);
    if (!it) { close(); return; }
    const title = document.getElementById('learnEditTitle').value.trim();
    const rawUrl = document.getElementById('learnEditUrl').value.trim();
    const type = document.getElementById('learnEditType').value;
    const total = parseInt(document.getElementById('learnEditTotal').value, 10) || 0;
    const cur = parseInt(document.getElementById('learnEditCurrent').value, 10) || 0;
    const pace = parseInt(document.getElementById('learnEditPace').value, 10) || 0;
    let url = '';
    if (rawUrl) {
      try { url = new URL(rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : 'https://' + rawUrl).href; }
      catch { url = rawUrl; }
    }
    it.title = title || (url ? new URL(url).hostname.replace(/^www\./, '') : '未命名');
    it.url = url;
    it.type = LEARN_TYPES[type] ? type : 'other';
    it.unit = LEARN_TYPES[it.type].unit;
    it.total = total;
    it.current = Math.min(cur, total);
    it.pace = pace;
    it.done = total > 0 && it.current >= total;
    saveData(LEARN_KEY, all);
    renderLearning(filter);
    close();
    toast('已保存');
  });
}

function openLearnEdit(id) {
  const all = loadLearning();
  const it = all.find(x => x.id === id);
  if (!it) return;
  document.getElementById('learnEditId').value = id;
  document.getElementById('learnEditTitle').value = it.title || '';
  document.getElementById('learnEditUrl').value = it.url || '';
  document.getElementById('learnEditType').value = it.type || 'other';
  document.getElementById('learnEditTotal').value = it.total || 0;
  document.getElementById('learnEditCurrent').value = it.current || 0;
  document.getElementById('learnEditPace').value = it.pace || 0;
  document.getElementById('learnEditModal').hidden = false;
}

function renderLearning(filter) {
  const all = loadLearning();
  const filtered = filter === 'all' ? all : all.filter(it => it.type === filter);
  const ul = document.getElementById('learnList');
  ul.innerHTML = '';
  // 顶部总进度
  const sumTotal = all.reduce((s, it) => s + (it.total || 0), 0);
  const sumCur = all.reduce((s, it) => s + Math.min(it.current || 0, it.total || 0), 0);
  const overall = sumTotal ? Math.round(sumCur / sumTotal * 100) : 0;
  document.getElementById('learnSummary').innerHTML =
    `总进度 <b>${overall}%</b> · 已完成 ${sumCur}/${sumTotal} 单位（${all.length} 项）`;

  if (!filtered.length) { ul.innerHTML = '<li style="border:none;color:var(--color-text-tertiary)">暂无学习项，添加一本书/视频/音频开始吧</li>'; }

  filtered.forEach(it => {
    const meta = LEARN_TYPES[it.type] || LEARN_TYPES.other;
    const cur = Math.min(it.current || 0, it.total || 0);
    const total = it.total || 0;
    const pct = total ? Math.round(cur / total * 100) : (it.done ? 100 : 0);
    const remaining = Math.max(total - cur, 0);
    let eta;
    if (it.done || remaining === 0) eta = '已完成 ✓';
    else if (it.pace > 0) {
      const days = Math.ceil(remaining / it.pace);
      const d = new Date(); d.setDate(d.getDate() + days);
      eta = `预计 ${d.getMonth() + 1}/${d.getDate()} 学完 · 约 ${days} 天`;
    } else eta = '未设置每日速度';

    const titleHtml = it.url
      ? `<a class="learn-title learn-title-link" href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.url)}">${esc(it.title || it.url)}</a>`
      : `<span class="learn-title">${esc(it.title)}</span>`;
    const li = document.createElement('li');
    li.className = 'learn-item' + (it.done ? ' done' : '');
    li.innerHTML =
      `<div class="learn-head">
         ${titleHtml}
         <span class="learn-type" style="color:${meta.color};border-color:${meta.color}33;background:${meta.color}1a">${meta.label}</span>
       </div>
       <div class="learn-progress">
         <div class="learn-bar"><div class="learn-bar-fill" style="width:${pct}%;background:${meta.color}"></div></div>
         <span class="learn-pct">${pct}%</span>
       </div>
       <div class="learn-meta">
         <span>${cur}/${total} ${meta.unit}</span>
         <span class="learn-eta">${esc(eta)}</span>
       </div>
       <div class="learn-actions">
         <button class="learn-btn minus" title="减 1">−</button>
         <button class="learn-btn plus" title="加 1">＋</button>
         <button class="learn-btn done-btn" title="标记完成">完成</button>
         <button class="learn-btn edit-btn" title="编辑总量/进度/速度">编辑</button>
         <button class="learn-btn del" title="删除">×</button>
       </div>`;
    li.querySelector('.plus').addEventListener('click', () => {
      it.current = Math.min((it.current || 0) + 1, it.total); it.done = it.current >= it.total;
      saveData(LEARN_KEY, all); renderLearning(filter);
    });
    li.querySelector('.minus').addEventListener('click', () => {
      it.current = Math.max((it.current || 0) - 1, 0); it.done = false;
      saveData(LEARN_KEY, all); renderLearning(filter);
    });
    li.querySelector('.done-btn').addEventListener('click', () => {
      it.current = it.total; it.done = true;
      saveData(LEARN_KEY, all); renderLearning(filter);
    });
    li.querySelector('.del').addEventListener('click', () => {
      saveData(LEARN_KEY, all.filter(x => x.id !== it.id)); renderLearning(filter);
    });
    li.querySelector('.edit-btn').addEventListener('click', () => openLearnEdit(it.id));
    ul.appendChild(li);
  });
}

/* ---------- 备忘录：四象限 + 打钩消失 + 拖拽归类 ---------- */
// 固定四个象限（艾森豪威尔矩阵）
const MEMO_QUADRANTS = [
  { id: 'q1', name: '紧急重要', desc: '立即做' },
  { id: 'q2', name: '紧急不重要', desc: '授权 / 减少' },
  { id: 'q3', name: '不紧急重要', desc: '规划安排' },
  { id: 'q4', name: '不紧急不重要', desc: '删除 / 搁置' },
];
const MEMO_QUAD_IDS = MEMO_QUADRANTS.map(q => q.id);

function initMemo() {
  const sel = document.getElementById('noteCat');
  // 添加
  const add = () => {
    const inp = document.getElementById('noteInput');
    const v = inp.value.trim();
    if (!v) return;
    const cat = sel.value || MEMO_QUAD_IDS[0];
    const list = loadData('rec_notes', []);
    list.unshift({ id: uid(), text: v, time: Date.now(), cat, done: false });
    saveData('rec_notes', list);
    inp.value = '';
    renderMemo();
  };
  document.getElementById('noteAdd').addEventListener('click', add);
  document.getElementById('noteInput').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  // 已完成区折叠
  document.getElementById('memoDoneToggle').addEventListener('click', () => {
    const list = document.getElementById('memoDoneList');
    list.hidden = !list.hidden;
    renderMemo();
  });
  renderMemo();
}

function renderMemo() {
  const quads = MEMO_QUADRANTS;
  // 兼容旧数据（无 / 非法 cat 字段 → 归入「紧急重要」）
  const all = loadData('rec_notes', []);
  let changed = false;
  all.forEach(it => { if (!MEMO_QUAD_IDS.includes(it.cat)) { it.cat = MEMO_QUAD_IDS[0]; changed = true; } });
  if (changed) saveData('rec_notes', all);

  // 象限下拉
  const sel = document.getElementById('noteCat');
  sel.innerHTML = quads.map(q => `<option value="${esc(q.id)}">${esc(q.name)}</option>`).join('');

  // 四象限卡片
  const quadBox = document.getElementById('memoCats');
  quadBox.innerHTML = '';
  quads.forEach(q => {
    const items = all.filter(it => it.cat === q.id && !it.done);
    const block = document.createElement('div');
    block.className = `memo-quad memo-quad--${q.id}`;
    block.innerHTML =
      `<div class="memo-cat-head">
         <span class="memo-cat-name">${esc(q.name)}</span>
         <span class="memo-cat-desc">${esc(q.desc)}</span>
         <span class="memo-cat-count">${items.length}</span>
       </div>`;
    const ul = document.createElement('ul');
    ul.className = 'list memo-cat-list';
    ul.dataset.cat = q.id;
    if (!items.length) ul.innerHTML = '<li class="memo-empty">拖拽备忘到这里</li>';
    items.forEach(it => ul.appendChild(renderMemoItem(it)));
    block.appendChild(ul);
    // 拖放目标
    ul.addEventListener('dragover', e => { e.preventDefault(); ul.classList.add('drag-over'); });
    ul.addEventListener('dragleave', () => ul.classList.remove('drag-over'));
    ul.addEventListener('drop', e => {
      e.preventDefault(); ul.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) moveMemoToCat(id, q.id);
    });
    quadBox.appendChild(block);
  });

  // 已完成区
  const doneItems = all.filter(it => it.done);
  const doneList = document.getElementById('memoDoneList');
  const toggle = document.getElementById('memoDoneToggle');
  toggle.textContent = `已完成 ${doneItems.length} 项 ${doneList.hidden ? '▸' : '▾'}`;
  doneList.innerHTML = '';
  if (!doneItems.length) doneList.innerHTML = '<li class="memo-empty">还没有完成的备忘</li>';
  doneItems.forEach(it => {
    const li = document.createElement('li');
    li.className = 'memo-item done';
    li.innerHTML =
      `<input type="checkbox" class="memo-check" checked />
       <span class="text">${esc(it.text)}</span>
       <button class="del" title="删除">×</button>`;
    li.querySelector('.memo-check').addEventListener('change', () => toggleMemoDone(it.id, false));
    li.querySelector('.del').addEventListener('click', e => { e.stopPropagation(); deleteMemo(it.id); });
    doneList.appendChild(li);
  });
}

function renderMemoItem(it) {
  const li = document.createElement('li');
  li.className = 'memo-item';
  li.draggable = true;
  li.dataset.id = it.id;
  li.dataset.cat = it.cat;
  li.innerHTML =
    `<input type="checkbox" class="memo-check" title="标记完成" />
     <span class="text">${esc(it.text)}</span>
     <span class="meta">${fmtTime(it.time)}</span>
     <button class="del" title="删除">×</button>`;
  li.querySelector('.memo-check').addEventListener('change', () => markMemoDone(li, it.id));
  li.querySelector('.del').addEventListener('click', e => { e.stopPropagation(); deleteMemo(it.id); });
  li.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', it.id);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  return li;
}

function markMemoDone(li, id) {
  const all = loadData('rec_notes', []);
  const t = all.find(x => x.id === id);
  if (!t) return;
  t.done = true;
  saveData('rec_notes', all);
  li.classList.add('memo-fade');
  setTimeout(() => renderMemo(), 280);
  toast('已完成，已隐藏');
}

function toggleMemoDone(id, done) {
  const all = loadData('rec_notes', []);
  const t = all.find(x => x.id === id);
  if (t) { t.done = done; saveData('rec_notes', all); }
  renderMemo();
}

function deleteMemo(id) {
  saveData('rec_notes', loadData('rec_notes', []).filter(x => x.id !== id));
  renderMemo();
}

function moveMemoToCat(id, cat) {
  const all = loadData('rec_notes', []);
  const t = all.find(x => x.id === id);
  if (t && t.cat !== cat) { t.cat = cat; saveData('rec_notes', all); renderMemo(); }
}

/* ---------- 习惯与健康 ---------- */
function initHabits() {
  renderHabits();
  const add = () => {
    const inp = document.getElementById('habitInput');
    const v = inp.value.trim();
    if (!v) return;
    const list = loadData('habits', []);
    list.push({ id: uid(), name: v, history: [] });
    saveData('habits', list);
    inp.value = '';
    renderHabits();
  };
  document.getElementById('habitAdd').addEventListener('click', add);
  document.getElementById('habitInput').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
}

function renderHabits() {
  const grid = document.getElementById('habitsGrid');
  const list = loadData('habits', []);
  grid.innerHTML = '';
  if (!list.length) { grid.innerHTML = '<p class="hint">暂无习惯项，添加如「23点前睡」「健身30分钟」。</p>'; return; }
  const today = todayStr();
  list.forEach(h => {
    const card = document.createElement('div');
    card.className = 'habit-card';
    const done = h.history.includes(today);
    const streak = calcStreak(h.history);
    card.innerHTML =
      `<div class="habit-name">${esc(h.name)}<button class="del" title="删除">×</button></div>
       <div class="habit-stats">连续 <span class="habit-streak">${streak}</span> 天 · 累计 ${h.history.length} 天</div>
       <div class="habit-check"><button class="habit-today-btn ${done ? 'done' : ''}">${done ? '今日已打卡 ✓' : '今日打卡'}</button></div>`;
    card.querySelector('.habit-today-btn').addEventListener('click', () => toggleHabit(h.id));
    card.querySelector('.del').addEventListener('click', () => {
      saveData('habits', loadData('habits', []).filter(x => x.id !== h.id));
      renderHabits();
    });
    grid.appendChild(card);
  });
}

function toggleHabit(id) {
  const list = loadData('habits', []);
  const h = list.find(x => x.id === id);
  if (!h) return;
  const today = todayStr();
  const i = h.history.indexOf(today);
  if (i >= 0) h.history.splice(i, 1); else h.history.push(today);
  saveData('habits', list);
  renderHabits();
}

function calcStreak(history) {
  const set = new Set(history);
  let count = 0;
  const d = new Date();
  if (!set.has(todayStr())) d.setDate(d.getDate() - 1);
  while (set.has(d.toISOString().slice(0, 10))) { count++; d.setDate(d.getDate() - 1); }
  return count;
}

/* ---------- 自动化一览 ---------- */
// 兜底数据：当自动化执行记录文件拉取失败时使用（保持页面不空白）
const AUTO_FALLBACK = [
  { id: 'automation-1785466676203', name: '个人工作台每日资产刷新', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', status: 'PAUSED' },
  { id: 'automation-1785402477187', name: '每日A股短线策略扫描', rrule: 'FREQ=DAILY;BYHOUR=15;BYMINUTE=30', status: 'ACTIVE' },
  { id: 'automation-1784681575767', name: 'Apple 官翻 Mac mini 库存监控', rrule: 'FREQ=DAILY;BYHOUR=0;BYMINUTE=0', status: 'PAUSED' },
  { id: 'automation-1783582775216', name: '股市消息面晚报', rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=30', status: 'ACTIVE' },
  { id: 'automation-1783582775189', name: '股市消息面早报', rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0', status: 'ACTIVE' },
  { id: 'automation-1782971654394', name: '单针下20每日扫描', rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=0', status: 'ACTIVE' },
  { id: 'automation-1782801037329', name: '孙宇晨每日资讯推送', rrule: 'FREQ=DAILY;BYHOUR=21;BYMINUTE=30', status: 'PAUSED' },
  { id: 'automation-1782788687578', name: '电商运营', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=20;BYMINUTE=0', status: 'ACTIVE' },
  { id: 'automation-1782787575435', name: '比亚迪每日资讯推送', rrule: 'FREQ=DAILY;BYHOUR=22;BYMINUTE=0', status: 'ACTIVE' },
];

// 把 RRULE 解析成可读调度文本
function rruleToSchedule(rrule) {
  if (!rrule) return '未设置';
  const m = Object.fromEntries(rrule.split(';').map(p => p.split('=')).filter(a => a.length === 2));
  const hh = (m.BYHOUR || '0').padStart(2, '0');
  const mm = (m.BYMINUTE || '0').padStart(2, '0');
  const time = `${hh}:${mm}`;
  if (m.FREQ === 'WEEKLY') {
    // 7 天全选等价于每天；否则展示每周
    const days = (m.BYDAY || '').split(',').filter(Boolean);
    return days.length >= 7 ? `每天 ${time}` : `每周 ${time}`;
  }
  return `每天 ${time}`;
}

const RUN_STATUS_META = {
  success: { label: '成功', cls: 'ok' },
  failed: { label: '失败', cls: 'fail' },
  running: { label: '运行中', cls: 'run' },
};

// 后端控制接口可用性（本地服务才有，GitHub Pages 无）
let backendOk = true;

// 向本地控制接口发送暂停/恢复/立即执行请求
async function apiControl(id, action) {
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (e) {
    console.error('[工作台] 控制请求失败：', e);
    return false;
  }
}

async function initAutomations() {
  const grid = document.getElementById('autoGrid');
  if (!grid) return;
  grid.innerHTML = '';
  let tasks = AUTO_FALLBACK;
  try {
    const res = await fetch('data/automation-runs.json?v=6');
    if (res.ok) {
      const data = await res.json();
      // 用文件中的任务覆盖兜底（以 id 为准合并）
      const byId = new Map((data.tasks || []).map(t => [t.id, t]));
      tasks = AUTO_FALLBACK.map(f => byId.get(f.id) || f);
    }
  } catch (err) {
    console.error('[工作台] 加载 automation-runs.json 失败，使用兜底数据：', err);
  }

  // 检测后端控制接口是否可用（GitHub Pages 无此后端）
  try {
    const pr = await fetch('/api/control');
    backendOk = pr.ok;
  } catch { backendOk = false; }

  tasks.forEach(t => {
    const schedule = rruleToSchedule(t.rrule);
    const active = t.status === 'ACTIVE';
    const run = t.lastRun;
    let runHtml = '<div class="auto-run none">暂无执行记录</div>';
    if (run) {
      const meta = RUN_STATUS_META[run.status] || { label: run.status || '未知', cls: 'run' };
      runHtml =
        `<div class="auto-run">
           <span class="badge ${meta.cls}">${esc(meta.label)}</span>
           <span class="auto-run-at">${esc(fmtTime(new Date(run.at).getTime()))}</span>
         </div>
         ${run.summary ? `<div class="auto-result">${esc(run.summary)}</div>` : ''}
         ${run.commit ? `<div class="auto-commit">commit ${esc(run.commit)}</div>` : ''}`;
    }
    // 近期结果选择器（来自 executionHistory，按时间升序）
    const hist = (t.executionHistory || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    let historyHtml = '<div class="auto-history none">无历史记录</div>';
    if (hist.length) {
      const opts = hist.map((h, i) => {
        const m = RUN_STATUS_META[h.status] || { label: h.status || '未知' };
        return `<option value="${i}">${esc(fmtTime(new Date(h.at).getTime()))} · ${esc(m.label)}</option>`;
      }).join('');
      historyHtml =
        `<div class="auto-history">
           <label>近期结果</label>
           <select class="auto-history-select">${opts}</select>
           <div class="auto-history-detail"></div>
         </div>`;
    }
    // 控制按钮（无后端时禁用）
    const dis = backendOk ? '' : ' disabled title="控制需本地服务 http://localhost:8080"';
    const pauseBtn = active
      ? `<button class="auto-btn" data-act="pause"${dis}>暂停</button>`
      : `<button class="auto-btn" data-act="resume"${dis}>恢复</button>`;
    const runBtn = `<button class="auto-btn run" data-act="run"${dis}>立即执行</button>`;

    const card = document.createElement('div');
    card.className = 'auto-card';
    card.innerHTML =
      `<div class="auto-name">${esc(t.name)}</div>
       <div class="auto-meta">
         <span class="auto-schedule">${esc(schedule)}</span>
         <span class="badge ${active ? 'active' : 'paused'}">${active ? '运行中' : '已暂停'}</span>
       </div>
       <div class="auto-controls">${pauseBtn}${runBtn}</div>
       ${runHtml}
       ${historyHtml}`;
    grid.appendChild(card);

    // 近期结果：默认显示最新一条，切换时更新摘要
    if (hist.length) {
      const detail = card.querySelector('.auto-history-detail');
      const sel = card.querySelector('.auto-history-select');
      detail.textContent = hist[hist.length - 1].summary || '';
      sel.addEventListener('change', e => {
        const h = hist[Number(e.target.value)];
        detail.textContent = h.summary || '';
      });
    }

    // 控制按钮事件
    card.querySelectorAll('.auto-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const id = t.id;
        if (act === 'run') {
          const ok = await apiControl(id, 'run');
          toast(ok ? '已提交执行请求，约 1 小时内生效' : '控制需本地服务（http://localhost:8080）');
          return;
        }
        // pause / resume：乐观更新 UI，再请求后端
        const badge = card.querySelector('.auto-meta .badge');
        const wasPaused = badge.classList.contains('paused');
        const targetPaused = act === 'pause';
        const apply = (paused) => {
          if (paused) { badge.textContent = '已暂停'; badge.className = 'badge paused'; btn.textContent = '恢复'; btn.dataset.act = 'resume'; }
          else { badge.textContent = '运行中'; badge.className = 'badge active'; btn.textContent = '暂停'; btn.dataset.act = 'pause'; }
        };
        apply(targetPaused);
        const ok = await apiControl(id, act);
        if (!ok) { apply(wasPaused); toast('控制需本地服务（http://localhost:8080）'); }
        else { toast(targetPaused ? '已请求暂停，稍后生效' : '已请求恢复，稍后生效'); }
      });
    });
  });
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function flash(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const orig = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = orig; }, 1200);
}

/* ---------- 同步后重渲各视图 ---------- */
function rerenderAll() {
  safe('renderPlan', renderPlan);
  safe('renderMemo', renderMemo);
  safe('renderHabits', renderHabits);
  safe('renderLearningAll', () => renderLearning('all'));
  safe('renderIdeas', () => renderRecord('ideaList', 'rec_ideas'));
}

/* 顶栏同步状态徽章 */
function renderSyncBadge() {
  const envEl = document.getElementById('envBadge');
  if (envEl) {
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    envEl.textContent = isLocal ? '本地开发' : '正式';
    envEl.className = 'env-badge ' + (isLocal ? 'env-dev' : 'env-prod');
  }
  window.__renderSyncBadge = () => {
    const el = document.getElementById('syncBadge');
    if (!el) return;
    const s = getStatus();
    // 只读端（手机/公开链接，无 token）只能拉取、不能推送：
    // 在文案前加「只读·」明确提示「此处编辑不会同步」，避免误以为编辑已上传。
    let text = s.text || s.status;
    if (!s.canWrite && s.status !== 'nocfg') text = '只读·' + text;
    el.textContent = text;
    el.className = 'sync-badge ' + (
      s.status === 'ok' ? 'ok' :
      s.status === 'syncing' ? 'syncing' :
      s.status === 'merged' ? 'merged' : 'offline'
    );
    el.title = s.canWrite
      ? '已连接同步（可写）：此端编辑会自动同步到手机'
      : '只读同步：此端仅查看，编辑不会同步。要用请打开电脑 localhost:8080';
  };
  window.__renderSyncBadge();
}



/* ---------- 启动 ----------
   必须放在文件末尾：上面用到的 planState / TYPE_META / PLAN_STORE 是 let/const，
   在声明语句执行前访问会触发暂时性死区(TDZ)错误。
   boot 先初始化跨设备同步（带超时降级），再 bootstrap，最后订阅重渲。 */
async function boot() {
  renderSyncBadge();
  try {
    await initSync();
  } catch (e) {
    console.error('[sync] 初始化失败，降级为纯本地模式：', e);
  }
  bootstrap();
  subscribe(() => safe('rerenderAll', rerenderAll));
  const sb = document.getElementById('syncBadge');
  if (sb) sb.addEventListener('click', () => pullNow().catch(() => {}));
}

/* 初始化失败时在页面顶部显示可见提示，不再是"静默坏掉" */
function showBootError(failed) {
  const bar = document.createElement('div');
  bar.className = 'boot-error';
  bar.textContent = `以下模块初始化失败：${failed.join('、')}。请按 F12 打开控制台查看详细错误。`;
  document.body.prepend(bar);
}

function bootstrap() {
  const failed = [];
  const steps = [
    ['主题', initTheme],
    ['导航', initNav],
    ['子标签', initSubtabs],
    ['计划', initPlan],
    ['记录', initRecords],
    ['学习', initLearning],
    ['备忘录', initMemo],
    ['习惯', initHabits],
    ['自动化', initAutomations],
  ];
  for (const [name, fn] of steps) {
    if (safe(name, fn)) failed.push(name);
  }
  // 异步数据放最后，内部已自带隔离
  loadAiData();

  if (failed.length) showBootError(failed);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
