import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { OutlineGateResult } from '../types';

/**
 * 质量门列表（共用组件，原 StageOutline 内部实现）：
 * 全过 → 绿色横幅；有未过 → 红色横幅 + ✗ 详情红字。
 * source 标明门结果的口径来源：引擎 CLI 原样输出 / 浏览器内移植版。
 */
const GatePanel: React.FC<{ gates: OutlineGateResult[] | null | undefined; source?: 'engine' | 'browser' }> = ({ gates, source }) => {
  if (!gates || gates.length === 0) return null;
  const passed = gates.every((g) => g.ok);
  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${passed ? 'border-[var(--success)]/40 bg-[var(--success)]/5' : 'border-[#d1543c]/50 bg-[#d1543c]/5'}`}>
      <div className="flex items-center gap-2 text-xs font-medium">
        {passed
          ? <><CheckCircle2 className="w-4 h-4 text-[var(--success)]" /><span className="text-[var(--success)]">全部质量门通过</span></>
          : <><AlertTriangle className="w-4 h-4 text-[#d1543c]" /><span className="text-[#d1543c]">有未过项——把 ✗ 详情交给回炉修复</span></>}
        {source && <span className="text-[10px] font-mono text-[var(--text-muted)] ml-auto">{source === 'engine' ? '来源：技能 CLI 原样输出' : '来源：浏览器内移植版'}</span>}
      </div>
      {gates.map((g, i) => (
        <div key={`${g.id}-${i}`} className="flex gap-2 text-xs leading-relaxed">
          {g.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-[var(--success)] flex-shrink-0" />
                : <XCircle className="w-3.5 h-3.5 mt-0.5 text-[#d1543c] flex-shrink-0" />}
          <span className={g.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)] font-medium'}>
            {g.label}{g.detail ? <span className="text-[#d1543c]"> — {g.detail}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
};

export default GatePanel;
