import test from 'node:test';
import assert from 'node:assert/strict';
import { natalWheel } from '@vela-cf/astrology';
import { PortraitSummarySchema } from '@vela-cf/shared';
import { computePortraitSummary } from './portrait.js';
import { dispatchActionApi } from './action-api.js';
// Captured from the original browser calculation before migration; regression evidence, not astronomical golden data.
const fixtures = [
  {
    "input": {
      "birthDateTime": "1994-06-03T08:20",
      "latitude": 31.23,
      "longitude": 121.47,
      "timezone": "Asia/Shanghai"
    },
    "expected": {
      "sunSign": "双子",
      "moonSign": "白羊",
      "ascSign": "巨蟹",
      "epithet": "星辰信使",
      "archetype": "多维共鸣者",
      "insight": "思维灵动如风，善于把零散线索编织成清晰洞察。",
      "elementTraits": [
        "感知者 · 共情细腻的情绪调频者",
        "实干家 · 慢热却稳定的建设者"
      ],
      "elements": {
        "fire": 8,
        "earth": 33,
        "air": 8,
        "water": 50
      },
      "modalities": {
        "cardinal": 42,
        "fixed": 33,
        "mutable": 25
      },
      "signEnergy": [
        {
          "sign": "巨蟹",
          "pct": 21
        },
        {
          "sign": "双子",
          "pct": 16
        },
        {
          "sign": "白羊",
          "pct": 16
        }
      ],
      "dominantPlanets": [
        {
          "name": "太阳",
          "sign": "双子",
          "weight": 3
        },
        {
          "name": "月亮",
          "sign": "白羊",
          "weight": 3
        },
        {
          "name": "火星",
          "sign": "金牛",
          "weight": 2.5
        }
      ]
    }
  },
  {
    "input": {
      "birthDateTime": "1987-12-12T22:45",
      "latitude": -33.8688,
      "longitude": 151.2093,
      "timezone": "Australia/Sydney"
    },
    "expected": {
      "sunSign": "射手",
      "moonSign": "处女",
      "ascSign": "狮子",
      "epithet": "远方旅人",
      "archetype": "真理追光者",
      "insight": "心向辽阔边界，用探索与信念把当下活成旷野。",
      "elementTraits": [
        "行动派 · 直觉爆发的开拓者",
        "实干家 · 慢热却稳定的建设者"
      ],
      "elements": {
        "fire": 42,
        "earth": 25,
        "air": 8,
        "water": 25
      },
      "modalities": {
        "cardinal": 25,
        "fixed": 17,
        "mutable": 58
      },
      "signEnergy": [
        {
          "sign": "射手",
          "pct": 37
        },
        {
          "sign": "处女",
          "pct": 16
        },
        {
          "sign": "摩羯",
          "pct": 16
        }
      ],
      "dominantPlanets": [
        {
          "name": "月亮",
          "sign": "处女",
          "weight": 3.5
        },
        {
          "name": "太阳",
          "sign": "射手",
          "weight": 3
        },
        {
          "name": "水星",
          "sign": "射手",
          "weight": 2
        }
      ]
    }
  },
  {
    "input": {
      "birthDateTime": "2000-03-21T12:00",
      "latitude": 51.5074,
      "longitude": -0.1278,
      "timezone": "Europe/London"
    },
    "expected": {
      "sunSign": "白羊",
      "moonSign": "天秤",
      "ascSign": "巨蟹",
      "epithet": "破晓先驱",
      "archetype": "赤焰行者",
      "insight": "直觉与行动力同步点燃，擅长在混沌中率先破局。",
      "elementTraits": [
        "行动派 · 直觉爆发的开拓者",
        "思想者 · 心智灵活的社交引导者"
      ],
      "elements": {
        "fire": 42,
        "earth": 17,
        "air": 25,
        "water": 17
      },
      "modalities": {
        "cardinal": 25,
        "fixed": 42,
        "mutable": 33
      },
      "signEnergy": [
        {
          "sign": "白羊",
          "pct": 26
        },
        {
          "sign": "双鱼",
          "pct": 21
        },
        {
          "sign": "天秤",
          "pct": 16
        }
      ],
      "dominantPlanets": [
        {
          "name": "太阳",
          "sign": "白羊",
          "weight": 3.5
        },
        {
          "name": "月亮",
          "sign": "天秤",
          "weight": 3.5
        },
        {
          "name": "水星",
          "sign": "双鱼",
          "weight": 2.5
        }
      ]
    }
  }
];
test('server portrait exactly preserves original browser summaries across three natal charts',()=>{
  for(const {input,expected} of fixtures) assert.deepEqual(PortraitSummarySchema.parse(computePortraitSummary(natalWheel(input))),expected);
});
test('natal API returns calculated portrait and cannot resolve another user saved profile',async()=>{
  const input=fixtures[0].input;
  const db={collection:()=>({doc:()=>({collection:()=>({doc:()=>({get:async()=>({exists:false})})})})})} as any;
  const auth={deleteUser:async()=>{}};
  const response=await dispatchActionApi(db,auth,{method:'POST',path:'/v1/charts/natal',body:input});
  assert.deepEqual((response.body as any).portrait,fixtures[0].expected);
  await assert.rejects(()=>dispatchActionApi(db,auth,{method:'POST',path:'/v1/charts/natal',auth:{uid:'alice',token:{}},body:{subjects:[{ref:'other',profile_id:'bob-profile'}]}}),/PROFILE_NOT_FOUND/);
});
