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

// 候补队列可视化
router.get('/waitlist-dashboard', (req, res) => {
  const { date } = req.query;
  const targetDate = date || nowDate();

  const slots = store.find('time_slot', s => !date || s.slot_date === targetDate);
  const slotIds = slots.map(s => s.id);

  const allWaitlist = store.find('waitlist', w => slotIds.includes(w.slot_id));
  const tickets = store.getAll('picking_ticket');
  const ticketMap = new Map(tickets.map(t => [t.id, t]));

  const slotWaitlist = slots.map(s => {
    const wl = allWaitlist.filter(w => w.slot_id === s.id);
    const waiting = wl.filter(w => w.status === 'WAITING');
    const promoted = wl.filter(w => w.status === 'PROMOTED');
    const converted = wl.filter(w => w.status === 'CONVERTED');
    const cancelled = wl.filter(w => w.status === 'CANCELLED');
    const waitingWeight = waiting.reduce((s, w) => s + (w.estimated_weight || 0), 0);
    const waitingCapacity = waiting.reduce((s, w) => s + (w.group_size || 0), 0);

    return {
      slot_id: s.id,
      slot_date: s.slot_date,
      slot_label: s.slot_label,
      slot_status: s.status,
      max_capacity: s.max_capacity,
      reserved_count: s.reserved_count || 0,
      available_capacity: Math.max(0, s.max_capacity - (s.reserved_count || 0)),
      total: wl.length,
      waiting_count: waiting.length,
      promoted_count: promoted.length,
      converted_count: converted.length,
      cancelled_count: cancelled.length,
      waiting_capacity: waitingCapacity,
      waiting_weight: Math.round(waitingWeight * 100) / 100,
      queue: waiting
        .sort((a, b) => a.queue_position - b.queue_position)
        .slice(0, 10)
        .map(w => ({
          id: w.id,
          waitlist_no: w.waitlist_no,
          visitor_name: w.visitor_name,
          visitor_phone: w.visitor_phone,
          group_size: w.group_size,
          estimated_weight: w.estimated_weight,
          queue_position: w.queue_position,
          created_at: w.created_at,
          ticket_name: ticketMap.get(w.ticket_id)?.ticket_name || ''
        }))
    };
  });

  const summary = {
    total_slots: slots.length,
    closure_slots: slots.filter(s => s.status === 'CLOSURE').length,
    total_waitlist: allWaitlist.length,
    total_waiting: allWaitlist.filter(w => w.status === 'WAITING').length,
    total_promoted: allWaitlist.filter(w => w.status === 'PROMOTED').length,
    total_converted: allWaitlist.filter(w => w.status === 'CONVERTED').length,
    total_cancelled: allWaitlist.filter(w => w.status === 'CANCELLED').length,
    convert_rate: allWaitlist.length > 0
      ? Math.round(allWaitlist.filter(w => w.status === 'CONVERTED').length / allWaitlist.length * 100)
      : 0
  };

  res.json({ code: 0, data: { date: targetDate, summary, slots: slotWaitlist } });
});

// 分批入园进度
router.get('/batch-entry-dashboard', (req, res) => {
  const { date, slot_id } = req.query;
  const targetDate = date || nowDate();

  let slots = store.find('time_slot', s => !date || s.slot_date === targetDate);
  if (slot_id) slots = slots.filter(s => s.id === Number(slot_id));
  const slotIds = slots.map(s => s.id);

  const reservations = store.find('reservation', r => slotIds.includes(r.slot_id));
  const resIds = reservations.map(r => r.id);
  const allBatches = store.find('batch_entry', b => resIds.includes(b.reservation_id));
  const allEntries = store.find('entry_record', e => resIds.includes(e.reservation_id));
  const entryMap = new Map(allEntries.map(e => [e.id, e]));

  const resMap = new Map(reservations.map(r => [
    r.id,
    {
      id: r.id,
      reservation_no: r.reservation_no,
      visitor_name: r.visitor_name,
      group_size: r.group_size,
      slot_id: r.slot_id
    }
  ]));

  const slotData = slots.map(s => {
    const slotResIds = reservations.filter(r => r.slot_id === s.id).map(r => r.id);
    const slotBatches = allBatches.filter(b => slotResIds.includes(b.reservation_id));
    const inGarden = slotBatches.filter(b => b.entry_status === 'IN_GARDEN');
    const left = slotBatches.filter(b => b.entry_status === 'LEFT');

    const batchByReservation = {};
    for (const b of slotBatches) {
      if (!batchByReservation[b.reservation_id]) {
        const r = resMap.get(b.reservation_id);
        batchByReservation[b.reservation_id] = {
          reservation: r,
          batches: [],
          in_count: 0,
          left_count: 0,
          total_count: 0
        };
      }
      batchByReservation[b.reservation_id].batches.push({
        ...b,
        entry_record: entryMap.get(b.entry_record_id) || null
      });
      if (b.entry_status === 'IN_GARDEN') {
        batchByReservation[b.reservation_id].in_count += b.batch_count;
      } else {
        batchByReservation[b.reservation_id].left_count += b.batch_count;
      }
      batchByReservation[b.reservation_id].total_count += b.batch_count;
    }

    return {
      slot_id: s.id,
      slot_date: s.slot_date,
      slot_label: s.slot_label,
      max_capacity: s.max_capacity,
      entered_count: s.entered_count || 0,
      batch_groups: Object.values(batchByReservation).map(g => ({
        ...g,
        remaining: (g.reservation?.group_size || 0) - g.total_count
      }))
    };
  });

  const summary = {
    total_batch_groups: allBatches.filter((v, i, a) =>
      a.findIndex(x => x.reservation_id === v.reservation_id) === i
    ).length,
    total_batches: allBatches.length,
    in_garden_batches: allBatches.filter(b => b.entry_status === 'IN_GARDEN').length,
    in_garden_count: allBatches.filter(b => b.entry_status === 'IN_GARDEN')
      .reduce((s, b) => s + b.batch_count, 0),
    left_batches: allBatches.filter(b => b.entry_status === 'LEFT').length,
    left_count: allBatches.filter(b => b.entry_status === 'LEFT')
      .reduce((s, b) => s + b.batch_count, 0)
  };

  res.json({ code: 0, data: { date: targetDate, summary, slots: slotData } });
});

