const express = require('express');
const router = express.Router();
const assignController = require('../controllers/assignController');

router.get('/', assignController.assignStand)

module.exports = router;
