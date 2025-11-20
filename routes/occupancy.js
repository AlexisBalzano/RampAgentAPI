const express = require('express');
const router = express.Router();
const occupancyController = require('../controllers/occupancyController');

router.get('/occupied', occupancyController.getOccupied);
router.get('/assigned', occupancyController.getAssigned);
router.get('/blocked', occupancyController.getBlocked);
router.get('/', occupancyController.getAllStandsStatus);
router.get('/controllers', occupancyController.getControllersNumber);

module.exports = router;