// 加购收入统计
router.get('/addon-revenue', (req, res) => {
  const { start_date, end_date, group_by } = req.query;
  const targetDate = nowDate();
  const startDate = start_date || targetDate;
  const endDate = end_date || targetDate;

  const allAddonOrders = store.find('addon_order', a => {
    const d = (a.created_at || '').substring(0, 10);
    return d >= startDate && d <= endDate;
  });

  const allOnSiteExtra = store.find('on_site_extra', o => {
    const d = (o.updated_at || o.created_at || '').substring(0, 10);
    return d >= startDate && d <= endDate;
  });

  const services = store.getAll('addon_service');
  const svcMap = new Map(services.map(s => [s.id, s]));

  const serviceStats = {};
  let orderRevenue = 0;
  let addonCostTotal = 0;
  let extraChargeTotal = 0;
  let damageChargeTotal = 0;

  for (const order of allAddonOrders) {
    orderRevenue += order.total_amount || 0;
    try {
      const items = JSON.parse(order.items || '[]');
      for (const it of items) {
        const key = it.service_code || `SVC_${it.service_id}`;
        if (!serviceStats[key]) {
          serviceStats[key] = {
            service_code: it.service_code,
            service_name: it.service_name,
            service_type: it.service_type,
            count: 0,
            quantity: 0,
            amount: 0
          };
        }
        serviceStats[key].count++;
        serviceStats[key].quantity += it.quantity || 0;
        serviceStats[key].amount += it.sub_total || 0;
      }
    } catch (e) {}
  }

  for (const extra of allOnSiteExtra) {
    addonCostTotal += extra.addon_cost || 0;
    extraChargeTotal += extra.extra_weight_charge || 0;
    damageChargeTotal += extra.damage_charge || 0;
  }

  const data = {
    date_range: { start_date: startDate, end_date: endDate },
    order_count: allAddonOrders.length,
    order_revenue: Math.round(orderRevenue * 100) / 100,
    onsite_addon_cost: Math.round(addonCostTotal * 100) / 100,
    onsite_extra_weight_charge: Math.round(extraChargeTotal * 100) / 100,
    onsite_damage_charge: Math.round(damageChargeTotal * 100) / 100,
    onsite_total: Math.round((addonCostTotal + extraChargeTotal + damageChargeTotal) * 100) / 100,
    service_breakdown: Object.values(serviceStats).sort((a, b) => b.amount - a.amount)
  };

  res.json({ code: 0, data });
});

