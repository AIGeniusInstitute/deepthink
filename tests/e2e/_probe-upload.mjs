/**
 * 一次性探针：点「上传文档」到底有没有把点击转发给 <input type=file>。
 * 只看 filechooser 事件有没有触发，不做任何上传。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.DT_BASE || 'http://127.0.0.1:9999';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '';
const KB_ID = process.env.DT_KB || '40585997-0346-4468-bd71-8522134f7a1e';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

// 在页面里装监听：input 上有没有收到 click
await page.addInitScript(() => {
  window.__probe = { inputClicks: 0, btnClicks: 0 };
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('[data-testid="kb-upload-button"]')) window.__probe.btnClicks++;
      if (t instanceof HTMLInputElement && t.type === 'file') window.__probe.inputClicks++;
    },
    true, // capture，label 转发前就能看到
  );
});

// 登录
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[type="text"], input[name="username"]').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.getByRole('button', { name: /登录/ }).click();
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });

await page.goto(`${BASE}/knowledge-bases/${KB_ID}`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });

let chooser = false;
page.on('filechooser', () => {
  chooser = true;
});

const btn = page.getByTestId('kb-upload-button');
console.log('按钮可见:', await btn.isVisible());
console.log('按钮 tag/类型:', await btn.evaluate((el) => `${el.tagName} / ${el.className.slice(0, 60)}`));
console.log(
  '按钮的祖先 label:',
  await btn.evaluate((el) => {
    const l = el.closest('label');
    if (!l) return '(无 label 祖先)';
    return `label 内 labelable 元素顺序: ${[...l.querySelectorAll('button,input,select,textarea')]
      .map((e) => e.tagName + (e.type ? `[${e.type}]` : ''))
      .join(' → ')}`;
  }),
);

await btn.click();
await page.waitForTimeout(2000);

console.log('filechooser 事件:', chooser ? '✅ 触发了' : '❌ 没触发');
console.log('页面内计数:', JSON.stringify(await page.evaluate(() => window.__probe)));

// 对照：直接点隐藏 input 本身
await page.evaluate(() => {
  document.querySelector('[data-testid="kb-upload-input"]').click();
});
await page.waitForTimeout(1000);
console.log('直接点 input 后 filechooser:', chooser ? '✅ 触发过' : '❌ 从未触发');

await browser.close();
