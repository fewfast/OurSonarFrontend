const express = require('express');
const router = express.Router();

module.exports = (getConfig) => {
    router.get('/', (_req, res) => {
        res.json(getConfig());
    });

    return router;
};