'use strict';

const { sanitizeText } = require('./sanitizers');

/** Random integer between min and max inclusive */
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Random delay */
function delay(minMs, maxMs) {
  return new Promise((r) => setTimeout(r, randInt(minMs, maxMs)));
}

/**
 * Click an element with natural mouse trajectory.
 * Moves to a random point near the element, pauses, then clicks.
 */
async function humanClick(page, selector, options = {}) {
  const timeout = options.timeout || 15000;
  const el  = await page.waitForSelector(selector, { timeout, state: 'visible' });
  await el.scrollIntoViewIfNeeded().catch(() => {}); // Ensure element is inside viewport
  const box = await el.boundingBox();
  if (!box) throw new Error(`Element not visible: ${selector}`);

  // Random landing point inside the element (avoid edges — 25% to 75% range)
  const x = box.x + box.width  * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.25 + Math.random() * 0.5);

  // Coarse approach from a nearby random offset
  await page.mouse.move(x + randInt(-80, 80), y + randInt(-40, 40), { steps: randInt(6, 12) });
  await delay(80, 250);
  // Fine approach to exact target
  await page.mouse.move(x, y, { steps: randInt(8, 16) });
  await delay(60, 180);
  await page.mouse.click(x, y);
}

/**
 * Type text with human-like variable speed.
 * Occasionally pauses mid-word to simulate thinking.
 */
async function humanType(page, selector, text, options = {}) {
  await humanClick(page, selector, options);
  await delay(150, 350);

  // Second-layer sanitisation (first layer is in Express routes)
  const saneText = sanitizeText(text, { maxLength: 3000 });

  for (const char of saneText) {
    await page.keyboard.type(char, { delay: randInt(25, 65) });
    // ~3% chance of a thinking pause per character
    if (Math.random() < 0.03) await delay(200, 500);
  }
}

/**
 * Scroll the page naturally in small increments.
 */
async function humanScroll(page, totalPx) {
  const steps = randInt(6, 14);
  const chunk = totalPx / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, chunk + randInt(-20, 20));
    await delay(25, 70);
  }
}

module.exports = { delay, randInt, humanClick, humanType, humanScroll };
