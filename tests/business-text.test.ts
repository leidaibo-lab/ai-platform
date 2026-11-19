import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBusinessText } from '../web/src/components/business-text.js';

test('识别产品文档中的状态流转、字段分组与顺序流程', () => {
  assert.deepEqual(parseBusinessText('待初筛\n  └─ 初筛通过 → 待邀约\n\n待邀约\n└─ 暂无回应 → 待邀约\n'), {
    kind: 'transitions', rows: [{ from: '待初筛', action: '初筛通过', to: '待邀约' }, { from: '待邀约', action: '暂无回应', to: '待邀约' }],
  });
  assert.deepEqual(parseBusinessText('初筛\r\n- 状态：待处理\r\n\r\n邀约\r\n- 更新时间'), {
    kind: 'fields', groups: [{ title: '初筛', fields: ['状态：待处理'] }, { title: '邀约', fields: ['更新时间'] }],
  });
  assert.deepEqual(parseBusinessText('角色切换\n→ 查看待处理项\n→ 完成初筛\n'), {
    kind: 'steps', steps: ['角色切换', '查看待处理项', '完成初筛'],
  });
});

test('混合格式及多段箭头保留原文和缩进', () => {
  for (const text of ['  说明\n\n  保留缩进\n', '待初筛\n└─ 初筛通过 → 待邀约 → 已接受', '分组\n- 字段\n补充说明']) {
    assert.deepEqual(parseBusinessText(text), { kind: 'plain', text });
  }
});
