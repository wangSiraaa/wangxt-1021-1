const express = require('express');
const router = express.Router();
const store = require('../store');
const { nowDate, nowDateTime } = require('../utils');

// ===== 果区管理 =====
router.get('/orchard-zones', (req, res) => {
  const zones = store.getAll('orchard_zone');
  res.json({ code: 0, data: zones });
});

router.post('/orchard-zones', (req, res) => {
  const { zone_code, zone_name, fruit_type, fruit_variety, total_area, estimated_total_weight, location, description, status } = req.body;
  if (!zone_code || !zone_name || !fruit_type) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }
  if (store.findOne('orchard_zone', z => z.zone_code === zone_code)) {
    return res.json({ code: 400, message: '果区编码已存在' });
  }
  const record = store.insert('orchard_zone', {
    zone_code, zone_name, fruit_type, fruit_variety,
    total_area: Number(total_area) || 0,
    estimated_total_weight: Number(estimated_total_weight) || 0,
    location: location || '',
    description: description || '',
    status: status || 'ACTIVE'
  });
  res.json({ code: 0, data: record });
});

router.put('/orchard-zones/:id', (req, res) => {
  const id = Number(req.params.id);
  const record = store.update('orchard_zone', id, req.body);
  if (!record) return res.json({ code: 404, message: '果区不存在' });
  res.json({ code: 0, data: record });
});

router.delete('/orchard-zones/:id', (req, res) => {
  const id = Number(req.params.id);
  store.delete('orchard_zone', id);
  res.json({ code: 0 });
});

// ===== 成熟度版本(批次)管理 =====
router.get('/maturity-versions', (req, res) => {
  const { zone_id } = req.query;
  let versions = store.getAll('maturity_version');
  if (zone_id) versions = versions.filter(v => v.zone_id === Number(zone_id));
  const zones = store.getAll('orchard_zone');
  const zoneMap = new Map(zones.map(z => [z.id, z]));
  const data = versions.map(v => ({
    ...v,
    zone: zoneMap.get(v.zone_id) || null
  }));
  res.json({ code: 0, data });
});

router.post('/maturity-versions', (req, res) => {
  const { zone_id, batch_code, maturity_level, maturity_label, estimated_weight, ripe_weight, version_date, remark, status } = req.body;
  if (!zone_id || !batch_code) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }
  const ripe = Number(ripe_weight) != null ? Number(ripe_weight) : Math.round(Number(estimated_weight) * (Number(maturity_level) / 100));
  const record = store.insert('maturity_version', {
    zone_id: Number(zone_id),
    batch_code,
    maturity_level: Number(maturity_level) || 0,
    maturity_label: maturity_label || `${maturity_level}成成熟`,
    estimated_weight: Number(estimated_weight) || 0,
    ripe_weight: ripe,
    available_weight: ripe,
    locked_weight: 0,
    picked_weight: 0,
    version_date: version_date || nowDate(),
    remark: remark || '',
    status: status || 'ACTIVE'
  });
  res.json({ code: 0, data: record });
});

router.put('/maturity-versions/:id', (req, res) => {
  const id = Number(req.params.id);
  const updates = { ...req.body };
  if (updates.maturity_level != null && updates.estimated_weight != null) {
    updates.ripe_weight = Math.round(Number(updates.estimated_weight) * (Number(updates.maturity_level) / 100));
    if (!updates.available_weight) updates.available_weight = updates.ripe_weight;
  }
  const record = store.update('maturity_version', id, updates);
  if (!record) return res.json({ code: 404, message: '批次不存在' });
  res.json({ code: 0, data: record });
});

router.delete('/maturity-versions/:id', (req, res) => {
  const id = Number(req.params.id);
  store.delete('maturity_version', id);
  res.json({ code: 0 });
});

// ===== 时段管理 =====
router.get('/time-slots', (req, res) => {
  const { slot_date, status } = req.query;
  let slots = store.getAll('time_slot');
  if (slot_date) slots = slots.filter(s => s.slot_date === slot_date);
  if (status) slots = slots.filter(s => s.status === status);
  slots.sort((a, b) => {
    if (a.slot_date !== b.slot_date) return a.slot_date.localeCompare(b.slot_date);
    return a.slot_start.localeCompare(b.slot_start);
  });
  res.json({ code: 0, data: slots });
});

router.post('/time-slots', (req, res) => {
  const { slot_date, slot_start, slot_end, max_capacity, zone_ids, is_limited, limit_reason, status } = req.body;
  if (!slot_date || !slot_start || !slot_end) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }
  const record = store.insert('time_slot', {
    slot_date, slot_start, slot_end,
    slot_label: `${slot_date.slice(5)} ${slot_start}-${slot_end}`,
    max_capacity: Number(max_capacity) || 50,
    reserved_count: 0,
    entered_count: 0,
    zone_ids: Array.isArray(zone_ids) ? JSON.stringify(zone_ids) : (zone_ids || '[]'),
    is_limited: Number(is_limited) || 0,
    limit_reason: limit_reason || null,
    status: status || 'AVAILABLE'
  });
  res.json({ code: 0, data: record });
});

router.put('/time-slots/:id', (req, res) => {
  const id = Number(req.params.id);
  const updates = { ...req.body };
  if (Array.isArray(updates.zone_ids)) {
    updates.zone_ids = JSON.stringify(updates.zone_ids);
  }
  const record = store.update('time_slot', id, updates);
  if (!record) return res.json({ code: 404, message: '时段不存在' });
  res.json({ code: 0, data: record });
});

