const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

async function main() {
  const cssPath = path.resolve(__dirname, "../../electron/renderer/styles.css");
  const css = fs.readFileSync(cssPath, "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <html>
        <head><style>${css}</style></head>
        <body>
          <div id="devPanel" class="dev-only">debug</div>
          <div id="panel" class="panel">panel</div>
          <button id="btn" class="control-btn">Button</button>
        </body>
      </html>
    `);

    const devDisplayDefault = await page.$eval("#devPanel", (el) => getComputedStyle(el).display);
    assert.notStrictEqual(devDisplayDefault, "none");

    await page.evaluate(() => document.body.classList.add("simple-mode"));
    const devDisplaySimple = await page.$eval("#devPanel", (el) => getComputedStyle(el).display);
    assert.strictEqual(devDisplaySimple, "none");

    await page.evaluate(() => document.body.classList.add("theme-light"));
    const panelBg = await page.$eval("#panel", (el) => getComputedStyle(el).backgroundColor);
    const btnBg = await page.$eval("#btn", (el) => getComputedStyle(el).backgroundColor);
    assert.notStrictEqual(panelBg, "rgba(0, 0, 0, 0)");
    assert.notStrictEqual(btnBg, "rgba(0, 0, 0, 0)");
    console.log("ui theme/simple e2e tests passed");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
