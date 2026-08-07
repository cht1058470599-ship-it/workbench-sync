// 主题配置系统：亮/暗切换 + 开发者配置视图（逐元素调色）
import { loadData, saveData } from './storage.js';

const VARS = [
  { name: '--color-bg', label: '主背景' },
  { name: '--color-bg-secondary', label: '次背景' },
  { name: '--color-bg-nav', label: '导航背景' },
  { name: '--color-text', label: '主文字' },
  { name: '--color-text-secondary', label: '次文字' },
  { name: '--color-border', label: '边框' },
  { name: '--color-accent', label: '强调色' },
  { name: '--color-accent-bg', label: '强调背景' },
];

export function initTheme() {
  const mode = loadData('theme_mode', 'dark');
  applyMode(mode);
  applyCustomColors();
  buildColorGrid();

  document.getElementById('themeToggle').addEventListener('click', toggleMode);
  document.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  document.getElementById('themeSave').addEventListener('click', saveColors);
  document.getElementById('themeReset').addEventListener('click', resetColors);
}

function applyMode(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  const label = document.getElementById('themeLabel');
  if (label) label.textContent = mode === 'dark' ? '暗色' : '亮色';
  document.querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function setMode(mode) {
  saveData('theme_mode', mode);
  applyMode(mode);
  buildColorGrid();
}

function toggleMode() {
  const cur = loadData('theme_mode', 'dark');
  setMode(cur === 'light' ? 'dark' : 'light');
}

function applyCustomColors() {
  const custom = loadData('theme_colors', {});
  Object.entries(custom).forEach(([k, v]) => {
    document.documentElement.style.setProperty(k, v);
  });
}

function currentVarColor(name) {
  const custom = loadData('theme_colors', {});
  if (custom[name]) return custom[name];
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || '#ffffff';
}

function buildColorGrid() {
  const grid = document.getElementById('colorGrid');
  if (!grid) return;
  grid.innerHTML = '';
  VARS.forEach(v => {
    const cur = currentVarColor(v.name);
    const item = document.createElement('div');
    item.className = 'color-item';
    item.innerHTML =
      `<input type="color" data-var="${v.name}" value="${cur}" />
       <label>${v.label}</label>`;
    grid.appendChild(item);
  });
  grid.addEventListener('input', onColorInput);
}

function onColorInput(e) {
  if (e.target.type === 'color') {
    document.documentElement.style.setProperty(e.target.dataset.var, e.target.value);
  }
}

function saveColors() {
  const custom = {};
  document.querySelectorAll('#colorGrid input[type="color"]').forEach(inp => {
    custom[inp.dataset.var] = inp.value;
  });
  saveData('theme_colors', custom);
  flash('themeSave', '已保存');
}

function resetColors() {
  saveData('theme_colors', {});
  VARS.forEach(v => document.documentElement.style.removeProperty(v.name));
  buildColorGrid();
  flash('themeReset', '已重置');
}

function flash(id, text) {
  const el = document.getElementById(id);
  const orig = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = orig; }, 1200);
}