router.delete('/time-slots/:id', (req, res) => {
  const id = Number(req.params.id);
  store.delete('time_slot', id);
  res.json({ code: 0 });
});

// 批量设置闭园
router.post('/time-slots/set-closure', (req, res) => {
  const { slot_date, reason, alert_id } = req.body;
  if (!slot_date) return res.json({ code: 400, message: '日期必填' });
  const count = store.updateWhere('time_slot',
    s => s.slot_date === slot_date,
    { status: 'CLOSURE', limit_reason: reason || '闭园通知', is_limited: 1 }
  );
  res.json({ code: 0, data: { count, slot_date } });
});

// ===== 天气预警 =====
router.get('/weather-alerts', (req, res) => {
  const data = store.getAll('weather_alert').sort((a, b) => b.alert_date.localeCompare(a.alert_date));
  res.json({ code: 0, data });
});

router.post('/weather-alerts', (req, res) => {
  const { alert_date, alert_type, alert_level, is_closed, temperature, rainfall, wind_speed, description, notice_title, notice_content, published_by } = req.body;
  if (!alert_date || !alert_type || !alert_level) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }
  const record = store.insert('weather_alert', {
    alert_date, alert_type, alert_level,
    is_closed: Number(is_closed) || 0,
    temperature: Number(temperature) || 0,
    rainfall: Number(rainfall) || 0,
    wind_speed: Number(wind_speed) || 0,
    description: description || '',
    notice_title: notice_title || '',
    notice_content: notice_content || '',
    published_by: published_by || '系统',
    status: 'ACTIVE'
  });
  if (record.is_closed === 1) {
    store.updateWhere('time_slot',
      s => s.slot_date === record.alert_date && s.status !== 'CLOSURE',
      { status: 'CLOSURE', limit_reason: `${alert_type}${alert_level}`, is_limited: 1 }
    );
  }
  res.json({ code: 0, data: record });
});

router.put('/weather-alerts/:id', (req, res) => {
  const id = Number(req.params.id);
  const old = store.getById('weather_alert', id);
  const record = store.update('weather_alert', id, req.body);
  if (!record) return res.json({ code: 404, message: '预警不存在' });
  if (req.body.is_closed === 1 && old?.is_closed !== 1) {
    store.updateWhere('time_slot',
      s => s.slot_date === record.alert_date && s.status !== 'CLOSURE',
      { status: 'CLOSURE', limit_reason: `${record.alert_type}${record.alert_level}`, is_limited: 1 }
    );
  }
  res.json({ code: 0, data: record });
});

router.delete('/weather-alerts/:id', (req, res) => {
  const id = Number(req.params.id);
  store.delete('weather_alert', id);
  res.json({ code: 0 });
});

// ===== 采摘券管理 =====
router.get('/picking-tickets', (req, res) => {
  const data = store.getAll('picking_ticket');
  res.json({ code: 0, data });
});

router.post('/picking-tickets', (req, res) => {
  const { ticket_code, ticket_name, ticket_type, price, included_weight, deposit, extra_price_per_kg, max_extra_weight, valid_from, valid_to, description, status } = req.body;
  if (!ticket_code || !ticket_name || !ticket_type) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }
  const record = store.insert('picking_ticket', {
    ticket_code, ticket_name, ticket_type,
    price: Number(price) || 0,
    included_weight: Number(included_weight) || 0,
    deposit: Number(deposit) || 0,
    extra_price_per_kg: Number(extra_price_per_kg) || 0,
    max_extra_weight: Number(max_extra_weight) || 0,
    valid_from: valid_from || nowDate(),
    valid_to: valid_to || '2026-12-31',
    description: description || '',
    status: status || 'ACTIVE'
  });
  res.json({ code: 0, data: record });
});

router.put('/picking-tickets/:id', (req, res) => {
  const id = Number(req.params.id);
  const record = store.update('picking_ticket', id, req.body);
  if (!record) return res.json({ code: 404, message: '采摘券不存在' });
  res.json({ code: 0, data: record });
});

router.delete('/picking-tickets/:id', (req, res) => {
  const id = Number(req.params.id);
  store.delete('picking_ticket', id);
  res.json({ code: 0 });
});

// ===== 黑名单管理 =====
router.get('/visitor-blacklist', (req, res) => {
  const data = store.getAll('visitor_blacklist');
  res.json({ code: 0, data });
});

router.post('/visitor-blacklist', (req, res) => {
  const { visitor_phone, visitor_name, visitor_idcard, reason, blocked_by, expire_at, is_permanent, remark } = req.body;
  if (!visitor_phone && !visitor_idcard) {
    return res.json({ code: 400, message: '手机号或身份证必填' });
  }
  const record = store.insert('visitor_blacklist', {
    visitor_phone: visitor_phone || null,
    visitor_name: visitor_name || '',
    visitor_idcard: visitor_idcard || null,
    reason: reason || '',
    blocked_by: blocked_by || '管理员',
    blocked_at: nowDateTime(),
    expire_at: expire_at || null,
    is_permanent: Number(is_permanent) || 0,
    status: 'BLOCKED',
    remark: remark || ''
  });
  res.json({ code: 0, data: record });
});

router.delete('/visitor-blacklist/:id', (req, res) => {
  const id = Number(req.params.id);
  store.update('visitor_blacklist', id, { status: 'UNBLOCKED' });
  res.json({ code: 0 });
});

module.exports = router;
