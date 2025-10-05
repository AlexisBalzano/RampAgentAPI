const express = require('express');
const router = express.Router();
const assignController = require('../controllers/assignController');

router.post('/', assignController.assignStand);
router.get('/', assignController.getAssignedStand)

module.exports = router;
