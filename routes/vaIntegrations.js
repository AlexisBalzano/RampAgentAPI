const express = require("express");
const router = express.Router();
const va = require("../services/vaIntegrationService");
const { error } = require("../utils/logger");

// Mounted behind requireAuth + requireRoles("admin") in index.js.

const by = (req) => (req.user && req.user.cid ? String(req.user.cid) : "unknown");

function fail(res, err, what) {
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, field: err.field });
  }
  error(`Failed to ${what} VA integration: ${err && err.message}`, { category: "Service" });
  res.status(503).json({ error: `Could not ${what} the integration: storage is unavailable` });
}

router.get("/", (req, res) => res.json(va.list()));

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    res.status(201).json(await va.create({ name: body.name, prefixes: body.prefixes, by: by(req) }));
  } catch (err) {
    fail(res, err, "create");
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const updated = await va.update(
      req.params.id,
      { name: body.name, prefixes: body.prefixes, enabled: body.enabled },
      by(req)
    );
    if (!updated) return res.status(404).json({ error: "No such integration" });
    res.json(updated);
  } catch (err) {
    fail(res, err, "update");
  }
});

router.post("/:id/rotate", async (req, res) => {
  try {
    const rotated = await va.rotate(req.params.id, by(req));
    if (!rotated) return res.status(404).json({ error: "No such integration" });
    res.json(rotated);
  } catch (err) {
    fail(res, err, "rotate the key of");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!(await va.remove(req.params.id, by(req)))) return res.status(404).json({ error: "No such integration" });
    res.status(204).end();
  } catch (err) {
    fail(res, err, "delete");
  }
});

module.exports = router;
