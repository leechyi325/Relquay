// 由亮色样式自动生成暗色主题覆盖层：src/dark.generated.css（构建前运行，无需手写 439 处颜色）。
import fs from 'node:fs';
import postcss from 'postcss';

const FILES = ['style.css', 'workspace.css', 'usage-notices.css', 'sessions.css'];
const COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b|rgba?\([^)]*\)/gi;
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function parse(text) {
  if (text[0] === '#') {
    let h = text.slice(1); if (h.length <= 4) h = [...h].map(c => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const parts = text.replace(/rgba?\(|\)/g, '').split(/[\s,/]+/).filter(Boolean).map(v => v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}
function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1)); let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
function fromHsl(h, s, l, a) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b) + (a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : '');
}
const roles = {
  background: (l, s) => l >= 0.7 ? [0.07 + (1 - l) * 0.35, s * 0.4] : null,
  border: (l, s) => l >= 0.7 ? [0.13 + (1 - l) * 0.5, s * 0.5] : null,
  text: (l, s) => l <= 0.45 ? [0.97 - l * 0.8, s * 0.6] : null,
};
const roleOf = prop => /^background/.test(prop) ? 'background' : /^(border|outline)/.test(prop) ? 'border' : /^(color|fill|stroke|caret-color)$/.test(prop) ? 'text' : null;
function convert(value, role) {
  let changed = false;
  const out = value.replace(COLOR, match => {
    const rgb = parse(match); if ([rgb.r, rgb.g, rgb.b].some(Number.isNaN)) return match;
    const { h, s, l } = toHsl(rgb), next = roles[role](l, s); if (!next) return match;
    changed = true; return fromHsl(h, clamp(next[1]), clamp(next[0]), rgb.a);
  });
  return changed ? out : null;
}

const prefix = 'html[data-theme=dark] ';
const out = [];
function walk(container, emit) {
  container.each(node => {
    if (node.type === 'atrule') {
      if (/keyframes|font-face/.test(node.name)) return;
      const inner = []; walk(node, rule => inner.push(rule));
      if (inner.length) emit(`@${node.name} ${node.params}{${inner.join('')}}`);
    } else if (node.type === 'rule') {
      if (node.selector.split(',').every(s => /^\s*:root\b/.test(s))) return;
      const decls = [];
      node.walkDecls(decl => {
        const role = roleOf(decl.prop); if (!role) return;
        const value = convert(decl.value, role); if (value) decls.push(`${decl.prop}:${value}${decl.important ? '!important' : ''}`);
      });
      if (decls.length) emit(node.selectors.filter(s => !/^:root\b/.test(s.trim())).map(s => prefix + s.trim().replace(/^html\s+|^body\s+/, '')).join(',') + '{' + decls.join(';') + '}');
    }
  });
}
for (const file of FILES) walk(postcss.parse(fs.readFileSync('src/' + file, 'utf8')), rule => out.push(rule));

const vars = '--ink:#e4e8ea;--muted:#8d9a9e;--line:#2a343a;--paper:#1a2025;--accent:#e08a63;--soft:#242c32;';
const base = `html[data-theme=dark]{color-scheme:dark;${vars}background:#12171b;color:#e4e8ea}html[data-theme=dark] body{background:#12171b}html[data-theme=dark] img{opacity:.92}html[data-theme=dark] input,html[data-theme=dark] textarea,html[data-theme=dark] select{color:#e4e8ea}html[data-theme=dark] ::placeholder{color:#7b878c}`;
fs.writeFileSync('src/dark.generated.css', '/* 由 scripts/make-dark.mjs 生成，请勿手改 */\n' + base + '\n' + out.join('\n') + '\n');
console.log('dark.generated.css:', out.length, 'rules');
