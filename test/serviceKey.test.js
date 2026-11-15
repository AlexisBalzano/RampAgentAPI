require("./helpers/setup");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseServiceKeys,
  createServiceKeyMiddleware,
} = require("../middleware/serviceKey");

function run(middleware, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method: "GET", originalUrl: "/api/v1/airports", get: (h) => lower[h.toLowerCase()] };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  middleware(req, res, () => (nextCalled = true));
  return { req, res, nextCalled };
}

test("parses name:key pairs and skips malformed entries", () => {
  const keys = parseServiceKeys(" website:abc , broken, :nokey, noname: ,other:x:y");
  assert.deepEqual(
    keys.map((k) => [k.name, k.key.toString()]),
    [
      ["website", "abc"],
      ["other", "x:y"],
    ]
  );
});

test("missing key is 401", () => {
  const { res, nextCalled } = run(createServiceKeyMiddleware("website:secret"));
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("wrong key is 403, including a wrong key of the right length", () => {
  const mw = createServiceKeyMiddleware("website:secret");
  assert.equal(run(mw, { "X-Service-Key": "nope" }).res.statusCode, 403);
  const same = run(mw, { "X-Service-Key": "secreT" });
  assert.equal(same.res.statusCode, 403);
  assert.equal(same.nextCalled, false);
});

test("valid key passes and names the service", () => {
  const mw = createServiceKeyMiddleware("other:111,website:secret");
  const { req, nextCalled } = run(mw, { "X-Service-Key": "secret" });
  assert.equal(nextCalled, true);
  assert.equal(req.service, "website");
});

test("no keys configured refuses everything (fail closed)", () => {
  const mw = createServiceKeyMiddleware("");
  assert.equal(run(mw).res.statusCode, 401);
  const withKey = run(mw, { "X-Service-Key": "anything" });
  assert.equal(withKey.res.statusCode, 403);
  assert.equal(withKey.nextCalled, false);
});
