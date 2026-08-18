/** cak TUI 配色 token（设计稿方向 A「靛」）。换方向只改这里。品牌色只用于结构（提示符/光标），内容留灰，琥珀=要你处理，红=出错。 */
export const theme = {
  accent: '#8b97ff',      // 提示符 › 、流式光标
  fg: undefined as string | undefined,   // 正文用终端默认前景
  dim: 'gray',            // 工具行、状态线、收尾行
  attention: '#f0b25a',   // 审批块（唯一在"要你处理"时亮起的颜色）
  danger: '#ff7b6b',      // 拒绝 / 出错
  ok: '#7fd39a',          // 写入成功 / diff 加行
  rule: '─',
  spinner: ['◌', '◍', '●', '◍'],
};
export const NO_MOTION = process.argv.includes('--no-motion');
