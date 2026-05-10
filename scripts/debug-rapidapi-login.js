/**
 * Quick debug script — opens RapidAPI login visibly so you can see what's happening.
 * Run with: node scripts/debug-rapidapi-login.js your@email.com yourpassword
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const [,, email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/debug-rapidapi-login.js <email> <password>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    headless: false,  // VISIBLE — watch what happens
    slowMo: 500,      // Slow down so you can see each step
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('Navigating to RapidAPI login...');
  await page.goto('https://rapidapi.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  console.log('Page title:', await page.title());
  console.log('URL:', page.url());

  // Log all visible inputs
  const inputs = await page.locator('input').all();
  console.log(`\nFound ${inputs.length} input(s):`);
  for (const input of inputs) {
    const type = await input.getAttribute('type').catch(() => '?');
    const name = await input.getAttribute('name').catch(() => '?');
    const placeholder = await input.getAttribute('placeholder').catch(() => '?');
    const visible = await input.isVisible().catch(() => false);
    console.log(`  <input type="${type}" name="${name}" placeholder="${placeholder}" visible=${visible}>`);
  }

  // Log all visible buttons
  const buttons = await page.locator('button').all();
  console.log(`\nFound ${buttons.length} button(s):`);
  for (const btn of buttons) {
    const text = (await btn.textContent().catch(() => '')).trim();
    const type = await btn.getAttribute('type').catch(() => '?');
    const visible = await btn.isVisible().catch(() => false);
    if (text || visible) console.log(`  <button type="${type}" visible=${visible}> "${text}"`);
  }

  // Wait for and dismiss cookie banner
  try {
    await page.locator('button:has-text("Reject All"), button:has-text("Accept All")').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('button:has-text("Reject All")').first().click();
    console.log('Dismissed cookie banner');
    await page.waitForTimeout(1500);
  } catch { console.log('No cookie banner found'); }

  // Try to fill in credentials
  console.log(`\nAttempting login as ${email}...`);
  try {
    const emailInput = page.locator('input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Email field visible: true');
    await emailInput.click();
    await emailInput.pressSequentially(email, { delay: 60 });
    const typedEmail = await emailInput.inputValue();
    console.log(`Typed email — field now contains: "${typedEmail}"`);

    const passInput = page.locator('input[type="password"]').first();
    const passVisible = await passInput.isVisible({ timeout: 3000 }).catch(() => false);
    console.log('Password field visible:', passVisible);
    if (passVisible) {
      await passInput.click();
      await passInput.pressSequentially(password, { delay: 60 });
      const typedPass = await passInput.inputValue();
      console.log(`Typed password — field now contains: "${typedPass}"`);
      console.log(`(Expected: "${password}")`)
    }

    // Screenshot before submit
    await page.screenshot({ path: '/tmp/rapidapi-before-submit.png' });
    console.log('Screenshot saved: /tmp/rapidapi-before-submit.png');

    const submitBtn = page.locator('button[type="submit"], button:has-text("Log In"), button:has-text("Sign In"), button:has-text("Continue")').first();
    const submitVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log('Submit button visible:', submitVisible);
    if (submitVisible) {
      await submitBtn.click();
      console.log('Clicked submit — waiting 8s...');
      await page.waitForTimeout(8000);
    }

    console.log('\nFinal URL:', page.url());
    await page.screenshot({ path: '/tmp/rapidapi-after-submit.png' });
    console.log('Screenshot saved: /tmp/rapidapi-after-submit.png');

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: '/tmp/rapidapi-debug-error.png' }).catch(() => {});
  }

  console.log('\nBrowser staying open for 30s — look at the window...');
  await page.waitForTimeout(30000);
  await browser.close();
})();
