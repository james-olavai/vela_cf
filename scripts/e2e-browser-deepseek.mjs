#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pwPaths = [
  '/home/yhvh/code/vela/frontend-v2/node_modules/playwright-core',
  '/home/yhvh/code/operon/node_modules/playwright-core',
];
const pwPath = pwPaths.find((p) => existsSync(p));
if (!pwPath) {
  throw new Error('playwright-core not found on system');
}
const { chromium } = require(pwPath);

const CHROME_BINS = [
  '/home/yhvh/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  '/usr/bin/google-chrome',
];
const executablePath = CHROME_BINS.find((p) => existsSync(p));

const BASE_URL = process.env.WEB_BASE_URL || 'http://127.0.0.1:3126';
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  '/home/yhvh/.gemini/antigravity-cli/brain/178f7f9e-d2f5-47c8-b9a6-a1790a53e2aa';

async function addProfileInSubpage(page, { name, entity = '个人', city, gender }) {
  await page.locator('[data-testid="pm-add"]').click();
  const form = page.locator('[data-testid="pm-form"]');
  await form.waitFor({ state: 'visible', timeout: 5000 });
  if (entity !== '个人') {
    await form.locator(`button:has-text("${entity}")`).click();
  }
  await form.locator('input[placeholder*="称呼"], input[placeholder*="名称"]').fill(name);
  await form.locator('input[placeholder="出生城市 / 地点"]').fill(city);
  await form.locator('button:has-text("搜")').click();
  const cityOption = form.locator(`button:has-text("${city}")`).first();
  await cityOption.waitFor({ state: 'visible', timeout: 8000 });
  await cityOption.click();
  if (gender) {
    await form.locator('select').selectOption(gender);
  }
  await form.locator('button[type="submit"]').click();
  await form.waitFor({ state: 'detached', timeout: 8000 });
}

