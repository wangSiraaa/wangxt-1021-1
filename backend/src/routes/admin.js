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

// ===== 果区单独闭园管理 =====
router.post('/zone-closure', (req, res) => {
  const { zone_id, closure_date, reason, operator } = req.body;
  if (!zone_id || !closure_date) return res.json({ code: 400, message: '果区和日期必填' });
  const record = store.insert('closure_record', {
    closure_no: `ZC-${Date.now()}`,
    zone_id: Number(zone_id),
    closure_date,
    reason: reason || '临时关闭',
    operator: operator || '管理员',
    status: 'ACTIVE',
    closed_at: nowDateTime()
  });
  res.json({ code: 0, data: record });
});

router.get('/zone-closure', (req, res) => {
  const { zone_id, closure_date, status } = req.query;
  let list = store.getAll('closure_record');
  if (zone_id) list = list.filter(c => c.zone_id === Number(zone_id));
  if (closure_date) list = list.filter(c => c.closure_date === closure_date);
  if (status) list = list.filter(c => c.status === status);
  res.json({ code: 0, data: list });
});

router.put('/zone-closure/:id', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  const record = store.update('closure_record', id, { status: status || 'INACTIVE' });
  res.json({ code: 0, data: record });
});

// ===== 成熟度调整(触发重算) =====
router.put('/maturity-versions/:id/adjust', (req, res) => {
  const id = Number(req.params.id);
  const { maturity_level, estimated_weight, operator, auto_recalc } = req.body;
  const version = store.getById('maturity_version', id);
  if (!version) return res.json({ code: 404, message: '批次不存在' });

  const updates = {};
  if (maturity_level != null) updates.maturity_level = Number(maturity_level);
  if (estimated_weight != null) updates.estimated_weight = Number(estimated_weight);
  if (updates.maturity_level != null && updates.estimated_weight != null) {
    updates.ripe_weight = Math.round(Number(updates.estimated_weight) * (Number(updates.maturity_level) / 100));
    updates.available_weight = updates.ripe_weight;
  } else if (updates.maturity_level != null) {
    updates.ripe_weight = Math.round(version.estimated_weight * (Number(updates.maturity_level) / 100));
    updates.available_weight = updates.ripe_weight;
  } else if (updates.estimated_weight != null) {
    updates.ripe_weight = Math.round(Number(updates.estimated_weight) * ((version.maturity_level || 0) / 100));
    updates.available_weight = updates.ripe_weight;
  }
  const record = store.update('maturity_version', id, updates);

  let recalcResult = null;
  if (auto_recalc !== false) {
    recalcResult = recalcAfterMaturityChange(id, operator || '管理员');
  }

  res.json({ code: 0, data: { version: record, recalc: recalcResult } });
});

// 批量触发候补晋升
router.post('/waitlist/promote', (req, res) => {
  const { slot_id, max_count, operator } = req.body;
  if (!slot_id) return res.json({ code: 400, message: '时段必填' });
  const result = processWaitlistPromotion(Number(slot_id), Number(max_count) || 3);
  res.json({ code: result.success ? 0 : 400, message: result.message, data: result });
});

// 候补列表管理
router.get('/waitlist', (req, res) => {
  const { slot_id, status, visitor_phone } = req.query;
  let list = store.getAll('waitlist');
  if (slot_id) list = list.filter(w => w.slot_id === Number(slot_id));
  if (status) list = list.filter(w => w.status === status);
  if (visitor_phone) list = list.filter(w => w.visitor_phone === visitor_phone);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ code: 0, data: list });
});

router.put('/waitlist/:id', (req, res) => {
  const id = Number(req.params.id);
  const { status, operator } = req.body;
  const record = store.update('waitlist', id, {
    status: status || 'CANCELLED',
    handled_by: operator || '管理员',
    handled_at: nowDateTime()
  });
  res.json({ code: 0, data: record });
});

