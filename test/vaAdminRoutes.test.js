process.env.CORE_JWT_KEY = "test-core-key";
require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const redisService = require("../services/redisService");
const vaIntegrations = require("../services/vaIntegrationService");
const authController = require("../controllers/authController");
const vaRoutes = require("../routes/vaIntegrations");

const stored = new Map();
redisService.setVaIntegration = async (r) => void stored.set(r.id, JSON.stringify(r));
redisService.deleteVaIntegration = async (id) => void stored.delete(id);
redisService.getAllVaIntegrations = async () => [...stored.values()].map((v) => JSON.parse(v));
const roles = { "100": { roles: ["admin"] }, "200": { roles: [] } };
redisService.getLocalUser = async (cid) => roles[cid] || {};

let base;
let server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/va-integrations", authController.requireAuth, authController.requireRoles("admin"), vaRoutes);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}/api/admin/va-integrations`;
});
test.after(() => server.close());
test.beforeEach(() => {
  stored.clear();
  vaIntegrations._reset();
});

const session = (cid) => `session=${jwt.sign({ cid }, "test-core-key", { algorithm: "HS256" })}`;
const call = (path, { method = "GET", body, cid = "100" } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(cid ? { Cookie: session(cid) } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test("only admins can manage integrations", async () => {
  assert.equal((await call("/", { cid: null })).status, 401);
  assert.equal((await call("/", { cid: "200" })).status, 403);
  assert.equal((await call("/")).status, 200);
});

test("create shows the key once; list never does", async () => {
  const res = await call("/", { method: "POST", body: { name: "Fly VA", prefixes: ["FVA"] } });
  assert.equal(res.status, 201);
  const { integration, key } = await res.json();
  assert.match(key, /^rva_[0-9a-f]{64}$/);
  assert.equal(integration.id, "fly-va");
  assert.equal(integration.keyHint, key.slice(-4));
  assert.equal(integration.createdBy, "100");

  const list = await (await call("/")).json();
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(key));
  assert.equal(list[0].keyHash, undefined);
});

test("edit, rotate, delete; errors are reported", async () => {
  await call("/", { method: "POST", body: { name: "Fly VA", prefixes: "FVA" } });
  const patched = await (await call("/fly-va", { method: "PATCH", body: { prefixes: "FVA,FVX", enabled: false } })).json();
  assert.deepEqual(patched.prefixes, ["FVA", "FVX"]);
  assert.equal(patched.enabled, false);

  const bad = await call("/fly-va", { method: "PATCH", body: { prefixes: "!" } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).field, "prefixes");

  const rotated = await (await call("/fly-va/rotate", { method: "POST" })).json();
  assert.match(rotated.key, /^rva_/);

  assert.equal((await call("/fly-va", { method: "DELETE" })).status, 204);
  assert.equal((await call("/fly-va", { method: "DELETE" })).status, 404);
  assert.equal((await call("/nope/rotate", { method: "POST" })).status, 404);
});

test("storage being down is a 503, not a silent success", async () => {
  const original = redisService.setVaIntegration;
  redisService.setVaIntegration = async () => {
    throw new Error("Redis is not connected");
  };
  try {
    const res = await call("/", { method: "POST", body: { name: "Fly VA", prefixes: "FVA" } });
    assert.equal(res.status, 503);
    assert.deepEqual(await (await call("/")).json(), []);
  } finally {
    redisService.setVaIntegration = original;
  }
});