async function runBrowserE2E() {
  console.log(`[browser-e2e] Launching headless Chromium (${executablePath})`);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    // =========================================================================
    // 1. Visitor Flow: Bottom-Left Auth Modal + Left Subscription Icon/Subpage
    //    + Expanded Large Icons + Profile Manager Subpage + Draft Portrait
    // =========================================================================
    const visitorCtx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const vPage = await visitorCtx.newPage();

    console.log(`[browser-e2e] 1/3 Testing Visitor UI & Auth/Subscription separation at ${BASE_URL}/`);
    await vPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });

    // Click bottom-left user avatar icon in collapsed rail -> strictly Auth modal (no Subscription tab)
    const bottomLeftLoginBtn = vPage.locator('[data-testid="rail-btn-auth"]');
    await bottomLeftLoginBtn.waitFor({ state: 'visible', timeout: 10000 });
    await bottomLeftLoginBtn.click();

    const modal = vPage.locator('[role="dialog"][aria-labelledby="settings-title"]');
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    const modalText = await modal.innerText();
    assert.ok(modalText.includes('使用 Google 账号继续并开始解读'), 'Google login button must be visible');
    assert.ok(modalText.includes('邮箱登录'), 'Email login tab must be visible');
    assert.ok(modalText.includes('注册账号'), 'Email register tab must be visible');
    assert.ok(modalText.includes('免密邮件链接'), 'Email magic-link tab must be visible');
    assert.ok(!modalText.includes('取消订阅 / 管理账单'), 'Subscription UI must not be mixed into avatar auth modal');

    await modal.locator('button:has-text("注册账号")').click();
    await modal.locator('input[type="email"]').fill('astro-test@vela.local');
    await modal.locator('input[type="password"]').fill('VelaPass123!');
    await vPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_1_auth_modal.png` });
    await modal.locator('button[aria-label="关闭弹窗"]').click();
    console.log('[browser-e2e] ✓ Bottom-left avatar strictly opens Auth/Account modal');

    // Click left rail Subscription & Quota icon -> opens dedicated Subscription subpage
    await vPage.locator('[data-testid="rail-btn-subscription"]').click();
    const subPage = vPage.locator('[data-testid="subscription-subpage"]');
    await subPage.waitFor({ state: 'visible', timeout: 5000 });
    const subText = await subPage.innerText();
    assert.ok(subText.includes('最多存 5 个档案'), 'Subscription subpage must show Go 5-profile limit');
    assert.ok(subText.includes('最多存 50 个档案'), 'Subscription subpage must show Pro 50-profile limit');
    await vPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_2_subscription_subpage.png` });
    await vPage.locator('[data-testid="subpage-back"]').click();
    console.log('[browser-e2e] ✓ Left Subscription icon & subpage verified');

    // Expand sidebar -> verify large icons + bottom-left login bar + navigate to Profile Manager subpage
    await vPage.locator('button[aria-label="展开侧栏"]').first().click();
    const vAside = vPage.locator('aside').first();
    await vAside.locator('[data-testid="sidebar-auth-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await vAside.locator('[data-testid="sidebar-nav-subscription"]').waitFor({ state: 'visible', timeout: 5000 });
    await vAside.locator('[data-testid="sidebar-nav-profiles"]').click();

    const pmSubpage = vPage.locator('[data-testid="profile-manager"]');
    await pmSubpage.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await pmSubpage.locator('[data-testid="pm-quota"]').innerText()).includes('0 / 1 容量'));

    // Add visitor draft profile in Profile Manager Subpage
    await addProfileInSubpage(vPage, { name: '星河访客', city: '上海', gender: 'female' });
    assert.ok((await pmSubpage.locator('[data-testid="pm-quota"]').innerText()).includes('1 / 1 容量'));

    // Verify quick-select list in sidebar shows 星河访客 with ★
    const quickListText = await vAside.locator('[data-testid="sidebar-quick-profiles"]').innerText();
    assert.ok(quickListText.includes('★') && quickListText.includes('星河访客'), 'Sidebar quick list must display ★ primary profile');

    // Return to conversation & open Natal Portrait Modal
    await vPage.locator('[data-testid="subpage-back"]').click();
    await vAside.locator('[data-testid="sidebar-nav-portrait"]').click();
    const portraitDialog = vPage.locator('[role="dialog"][aria-labelledby="natal-portrait-title"]');
    await portraitDialog.waitFor({ state: 'visible', timeout: 8000 });
    await portraitDialog.getByText('本月能量日历').waitFor({ state: 'visible', timeout: 15000 });
    await portraitDialog.locator('button[aria-label="关闭个人星盘画像"]').click();
    console.log('[browser-e2e] ✓ Profile Manager Subpage, Quick Select, and Portrait verified');

    // Type a question as visitor -> verify Auth modal intercepts with pending question
    await vPage.locator('textarea').fill('我今年的事业转折点在什么时候？');
    await vPage.locator('button[aria-label="发送"]').click();
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await modal.innerText()).includes('我今年的事业转折点在什么时候？'), 'Auth modal must show pending question');
    await visitorCtx.close();

    // =========================================================================
    // 2. Go Tier Quota Check (5 profiles)
    // =========================================================================
    const goCtx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const gPage = await goCtx.newPage();
    console.log(`[browser-e2e] 2/3 Checking Go tier 5-profile quota at ${BASE_URL}/?e2e=1&tier=go`);
    await gPage.goto(`${BASE_URL}/?e2e=1&tier=go`, { waitUntil: 'domcontentloaded' });
    await gPage.locator('[data-testid="rail-btn-profiles"]').click();
    const goQuota = await gPage.locator('[data-testid="pm-quota"]').innerText();
    assert.ok(goQuota.includes('0 / 5 容量'), `Expected Go tier 0 / 5 容量, got: ${goQuota}`);
    await goCtx.close();
    console.log('[browser-e2e] ✓ Go tier 5-profile capacity verified');

    // =========================================================================
    // 3. Pro Tier (50 profiles) + Star/Checkbox Selection + DeepSeek AI Chat
    // =========================================================================
    const proCtx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const pPage = await proCtx.newPage();
    console.log(`[browser-e2e] 3/3 Testing Pro 50-profile + Star/Checkbox + AI chat at ${BASE_URL}/?e2e=1&tier=pro`);
    await pPage.goto(`${BASE_URL}/?e2e=1&tier=pro`, { waitUntil: 'domcontentloaded' });

    await pPage.locator('button[aria-label="展开侧栏"]').first().click();
    const pAside = pPage.locator('aside').first();
    await pAside.locator('[data-testid="sidebar-nav-profiles"]').click();
    const proPm = pPage.locator('[data-testid="profile-manager"]');
    assert.ok((await proPm.locator('[data-testid="pm-quota"]').innerText()).includes('0 / 50 容量'), 'Pro must show 50 capacity');

    await addProfileInSubpage(pPage, { name: '林辰', city: '上海', gender: 'female' });
    await addProfileInSubpage(pPage, { name: 'Vela AI', entity: '公司', city: '新加坡' });
    assert.ok((await pAside.innerText()).includes('合盘 2/4 人'), 'Synastry count must be exactly 2/4 after adding 2 profiles');
    await pPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_3_profile_manager_pro.png` });

    // Verify ★ primary on 林辰 & ☑ synastry checkbox on Vela AI
    const items = proPm.locator('[data-testid="pm-item"]');
    assert.equal(await items.count(), 2, 'Should show 2 saved profiles');
    const firstItemText = await items.nth(0).innerText();
    const secondItemText = await items.nth(1).innerText();
    assert.ok(firstItemText.includes('林辰') && firstItemText.includes('主档案'), '林辰 must be primary ★');
    assert.ok(secondItemText.includes('Vela AI') && secondItemText.includes('合盘人已选'), 'Vela AI must be ☑ synastry partner');

    // Quick test switching ★ to Vela AI in sidebar, then back to 林辰
    const quickStars = pAside.locator('[data-testid="sidebar-quick-profiles"] [data-testid="sidebar-ps-star"]');
    await quickStars.nth(1).click();
    assert.ok((await items.nth(0).innerText()).includes('Vela AI'), 'Quick-select ★ must promote Vela AI to primary');
    await pAside.locator('[data-testid="sidebar-quick-profiles"] [data-testid="sidebar-ps-star"]').nth(1).click();
    assert.ok((await items.nth(0).innerText()).includes('林辰'), 'Quick-select ★ must restore 林辰 as primary');
    await pPage.locator('[data-testid="subpage-back"]').click();

    await pPage.locator('button:has-text("全维")').click();
    const prompt = '请结合法达星限、龙首盘与公司十宫事业盘，分析林辰与 Vela AI 公司的合盘契合度与近期运势窗口，并输出 vela-ui 评分卡。';
    await pPage.locator('textarea').fill(prompt);
    await pPage.locator('button[aria-label="发送"]').click();

    console.log('[browser-e2e] Waiting for AI tool-calling & streaming response...');
    await pPage.locator('span:has-text("✓")').first().waitFor({ state: 'visible', timeout: 30000 });
    await pPage.locator('button[aria-label="停止生成"]').waitFor({ state: 'detached', timeout: 90000 });
    await pPage.locator('button[aria-label="发送"]').waitFor({ state: 'visible', timeout: 10000 });

    const mainText = await pPage.locator('main').innerText();
    assert.ok(mainText.length > 200, `Streamed response must be >200 chars, got ${mainText.length}`);
    assert.ok(!mainText.includes('DSML'), 'Streamed response must not leak raw DSML tags');

    // Verify top header & HistorySearchModal show question summary instead of plain profile name
    const headerTitle = await pPage.locator('main header span').first().innerText();
    assert.ok(
      headerTitle.includes('合盘契合度') && !headerTitle.startsWith('合盘 · 林辰'),
      `Header session title must summarize question instead of profile name, got: ${headerTitle}`,
    );

    await pAside.locator('[data-testid="sidebar-nav-history"]').click();
    const historyDialog = pPage.locator('[role="dialog"][aria-labelledby="history-search-title"]');
    await historyDialog.waitFor({ state: 'visible', timeout: 5000 });
    const historyText = await historyDialog.innerText();
    assert.ok(historyText.includes('合盘契合度'), 'History modal title must show question summary');
    assert.ok(historyText.includes('多人合盘 · 林辰 × Vela AI'), 'History modal subtitle must still show profile names');
    await historyDialog.locator('button[aria-label="关闭搜索"]').click();

    await pPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_4_pro_chat.png`, fullPage: false });
    await proCtx.close();
    console.log('[browser-e2e] ✓ All browser E2E checks passed!');
  } finally {
    await browser.close();
  }
}

await runBrowserE2E();
