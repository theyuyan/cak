/** cak TUI 配色 token。多套主题（设计稿方向 A 靛 / B 铜 / C 苔 / mono 单色）；品牌色只用于结构（提示符/光标），内容留灰，琥珀=要你处理，红=出错。
 *  选择：/theme <name> 热切 → 写 ~/.cak/config.json {theme}；--theme <name> 临时；--no-motion 关动效。 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export interface Theme { name: string; label: string; accent: string | undefined; dim: string; attention: string; danger: string; ok: string; rule: string; spinner: string[] }
export const THEMES: Record<string, Theme> = {
  indigo: { name: 'indigo', label: 'A 靛（默认）', accent: '#8b97ff', dim: 'gray', attention: '#f0b25a', danger: '#ff7b6b', ok: '#7fd39a', rule: '─', spinner: ['◌', '◍', '●', '◍'] },
  bronze: { name: 'bronze', label: 'B 铜', accent: '#c98a4b', dim: 'gray', attention: '#8b97ff', danger: '#ff7b6b', ok: '#7fd39a', rule: '─', spinner: ['◌', '◍', '●', '◍'] },
  moss:   { name: 'moss', label: 'C 苔', accent: '#6fbf8e', dim: 'gray', attention: '#f0b25a', danger: '#ff7b6b', ok: '#9fd8b0', rule: '─', spinner: ['◌', '◍', '●', '◍'] },
  mono:   { name: 'mono', label: '单色（无彩色终端 / 截图）', accent: undefined, dim: 'gray', attention: 'white', danger: 'white', ok: 'white', rule: '─', spinner: ['.', 'o', 'O', 'o'] },
};
export const CONFIG_FILE = path.join(os.homedir(), '.cak', 'config.json');
export function readConfig(): Record<string, unknown> { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
export function writeConfig(patch: Record<string, unknown>) { const c = { ...readConfig(), ...patch }; fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 1) + '\n'); return c; }
export function pickTheme(name?: string): Theme { const n = name ?? (readConfig()['theme'] as string | undefined) ?? 'indigo'; return THEMES[n] ?? THEMES['indigo']!; }
export const NO_MOTION = process.argv.includes('--no-motion');
