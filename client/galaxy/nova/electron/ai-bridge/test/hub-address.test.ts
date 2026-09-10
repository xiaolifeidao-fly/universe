import assert from "node:assert/strict";
import test from "node:test";
import { createHubAddressCheck } from "../src/modules/pool/hub-address.js";

test("地址标准化、差异去重和恢复", () => {
  const events: string[] = [];
  const check = createHubAddressCheck("http://example.com/hub", {
    info: (event) => { events.push(event); },
    warn: (event) => { events.push(event); },
  });
  check(" HTTP://EXAMPLE.COM:80/hub/ ");
  check("http://example.com/other");
  check("http://example.com/other/");
  check("https://example.com/hub");
  check("http://example.com:81/hub");
  check("http://example.com/hub");
  assert.deepEqual(events, ["pool_hub_address_matched", "pool_hub_address_mismatch",
    "pool_hub_address_mismatch", "pool_hub_address_mismatch", "pool_hub_address_matched"]);
});

test("兼容缺失字段，拒绝非法地址且不泄露输入", () => {
  const events: unknown[] = [];
  const check = createHubAddressCheck("http://example.com", {
    info: (event, meta) => { events.push({ event, meta }); },
    warn: (event, meta) => { events.push({ event, meta }); },
  });
  check(undefined);
  check("");
  assert.equal(events.length, 0);
  for (const value of [null, {}, "bad", "ftp://example.com", "http://user:secret@example.com", "http://example.com?token=secret"]) check(value);
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes("secret"));
  check(undefined);
  check("http://example.com");
  assert.equal(events.length, 2);
});
