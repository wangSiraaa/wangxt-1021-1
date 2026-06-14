const express = require('express');
const router = express.Router();
const store = require('../store');
const { calcSlotAvailableWeight, nowDate } = require('../utils');

// 果量看板
router.get('/fruit-dashboard', (req, res) => {
  const { date } = req.query;
  const targetDate = date || nowDate();
  const zones = store.getAll('orchard_zone');
  const versions = store.find('maturity_version', v =>
    v.status === 'ACTIVE' && (!date || v.version_date === targetDate)
  );
  const slots = store.find('time_slot', s => s.slot_date === targetDate);

  const zoneStats = zones.map(z => {
    const zoneVersions = versions.filter(v => v.zone_id === z.id);
    const totalEstimated = zoneVersions.reduce((s, v) => s + (v.estimated_weight || 0), 0);
    const totalRipe = zoneVersions.reduce((s, v) => s + (v.ripe_weight || 0), 0);
    const totalLocked = zoneVersions.reduce((s, v) => s + (v.locked_weight || 0), 0);
    const totalPicked = zoneVersions.reduce((s, v) => s + (v.picked_weight || 0), 0);
    const totalAvailable = totalRipe - totalLocked;

    return {
      zone_id: z.id,
      zone_code: z.zone_code,
      zone_name: z.zone_name,
      fruit_type: z.fruit_type,
      fruit_variety: z.fruit_variety,
      estimated_weight: totalEstimated,
      ripe_weight: totalRipe,
      available_weight: Math.max(0, totalAvailable),
      locked_weight: totalLocked,
      picked_weight: totalPicked,
      ripe_rate: totalEstimated > 0 ? Math.round(totalRipe / totalEstimated * 100) : 0,
      pick_rate: totalRipe > 0 ? Math.round(totalPicked / totalRipe * 100) : 0,
      lock_rate: totalRipe > 0 ? Math.round(totalLocked / totalRipe * 100) : 0,
      batches: zoneVersions.map(v => ({
        id: v.id,
        batch_code: v.batch_code,
        maturity_level: v.maturity_level,
        maturity_label: v.maturity_label,
        estimated_weight: v.estimated_weight,
        ripe_weight: v.ripe_weight,
        available_weight: Math.max(0, (v.available_weight || 0) - (v.locked_weight || 0)),
        locked_weight: v.locked_weight,
        picked_weight: v.picked_weight
      }))
    };
  });

  const slotStats = slots.map(s => {
    const zoneIds = JSON.parse(s.zone_ids || '[]');
    const slotWeight = zoneIds.reduce((total, zid) => {
      const zs = zoneStats.find(z => z.zone_id === zid);
      return total + (zs?.available_weight || 0);
    }, 0);
    return {
      slot_id: s.id,
      slot_date: s.slot_date,
      slot_start: s.slot_start,
      slot_end: s.slot_end,
      slot_label: s.slot_label,
      max_capacity: s.max_capacity,
      reserved_count: s.reserved_count || 0,
      entered_count: s.entered_count || 0,
      available_capacity: Math.max(0, s.max_capacity - (s.reserved_count || 0)),
      status: s.status,
      is_limited: s.is_limited,
      limit_reason: s.limit_reason,
      available_weight: slotWeight,
      zone_ids: zoneIds
    };
  });

  const summary = {
    total_zones: zones.length,
    total_batches: versions.length,
    total_estimated: zoneStats.reduce((s, z) => s + z.estimated_weight, 0),
    total_ripe: zoneStats.reduce((s, z) => s + z.ripe_weight, 0),
    total_available: zoneStats.reduce((s, z) => s + z.available_weight, 0),
    total_locked: zoneStats.reduce((s, z) => s + z.locked_weight, 0),
    total_picked: zoneStats.reduce((s, z) => s + z.picked_weight, 0),
    total_slots: slots.length,
    closure_slots: slots.filter(s => s.status === 'CLOSURE').length,
    limited_slots: slots.filter(s => s.is_limited === 1).length
  };

  res.json({ code: 0, data: { date: targetDate, summary, zones: zoneStats, slots: slotStats } });
});

// 闭园通知和限流状态
router.get('/closure-status', (req, res) => {
  const alerts = store.getAll('weather_alert')
    .filter(a => a.status === 'ACTIVE')
    .sort((a, b) => b.alert_date.localeCompare(a.alert_date));

  const closureSlots = store.find('time_slot', s => s.status === 'CLOSURE')
    .sort((a, b) => a.slot_date.localeCompare(b.slot_date));

  const limitedSlots = store.find('time_slot', s => s.is_limited === 1 && s.status !== 'CLOSURE');

  const closureDates = {};
  closureSlots.forEach(s => {
    if (!closureDates[s.slot_date]) {
      closureDates[s.slot_date] = { date: s.slot_date, count: 0, reason: s.limit_reason };
    }
    closureDates[s.slot_date].count++;
  });

  res.json({ code: 0, data: {
    alerts,
    closure_slots: closureSlots,
    closure_dates: Object.values(closureDates),
    limited_slots: limitedSlots,
    closure_count: closureSlots.length,
    alert_count: alerts.length
  }});
});

