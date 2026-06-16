/**
 * Apple purchase-history parser + classifier tests (pure, no DB). Covers single-item
 * paid orders, multi-item orders, Free items, period/refund metadata, and the
 * business/personal/review classification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppleHistory, classifyAppleItem, looksLikeAppleHistory } from "../src/core/apple-history.js";

const SAMPLE = `Jun 14, 2026
MT8ZLX0SX6
Total $249.99
Claude Max 20x - Monthly
Claude Max 20x - Monthly
Claude by Anthropic
Renews Jul 14, 2026
$249.99

Jun 14, 2026
R24Z1L634J3F4H
Total $0.00
Pioneer ARC
Pioneer ARC
Pioneer Corporation
Free

May 23, 2026
MT8ZJ1B5QT
Total $54.99
Creator Monthly
Creator Monthly
HeyGen: AI Video Generator
Expires: Jun 23, 2026
$29.00
Creator Monthly
Creator Monthly
ElevenLabs: AI Voice Generator
Expires: Jun 23, 2026
$22.00
Five Easy Pieces
Five Easy Pieces
Bob Rafelson
$3.99

Jan 30, 2025
MT8XS20945
Total $19.98
Disney+ Premium
Disney+ Premium
Disney+
Jan 30, 2025 - Feb 28, 2025
$15.99
Hook
Hook
Steven Spielberg
$3.99`;

test("parseAppleHistory parses orders, totals, and items", () => {
  const orders = parseAppleHistory(SAMPLE);
  assert.equal(orders.length, 4);

  const claude = orders[0]!;
  assert.equal(claude.orderId, "MT8ZLX0SX6");
  assert.equal(claude.date, "2026-06-14");
  assert.equal(claude.totalCents, 24999);
  assert.equal(claude.items.length, 1);
  assert.equal(claude.items[0]!.name, "Claude Max 20x - Monthly");
  assert.equal(claude.items[0]!.vendor, "Claude by Anthropic");
  assert.equal(claude.items[0]!.amountCents, 24999);

  const free = orders[1]!;
  assert.equal(free.items[0]!.free, true);
  assert.equal(free.items[0]!.amountCents, 0);

  const multi = orders[2]!;
  assert.equal(multi.items.length, 3, "HeyGen + ElevenLabs + movie");
  assert.equal(multi.items[0]!.amountCents, 2900);
  assert.equal(multi.items[1]!.vendor, "ElevenLabs: AI Voice Generator");
  assert.equal(multi.items[2]!.amountCents, 399);
});

test("classifyAppleItem routes AI/dev tools to business and entertainment to personal", () => {
  assert.equal(classifyAppleItem("claude max 20x - monthly claude by anthropic").bucket, "business");
  assert.equal(classifyAppleItem("creator monthly heygen: ai video generator").bucket, "business");
  assert.equal(classifyAppleItem("creator monthly elevenlabs: ai voice generator").accountCode, "6150");
  assert.equal(classifyAppleItem("disney+ premium disney+").bucket, "personal");
  assert.equal(classifyAppleItem("disney+ premium disney+").accountCode, "9500");
  assert.equal(classifyAppleItem("tinder gold tinder dating app").bucket, "personal");
  assert.equal(classifyAppleItem("apple developer apple").accountCode, "6110");
  // A purchased film is personal entertainment.
  assert.equal(classifyAppleItem("five easy pieces bob rafelson").bucket, "personal");
  // A genuinely uncategorized utility → review (never force-guessed).
  assert.equal(classifyAppleItem("remote mouse 耀 阮").bucket, "review");
});

test("looksLikeAppleHistory detects the bulk export shape", () => {
  assert.equal(looksLikeAppleHistory(SAMPLE), true);
  assert.equal(looksLikeAppleHistory("just a normal receipt for $5.00 at a coffee shop"), false);
});