// 候补手动转为预约
router.post('/waitlist/:id/convert', (req, res) => {
  const id = Number(req.params.id);
  const { operator } = req.body;
  const waiter = store.getById('waitlist', id);
  if (!waiter) return res.json({ code: 404, message: '候补记录不存在' });
  if (waiter.status === 'CONVERTED' || waiter.status === 'CANCELLED') {
    return res.json({ code: 400, message: `候补状态为${waiter.status}，无法转换` });
  }

  const slot = store.getById('time_slot', waiter.slot_id);
  if (!slot) return res.json({ code: 404, message: '时段不存在' });
  const ticket = store.getById('picking_ticket', waiter.ticket_id);
  if (!ticket) return res.json({ code: 404, message: '票种不存在' });

  const gs = waiter.group_size || 1;
  const weightInfo = calcTicketWeight(waiter.ticket_id, gs);
  const availWeight = calcSlotAvailableWeight(waiter.slot_id);
  const availCap = Math.max(0, (slot.max_capacity || 0) - (slot.reserved_count || 0));

  if (availCap < gs) return res.json({ code: 4103, message: '时段容量不足' });
  if (availWeight < weightInfo.estimated) return res.json({ code: 4105, message: '果量不足' });

  const lockResult = tryLockWeight(waiter.slot_id, weightInfo.estimated, null);
  if (!lockResult.success) return res.json({ code: 4105, message: lockResult.message });

  const reservation = store.insert('reservation', {
    reservation_no: `RE-WL-${Date.now()}`,
    visitor_phone: waiter.visitor_phone,
    visitor_name: waiter.visitor_name,
    visitor_type: waiter.visitor_type || 'ADULT',
    visitor_idcard: waiter.visitor_idcard || null,
    slot_id: waiter.slot_id,
    ticket_id: waiter.ticket_id,
    group_size: gs,
    adult_count: waiter.adult_count || gs,
    child_count: waiter.child_count || 0,
    estimated_weight: weightInfo.estimated,
    included_weight: weightInfo.included,
    extra_weight_limit: weightInfo.extraLimit,
    total_amount: Math.round(ticket.price * gs * 100) / 100,
    deposit_amount: Math.round(ticket.deposit * gs * 100) / 100,
    payable_total: Math.round((ticket.price + ticket.deposit) * gs * 100) / 100,
    payment_status: 'PENDING_WAIVER',
    status: 'CONFIRMED',
    locked_weight: weightInfo.estimated,
    lock_details: JSON.stringify(lockResult.lockedDetails),
    remark: `候补转正(${waiter.waitlist_no})`,
    source: 'WAITLIST',
    waitlist_id: id
  });

  store.update('time_slot', slot.id, { reserved_count: (slot.reserved_count || 0) + gs });
  store.update('waitlist', id, {
    status: 'CONVERTED',
    converted_to_reservation_id: reservation.id,
    converted_at: nowDateTime(),
    converted_by: operator || '管理员'
  });

  store.insert('deposit_record', {
    deposit_no: `DP-WL-${Date.now()}`,
    reservation_id: reservation.id,
    visitor_phone: waiter.visitor_phone,
    original_amount: reservation.deposit_amount,
    paid_amount: 0,
    paid_at: null,
    remaining_amount: reservation.deposit_amount,
    status: 'PENDING_PAY',
    waitlist_source: id
  });

  syncStateToAll(reservation.id, 'ADMIN_WAITLIST_CONVERT', operator || '管理员');

  res.json({ code: 0, data: { reservation, waitlist_id: id } });
});

// ===== 加购服务配置 =====
router.get('/addon-services', (req, res) => {
  const { status } = req.query;
  let list = store.getAll('addon_service');
  if (status) list = list.filter(s => s.status === status);
  res.json({ code: 0, data: list });
});

router.post('/addon-services', (req, res) => {
  const {
    service_code, service_name, service_type, unit_price, unit,
    description, available_zones, min_quantity, max_quantity, valid_from, valid_to, status
  } = req.body;
  if (!service_code || !service_name || !service_type || unit_price == null) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }
  const record = store.insert('addon_service', {
    service_code, service_name, service_type,
    unit_price: Number(unit_price) || 0,
    unit: unit || '份',
    description: description || '',
    available_zones: Array.isArray(available_zones) ? JSON.stringify(available_zones) : (available_zones || '[]'),
    min_quantity: Number(min_quantity) || 1,
    max_quantity: Number(max_quantity) || 99,
    valid_from: valid_from || nowDate(),
    valid_to: valid_to || '2026-12-31',
    status: status || 'ACTIVE'
  });
  res.json({ code: 0, data: record });
});