// 改期记录统计
router.get('/reschedule-stats', (req, res) => {
  const { start_date, end_date } = req.query;
  const targetDate = nowDate();
  const startDate = start_date || targetDate;
  const endDate = end_date || targetDate;

  const records = store.find('reschedule_record', r => {
    const d = (r.executed_at || '').substring(0, 10);
    return d >= startDate && d <= endDate;
  });

  const byReason = {};
  const byOperator = {};
  const byDate = {};

  for (const r of records) {
    const reason = r.reason || '未说明';
    const oper = r.operator || 'system';
    const d = (r.executed_at || '').substring(0, 10);

    if (!byReason[reason]) byReason[reason] = 0;
    byReason[reason]++;

    if (!byOperator[oper]) byOperator[oper] = 0;
    byOperator[oper]++;

    if (!byDate[d]) byDate[d] = 0;
    byDate[d]++;
  }

  res.json({ code: 0, data: {
    date_range: { start_date: startDate, end_date: endDate },
    total_count: records.length,
    recent_records: records.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 20),
    by_reason: Object.entries(byReason).map(([k, v]) => ({ reason: k, count: v }))
      .sort((a, b) => b.count - a.count),
    by_operator: Object.entries(byOperator).map(([k, v]) => ({ operator: k, count: v }))
      .sort((a, b) => b.count - a.count),
    by_date: Object.entries(byDate).map(([k, v]) => ({ date: k, count: v }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }});
});

// 三端统一状态看板
router.get('/state-dashboard', (req, res) => {
  const { date, limit } = req.query;
  const targetDate = date || nowDate();
  const lim = Math.min(Number(limit) || 50, 200);

  const slots = store.find('time_slot', s => s.slot_date === targetDate);
  const slotIds = slots.map(s => s.id);

  const reservations = store.find('reservation', r => slotIds.includes(r.slot_id))
    .sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, lim);

  const tickets = store.getAll('picking_ticket');
  const ticketMap = new Map(tickets.map(t => [t.id, t]));
  const slotMap = new Map(slots.map(s => [s.id, s]));

  const resIds = reservations.map(r => r.id);
  const entries = store.find('entry_record', e => resIds.includes(e.reservation_id));
  const entryMap = new Map(entries.map(e => [e.reservation_id, e]));
  const deposits = store.find('deposit_record', d => resIds.includes(d.reservation_id));
  const depositMap = new Map(deposits.map(d => [d.reservation_id, d]));
  const waitlists = store.find('waitlist', w => slotIds.includes(w.slot_id));
  const wlCountBySlot = {};
  for (const w of waitlists) {
    if (w.status === 'WAITING') {
      wlCountBySlot[w.slot_id] = (wlCountBySlot[w.slot_id] || 0) + 1;
    }
  }

  const lastSyncs = {};
  const syncLogs = store.find('state_sync_log', l => resIds.includes(l.reservation_id))
    .sort((a, b) => (b.id || 0) - (a.id || 0));
  for (const log of syncLogs) {
    if (!lastSyncs[log.reservation_id]) {
      lastSyncs[log.reservation_id] = log;
    }
  }

  const data = reservations.map(r => {
    const slot = slotMap.get(r.slot_id);
    const ticket = ticketMap.get(r.ticket_id);
    const entry = entryMap.get(r.id);
    const deposit = depositMap.get(r.id);
    const lastSync = lastSyncs[r.id];
    let state = {
      reservation_status: r.status,
      entry_status: entry?.entry_status || 'NOT_ENTERED',
      deposit_status: deposit?.status || 'NONE',
      waitlist_here: wlCountBySlot[r.slot_id] || 0
    };
    try {
      if (lastSync?.state_snapshot) {
        state = { ...state, ...JSON.parse(lastSync.state_snapshot) };
      }
    } catch (e) {}

    return {
      reservation: {
        id: r.id,
        reservation_no: r.reservation_no,
        status: r.status,
        visitor_name: r.visitor_name,
        visitor_phone: r.visitor_phone,
        group_size: r.group_size,
        estimated_weight: r.estimated_weight,
        included_weight: r.included_weight,
        total_amount: r.total_amount,
        deposit_amount: r.deposit_amount,
        refund_amount: r.refund_amount,
        reschedule_count: r.reschedule_count || 0,
        actual_picked_weight: r.actual_picked_weight
      },
      ticket: ticket ? {
        ticket_code: ticket.ticket_code, ticket_name: ticket.ticket_name
      } : null,
      slot: slot ? {
        slot_date: slot.slot_date, slot_label: slot.slot_label,
        slot_status: slot.status
      } : null,
      entry: entry ? {
        entry_status: entry.entry_status,
        entry_time: entry.entry_time,
        leave_time: entry.leave_time,
        actual_picked_weight: entry.actual_picked_weight,
        picking_progress: entry.picking_progress
      } : null,
      deposit: deposit ? {
        original_amount: deposit.original_amount,
        remaining_amount: deposit.remaining_amount,
        refunded_amount: deposit.refunded_amount,
        deducted_amount: deposit.deducted_amount,
        status: deposit.status
      } : null,
      unified_state: state,
      last_sync: lastSync ? {
        source: lastSync.source,
        operator: lastSync.operator,
        synced_at: lastSync.synced_at
      } : null,
      state_in_sync: !!lastSync
    };
  });

  const summary = {
    date: targetDate,
    total_reservations: reservations.length,
    by_status: {
      confirmed: reservations.filter(r => r.status === 'CONFIRMED').length,
      cancelled: reservations.filter(r => r.status === 'CANCELLED').length,
      completed: reservations.filter(r => r.status === 'COMPLETED').length
    },
    in_garden: entries.filter(e => e.entry_status === 'IN_GARDEN').length,
    total_waitlist: Object.values(wlCountBySlot).reduce((s, v) => s + v, 0),
    synced_count: data.filter(d => d.state_in_sync).length,
    sync_rate: data.length > 0 ? Math.round(data.filter(d => d.state_in_sync).length / data.length * 100) : 0
  };

  res.json({ code: 0, data: { summary, list: data } });
});

module.exports = router;