// 退款记录
router.get('/refund-records', (req, res) => {
  const { reservation_id, visitor_phone, refund_status } = req.query;
  let list = store.getAll('refund_record');
  if (reservation_id) list = list.filter(r => r.reservation_id === Number(reservation_id));
  if (visitor_phone) list = list.filter(r => r.visitor_phone === visitor_phone);
  if (refund_status) list = list.filter(r => r.refund_status === refund_status);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  const totalRefund = list.reduce((s, r) => s + (r.total_refund || 0), 0);
  const totalDeduction = list.reduce((s, r) => s + (r.total_deduction || 0), 0);
  res.json({ code: 0, data: {
    list,
    total_count: list.length,
    total_refund: Math.round(totalRefund * 100) / 100,
    total_deduction: Math.round(totalDeduction * 100) / 100
  }});
});

// 异常补偿记录
router.get('/compensation-records', (req, res) => {
  const { handle_status, exception_type } = req.query;
  let list = store.getAll('exception_record');
  if (handle_status) list = list.filter(e => e.handle_status === handle_status);
  if (exception_type) list = list.filter(e => e.exception_type === exception_type);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));

  const refundMap = new Map();
  store.getAll('refund_record').forEach(r => {
    if (r.source_type === 'EXCEPTION') {
      refundMap.set(r.source_id, r);
    }
  });

  const data = list.map(e => ({
    ...e,
    refund: refundMap.get(e.id) || null
  }));

  const totalCompensation = list.reduce((s, e) => s + (e.compensation_amount || 0), 0);
  const pendingCount = list.filter(e => e.handle_status === 'PENDING').length;

  res.json({ code: 0, data: {
    list: data,
    total_count: list.length,
    pending_count: pendingCount,
    handled_count: list.length - pendingCount,
    total_compensation: Math.round(totalCompensation * 100) / 100
  }});
});

// 锁量释放记录
router.get('/lock-release-logs', (req, res) => {
  const reservations = store.find('reservation', r => r.lock_release_at);
  const closedReservations = store.find('reservation', r =>
    (r.status === 'CANCELLED' || r.status === 'COMPLETED') && r.locked_weight
  );
  const all = [...reservations, ...closedReservations]
    .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
    .sort((a, b) => (b.lock_release_at || b.cancelled_at || b.completed_at || '').localeCompare(a.lock_release_at || a.cancelled_at || a.completed_at || ''));

  res.json({ code: 0, data: {
    list: all.map(r => ({
      reservation_id: r.id,
      reservation_no: r.reservation_no,
      visitor_name: r.visitor_name,
      visitor_phone: r.visitor_phone,
      locked_weight: r.locked_weight || 0,
      released_at: r.lock_release_at || r.cancelled_at || r.completed_at || r.updated_at,
      release_type: r.status === 'CANCELLED' ? '取消释放' : (r.status === 'COMPLETED' ? '完成释放' : '强制释放'),
      release_reason: r.lock_release_reason || r.cancel_reason || '正常释放',
      operator: r.lock_release_operator || 'system'
    })),
    total_released: all.length
  }});
});

// 综合看板首页数据
router.get('/overview', (req, res) => {
  const today = nowDate();
  const todaySlots = store.find('time_slot', s => s.slot_date === today);
  const todayReservations = store.find('reservation', r => {
    const slot = store.getById('time_slot', r.slot_id);
    return slot?.slot_date === today;
  });
  const todayEntries = store.find('entry_record', e => e.entry_time?.startsWith(today));
  const todayRefunds = store.find('refund_record', r => r.processed_at?.startsWith(today));

  const versions = store.getAll('maturity_version');
  const totalRipe = versions.reduce((s, v) => s + (v.ripe_weight || 0), 0);
  const totalLocked = versions.reduce((s, v) => s + (v.locked_weight || 0), 0);
  const totalPicked = versions.reduce((s, v) => s + (v.picked_weight || 0), 0);

  const pendingExceptions = store.find('exception_record', e => e.handle_status === 'PENDING').length;
  const closureAlerts = store.find('weather_alert', a => a.is_closed === 1 && a.status === 'ACTIVE');

  const todayStats = {
    slot_count: todaySlots.length,
    closure_slots: todaySlots.filter(s => s.status === 'CLOSURE').length,
    total_capacity: todaySlots.reduce((s, x) => s + (x.status === 'AVAILABLE' ? x.max_capacity : 0), 0),
    reserved_count: todayReservations.filter(r => r.status === 'CONFIRMED').length,
    reservation_amount: Math.round(todayReservations.filter(r => r.status === 'CONFIRMED').reduce((s, r) => s + (r.total_amount || 0), 0) * 100) / 100,
    entry_count: todayEntries.filter(e => e.entry_status !== 'LEFT').length,
    in_garden_count: todayEntries.filter(e => e.entry_status === 'IN_GARDEN').length,
    left_count: todayEntries.filter(e => e.entry_status === 'LEFT').length,
    refund_count: todayRefunds.length,
    refund_amount: Math.round(todayRefunds.reduce((s, r) => s + (r.total_refund || 0), 0) * 100) / 100
  };

  res.json({ code: 0, data: {
    today,
    today_stats: todayStats,
    fruit_stats: {
      total_ripe: totalRipe,
      total_available: Math.max(0, totalRipe - totalLocked),
      total_locked: totalLocked,
      total_picked: totalPicked,
      available_rate: totalRipe > 0 ? Math.round(Math.max(0, totalRipe - totalLocked) / totalRipe * 100) : 0
    },
    alert_count: closureAlerts.length,
    closure_slots: todayStats.closure_slots,
    pending_exceptions: pendingExceptions,
    recent_alerts: closureAlerts.slice(0, 3)
  }});
});

module.exports = router;
