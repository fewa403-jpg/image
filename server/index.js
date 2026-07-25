const express = require('express');
const cors = require('cors');
const path = require('path');

const aiRoutes = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.use('/api/ai', aiRoutes);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Pro Image Editor server running at http://localhost:${PORT}`);
  if (!process.env.HF_TOKEN) {
    console.warn('⚠️  HF_TOKEN is not set — only the "Remove Object" AI feature needs this (Background Removal now runs locally, no token needed). See README.md.');
  }
});
