const express = require('express');
const router = express.Router();

module.exports = (db) => {
    router.get('/', async (_req, res) => {
        try {
            const [alertCount, systemCount, scanCount, latestAlert] = await Promise.all([
                db.collection('logs').countDocuments({ type: 'ALERT' }),
                db.collection('logs').countDocuments({ type: 'SYSTEM' }),
                db.collection('radar_scans').countDocuments(),
                db.collection('logs').findOne({ type: 'ALERT' }, { sort: { createdAt: -1 } }),
            ]);
            res.json({ alertCount, systemCount, scanCount, latestAlert });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};