router.put('/addon-services/:id', (req, res) => {
  const id = Number(req.params.id);
  const updates = { ...req.body };
  if (Array.isArray(updates.available_zones)) {
    updates.available_zones = JSON.stringify(updates.available_zones);
  }
  const record = store.update('addon_service', id, updates);
  if (!record) return res.json({ code: 404, message: '服务不存在' });
  res.json({ code: 0, data: record });
});

router.delete('/addon-services/:id', (req, res) => {
  const id = Number(req.params.id);
  store.update('addon_service', id, { status: 'INACTIVE' });
  res.json({ code: 0 });
});

// ===== 分批入园配置 =====
router.get('/batch-entries', (req, res) => {
  const { slot_id, status } = req.query;
  let list = store.getAll('batch_entry');
  if (slot_id) list = list.filter(b => b.slot_id === Number(slot_id));
  if (status) list = list.filter(b => b.status === status);
  res.json({ code: 0, data: list });
});

router.post('/batch-entries', (req, res) => {
  const {
    slot_id, group_name, allocated_size, batch_count,
    interval_minutes, start_time, contact_phone, operator
  } = req.body;
  if (!slot_id || !allocated_size) return res.json({ code: 400, message: '时段和分配人数必填' });

  const slot = store.getById('time_slot', Number(slot_id));
  if (!slot) return res.json({ code: 404, message: '时段不存在' });

  const existingUsed = store.find('batch_entry', b =>
    b.slot_id === Number(slot_id) && b.status === 'ACTIVE'
  ).reduce((s, b) => s + (b.allocated_size || 0), 0);

  const remaining = Math.max(0, (slot.max_capacity || 0) - (slot.reserved_count || 0) - existingUsed);
  if (Number(allocated_size) > remaining) {
    return res.json({ code: 400, message: `剩余可分配${remaining}人，请求${allocated_size}人` });
  }

  const record = store.insert('batch_entry', {
    batch_no: `BE-${Date.now()}`,
    slot_id: Number(slot_id),
    group_name: group_name || `团体${Date.now()}`,
    allocated_size: Number(allocated_size),
    batch_count: Number(batch_count) || 1,
    interval_minutes: Number(interval_minutes) || 15,
    start_time: start_time || slot.slot_start,
    contact_phone: contact_phone || '',
    created_by: operator || '管理员',
    status: 'ACTIVE',
    confirmed_count: 0,
    created_at: nowDateTime()
  });

  res.json({ code: 0, data: record });
});

router.put('/batch-entries/:id', (req, res) => {
  const id = Number(req.params.id);
  const record = store.update('batch_entry', id, req.body);
  res.json({ code: 0, data: record });
});

// 成熟度调整日志
router.get('/weight-adjust-logs', (req, res) => {
  const { version_id, zone_id } = req.query;
  let list = store.getAll('weight_adjust_log');
  if (version_id) list = list.filter(l => l.version_id === Number(version_id));
  if (zone_id) list = list.filter(l => l.zone_id === Number(zone_id));
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ code: 0, data: list });
});

// 状态同步日志
router.get('/state-sync-logs', (req, res) => {
  const { reservation_id, source } = req.query;
  let list = store.getAll('state_sync_log');
  if (reservation_id) list = list.filter(l => l.reservation_id === Number(reservation_id));
  if (source) list = list.filter(l => l.source === source);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 100);
  res.json({ code: 0, data: list });
});

// 改期记录
router.get('/reschedule-records', (req, res) => {
  const { reservation_id, status } = req.query;
  let list = store.getAll('reschedule_record');
  if (reservation_id) list = list.filter(r => r.reservation_id === Number(reservation_id));
  if (status) list = list.filter(r => r.status === status);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ code: 0, data: list });
});

module.exports = router;
