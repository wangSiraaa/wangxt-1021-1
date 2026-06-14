const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const adminRoutes = require('./src/routes/admin');
const reservationRoutes = require('./src/routes/reservation');
const onsiteRoutes = require('./src/routes/onsite');
const dashboardRoutes = require('./src/routes/dashboard');

const app = express();
const PORT = process.env.PORT || 3011;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ code: 0, data: { status: 'ok', message: '水果采摘园预约系统后端运行正常', timestamp: new Date().toISOString() }});
});

app.use('/api/admin', adminRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/onsite', onsiteRoutes);
app.use('/api/dashboard', dashboardRoutes);

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(FRONTEND_DIR));
app.get(['/', '/admin', '/visitor', '/onsite', '/dashboard', '/dashboard/*', '/admin/*', '/visitor/*', '/onsite/*'], (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ code: 500, message: err.message || '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`  🍎 水果采摘园预约系统后端启动成功`);
  console.log(`  🚀 API服务: http://localhost:${PORT}/api`);
  console.log(`  💚 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`  📊 看板页面: http://localhost:${PORT}/`);
  console.log('='.repeat(60));
});

module.exports = app;
