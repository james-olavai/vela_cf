import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTurnCapabilities, ALL_34_TOOLS } from './skills.js';
const timeTools = ['transitEvents', 'solarReturn', 'lunarReturn', 'secondaryProgression', 'solarArc', 'energyCalendar', 'transitSnapshot', 'planetaryReturn'];
for (const tier of ['go', 'pro'] as const) {
  test(`${tier}: 机会或最近发生的关系问题不自动变成时间预测`, () => {
    for (const message of ['现在有一个接手团队的机会，我应该接受吗？', '他最近不回我信息，是不是已经不爱我了？', '近期工作压力很大，我应该怎么分配精力？', '我工作才半年、没带过人，刚有一个接手陌生团队的机会，应该接下吗？', '我刚入职几个月，怎样与同事协作？']) {
      const routed = routeTurnCapabilities({ tier, depth: 'balanced', message, profileCount: 1, sessionAllowedTools: ALL_34_TOOLS });
      assert.ok(!routed.routedTools.some(t => timeTools.includes(t)), `${message}: ${routed.routedTools.join(',')}`);
    }
  });
  test(`${tier}: 明确时段或运势问题仍开放时间工具`, () => {
    for (const message of ['未来半年的事业有什么变化？', '最近运势如何？', '本月行运有哪些重要时间窗口？', '接下来几个月运势如何？']) {
      const routed = routeTurnCapabilities({ tier, depth: 'balanced', message, profileCount: 1, sessionAllowedTools: ALL_34_TOOLS });
      assert.ok(routed.routedTools.includes('transitEvents'), message);
    }
  });
}
