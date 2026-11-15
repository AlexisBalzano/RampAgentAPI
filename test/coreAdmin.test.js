require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.CORE_JWT_KEY = "test-core-key";

const redisService = require("../services/redisService");
const auth = require("../controllers/authController");

test("isCoreAdmin reads core admin and sysadmin flags", () => {
  assert.equal(auth.isCoreAdmin({ UserGlobalPermissions: { isAdmin: true } }), true);
  assert.equal(auth.isCoreAdmin({ UserGlobalPermissions: { isSysAdmin: true } }), true);
  assert.equal(auth.isCoreAdmin({ UserGlobalPermissions: { isStaff: true } }), false);
  // A member never given a role has null permissions.
  assert.equal(auth.isCoreAdmin({ UserGlobalPermissions: null }), false);
  assert.equal(auth.isCoreAdmin(null), false);
});

test("effectiveRoles merges the core flag with local roles", () => {
  assert.deepEqual(auth.effectiveRoles({ roles: [], core_admin: true }), ["admin"]);
  assert.deepEqual(auth.effectiveRoles({ roles: ["admin"], core_admin: false }), ["admin"]);
  assert.deepEqual(auth.effectiveRoles({ roles: ["admin"], core_admin: true }), ["admin"]);
  assert.deepEqual(auth.effectiveRoles({ core_admin: false }), []);
  assert.deepEqual(auth.effectiveRoles(undefined), []);
});

test("/api/logs is admin-only, and core admins get in", async (t) => {
  const users = {
    "100": { roles: [], core_admin: true },
    "200": { roles: [], core_admin: false },
    "300": { roles: ["admin"] },
  };
  t.mock.method(redisService, "getLocalUser", async (cid) => users[cid] || {});

  const app = express();
  app.use("/api/logs", auth.requireAuth, auth.requireRoles("admin"), (req, res) =>
    res.json({ ok: true })
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/logs`;

  const as = (cid) =>
    fetch(base, {
      headers: cid
        ? { Cookie: "session=" + jwt.sign({ cid }, process.env.CORE_JWT_KEY) }
        : {},
    }).then((r) => r.status);

  assert.equal(await as(null), 401);
  assert.equal(await as("200"), 403);
  assert.equal(await as("100"), 200);
  assert.equal(await as("300"), 200);
});
