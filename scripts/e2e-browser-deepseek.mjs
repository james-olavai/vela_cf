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
  '/home/yhvh/.gemini/antigravity-cli/brain/69c07a91-6fcd-4eda-8273-3d1abb56677b';

async function runBrowserE2E() {
  console.log(`[browser-e2e] Launching headless Chromium (${executablePath})`);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  try {
    // =========================================================================
    // 1. Visitor Flow: Bottom-Left Login Entry + Email Auth Tabs + Draft Portrait
    // =========================================================================
    const visitorCtx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const vPage = await visitorCtx.newPage();

    console.log(`[browser-e2e] 1/2 Testing Visitor Mode at ${BASE_URL}/`);
    await vPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });

    // Click bottom-left user avatar icon in collapsed rail
    const bottomLeftLoginBtn = vPage.locator('button[aria-label="登录 / 注册账号"]');
    await bottomLeftLoginBtn.waitFor({ state: 'visible', timeout: 10000 });
    await bottomLeftLoginBtn.click();

    // Verify AuthGateModal opened with Google + 3 Email modes
    const modal = vPage.locator('[role="dialog"][aria-labelledby="auth-gate-title"]');
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    const modalText = await modal.innerText();
    assert.ok(modalText.includes('使用 Google 账号继续并开始解读'), 'Google login button must be visible');
    assert.ok(modalText.includes('邮箱登录'), 'Email login tab must be visible');
    assert.ok(modalText.includes('注册账号'), 'Email register tab must be visible');
    assert.ok(modalText.includes('免密邮件链接'), 'Email magic-link tab must be visible');
    assert.ok(modalText.includes('忘记密码？发送重置邮件'), 'Reset password button must be visible');

    // Switch through email tabs and fill email/password
    await modal.locator('button:has-text("注册账号")').click();
    await modal.locator('input[type="email"]').fill('astro-test@vela.local');
    await modal.locator('input[type="password"]').fill('VelaPass123!');
    await vPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_1_auth_modal.png` });
    console.log('[browser-e2e] ✓ Bottom-left login entry & Email Auth tabs verified');

    // Close modal and open sidebar to verify expanded bottom-left login bar + add draft profile
    await modal.locator('button[aria-label="关闭弹窗"]').click();
    await vPage.locator('button[aria-label="展开侧栏"]').click();
    const sidebarLoginBar = vPage.locator('aside').getByText('登录 / 注册账号').first();
    await sidebarLoginBar.waitFor({ state: 'visible', timeout: 5000 });

    // Add visitor draft profile
    await vPage.getByText('+ 点击添加出生信息').first().click();
    await vPage.locator('input[placeholder*="称呼"]').first().fill('星河访客');
    await vPage.locator('input[placeholder="出生城市 / 地点"]').first().fill('上海');
    await vPage.locator('button:has-text("搜")').first().click();
    const cityOption = vPage.locator('button:has-text("上海")').first();
    await cityOption.waitFor({ state: 'visible', timeout: 8000 });
    await cityOption.click();
    await vPage.locator('form select').first().selectOption('female');
    await vPage.locator('button:has-text("保存")').first().click();

    // Open Natal Portrait Modal & verify SVG natal wheel + energy calendar
    await vPage.getByText('个人星盘画像').first().click();
    const portraitDialog = vPage.locator('[role="dialog"][aria-labelledby="natal-portrait-title"]');
    await portraitDialog.waitFor({ state: 'visible', timeout: 8000 });
    await portraitDialog.getByText('本月能量日历').waitFor({ state: 'visible', timeout: 15000 });
    const portraitText = await portraitDialog.innerText();
    assert.ok(portraitText.includes('太阳'), 'Portrait must render Sun sign');
    assert.ok(portraitText.includes('能量日历'), 'Portrait must render Energy Calendar');
    await vPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_2_natal_portrait.png` });
    console.log('[browser-e2e] ✓ Visitor draft profile & Natal Portrait Modal verified');

    await portraitDialog.locator('button[aria-label="关闭个人星盘画像"]').click();

    // Type a question as visitor -> verify AuthGateModal intercepts with pending question
    const composerInput = vPage.locator('textarea');
    await composerInput.fill('我今年的事业转折点在什么时候？');
    await vPage.locator('button[aria-label="发送"]').click();
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    const handoffText = await modal.innerText();
    assert.ok(
      handoffText.includes('我今年的事业转折点在什么时候？'),
      'AuthGateModal must display pending question handoff',
    );
    await visitorCtx.close();
    console.log('[browser-e2e] ✓ Visitor question handoff interception verified');

    // =========================================================================
    // 2. Pro Full-Depth Mode: Real DeepSeek API + Multi-Tool MCP + Streaming UI
    // =========================================================================
    const proCtx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const pPage = await proCtx.newPage();

    console.log(`[browser-e2e] 2/2 Testing Pro Full-Depth + Real DeepSeek API at ${BASE_URL}/?e2e=1&tier=pro`);
    await pPage.goto(`${BASE_URL}/?e2e=1&tier=pro`, { waitUntil: 'domcontentloaded' });

    // Open sidebar and add 2 profiles (Personal + Company) for multi-entity synastry & deep tools
    await pPage.locator('button[aria-label="展开侧栏"]').click();
    await pPage.getByText('+ 点击添加出生信息').first().click();
    await pPage.locator('input[placeholder*="称呼"]').first().fill('林辰');
    await pPage.locator('input[placeholder="出生城市 / 地点"]').first().fill('上海');
    await pPage.locator('button:has-text("搜")').first().click();
    await pPage.locator('button:has-text("上海")').first().click();
    await pPage.locator('form select').first().selectOption('female');
    await pPage.locator('button:has-text("保存")').first().click();

    // Add second profile (Company entity)
    await pPage.locator('button:has-text("+ 添加")').first().click();
    await pPage.locator('button:has-text("公司")').first().click();
    await pPage.locator('input[placeholder*="名称"]').first().fill('Vela AI');
    await pPage.locator('input[placeholder="出生城市 / 地点"]').first().fill('新加坡');
    await pPage.locator('button:has-text("搜")').first().click();
    await pPage.locator('button:has-text("新加坡")').first().click();
    await pPage.locator('button:has-text("保存")').first().click();

    // Switch Pro depth selector to "全维" (deep)
    await pPage.locator('button:has-text("全维")').click();

    // Send real question to trigger DeepSeek tool-calling + streaming
    const prompt =
      '请结合法达星限、龙首盘与公司十宫事业盘，分析林辰与 Vela AI 公司的合盘契合度与近期运势窗口，并输出 vela-ui 评分卡。';
    await pPage.locator('textarea').fill(prompt);
    await pPage.locator('button[aria-label="发送"]').click();

    console.log('[browser-e2e] Waiting for real DeepSeek tool-calling & streaming response...');
    // Wait for tool chips to appear
    await pPage.locator('span:has-text("✓")').first().waitFor({ state: 'visible', timeout: 30000 });

    // Wait for streaming to finish ("停止生成" button disappears and "发送" button reappears)
    await pPage.locator('button[aria-label="停止生成"]').waitFor({ state: 'detached', timeout: 90000 });
    await pPage.locator('button[aria-label="发送"]').waitFor({ state: 'visible', timeout: 10000 });

    const toolBadges = await pPage.locator('span:has-text("✓")').allInnerTexts();
    console.log('[browser-e2e] Rendered tool badges:', toolBadges.join(' | '));
    assert.ok(toolBadges.length >= 6, `Expected >=6 tool badges, got ${toolBadges.length}`);

    const mainText = await pPage.locator('main').innerText();
    assert.ok(mainText.length > 400, `Streamed DeepSeek response must be >400 chars, got ${mainText.length}`);
    assert.ok(!mainText.includes('DSML'), 'Streamed response must not leak raw DSML tags');
    assert.ok(!mainText.includes('正在推演解读'), 'Streaming indicator must be gone after completion');

    await pPage.screenshot({ path: `${ARTIFACT_DIR}/e2e_3_deepseek_pro_chat.png`, fullPage: false });
    await proCtx.close();
    console.log('[browser-e2e] ✓ Real DeepSeek tool-calling + SSE streaming + UI rendering passed!');
  } finally {
    await browser.close();
  }
}

await runBrowserE2E();
