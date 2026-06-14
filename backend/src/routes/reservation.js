const express = require('express');
const router = express.Router();
const store = require('../store');
const { nowDateTime, isBlacklisted, isClosureDate, calcSlotAvailableWeight, calcTicketWeight, tryLockWeight, fullyReleaseLockedWeight, tryCalcRefund } = require('../utils');

function genNo(prefix) {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${ts}-${rand}`;
}

// 预约查询(列表)
router.get('/', (req, res) => {
  const { visitor_phone, status, slot_id } = req.query;
  let list = store.getAll('reservation');
  if (visitor_phone) list = list.filter(r => r.visitor_phone === visitor_phone);
  if (status) list = list.filter(r => r.status === status);
  if (slot_id) list = list.filter(r => r.slot_id === Number(slot_id));
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  const tickets = store.getAll('picking_ticket');
  const slots = store.getAll('time_slot');
  const ticketMap = new Map(tickets.map(t => [t.id, t]));
  const slotMap = new Map(slots.map(s => [s.id, s]));
  const data = list.map(r => ({
    ...r,
    ticket: ticketMap.get(r.ticket_id) || null,
    slot: slotMap.get(r.slot_id) || null
  }));
  res.json({ code: 0, data });
});

// 预约详情
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = store.getById('reservation', id);
  if (!r) return res.json({ code: 404, message: '预约不存在' });
  const ticket = store.getById('picking_ticket', r.ticket_id);
  const slot = store.getById('time_slot', r.slot_id);
  const entry = store.findOne('entry_record', e => e.reservation_id === id);
  const deposit = store.findOne('deposit_record', d => d.reservation_id === id);
  const refund = store.find('refund_record', rf => rf.reservation_id === id);
  const exception = store.find('exception_record', e => e.reservation_id === id);
  res.json({ code: 0, data: { ...r, ticket, slot, entry, deposit, refunds: refund, exceptions: exception } });
});

// 根据预约号查询
router.get('/no/:reservation_no', (req, res) => {
  const r = store.findOne('reservation', x => x.reservation_no === req.params.reservation_no);
  if (!r) return res.json({ code: 404, message: '预约不存在' });
  const ticket = store.getById('picking_ticket', r.ticket_id);
  const slot = store.getById('time_slot', r.slot_id);
  res.json({ code: 0, data: { ...r, ticket, slot } });
});

// 创建预约
router.post('/', (req, res) => {
  const {
    visitor_phone, visitor_name, visitor_type, visitor_idcard,
    slot_id, ticket_id, group_size, adult_count, child_count,
    remark, source
  } = req.body;

  if (!visitor_phone || !visitor_name || !slot_id || !ticket_id || !group_size) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }

  const slot = store.getById('time_slot', Number(slot_id));
  if (!slot) return res.json({ code: 404, message: '时段不存在' });

  if (slot.status === 'CLOSURE') {
    return res.json({ code: 4102, message: `该时段已闭园：${slot.limit_reason || '闭园'}` });
  }

  const closure = isClosureDate(slot.slot_date);
  if (closure) {
    return res.json({ code: 4102, message: `${closure.alert_date} ${closure.alert_type}${closure.alert_level}，当日闭园，无法预约` });
  }

  const black = isBlacklisted(visitor_phone, visitor_idcard);
  if (black) {
    return res.json({ code: 4101, message: `您已被列入黑名单：${black.reason}` });
  }

  const ticket = store.getById('picking_ticket', Number(ticket_id));
  if (!ticket) return res.json({ code: 404, message: '采摘券不存在' });

  if (ticket.status !== 'ACTIVE') {
    return res.json({ code: 400, message: '采摘券已下架' });
  }

  const gs = Number(group_size) || 1;
  const ac = Number(adult_count) || (visitor_type === 'CHILD' ? 0 : gs);
  const cc = Number(child_count) || 0;

  if (slot.max_capacity - (slot.reserved_count || 0) < gs) {
    return res.json({ code: 4103, message: `时段容量不足，剩余${slot.max_capacity - (slot.reserved_count || 0)}人` });
  }

  if (slot.is_limited === 1) {
    return res.json({ code: 4104, message: `该时段已限流：${slot.limit_reason || '限流'}` });
  }

  const weightInfo = calcTicketWeight(Number(ticket_id), gs);
  const availableWeight = calcSlotAvailableWeight(Number(slot_id));

  if (availableWeight < weightInfo.estimated) {
    return res.json({ code: 4105, message: `成熟果量不足。需要约${weightInfo.estimated.toFixed(1)}斤，当前可用${availableWeight.toFixed(1)}斤` });
  }

  const reservation_no = genNo('RE');
  const total_amount = Math.round(ticket.price * gs * 100) / 100;
  const deposit_amount = Math.round(ticket.deposit * gs * 100) / 100;
  const payable_total = Math.round((total_amount + deposit_amount) * 100) / 100;

  const lockResult = tryLockWeight(Number(slot_id), weightInfo.estimated, null);
  if (!lockResult.success) {
    return res.json({ code: 4105, message: lockResult.message });
  }

  const reservation = store.insert('reservation', {
    reservation_no,
    visitor_phone, visitor_name,
    visitor_type: visitor_type || (ticket.ticket_type === 'CHILD' ? 'CHILD' : 'ADULT'),
    visitor_idcard: visitor_idcard || null,
    slot_id: Number(slot_id),
    ticket_id: Number(ticket_id),
    group_size: gs,
    adult_count: ac,
    child_count: cc,
    estimated_weight: weightInfo.estimated,
    included_weight: weightInfo.included,
    extra_weight_limit: weightInfo.extraLimit,
    total_amount,
    deposit_amount,
    payable_total,
    payment_status: 'PAID',
    status: 'CONFIRMED',
    locked_weight: weightInfo.estimated,
    lock_details: JSON.stringify(lockResult.lockedDetails),
    remark: remark || '',
    source: source || 'WEB'
  });

  store.update('time_slot', slot.id, { reserved_count: (slot.reserved_count || 0) + gs });

  store.insert('deposit_record', {
    deposit_no: genNo('DP'),
    reservation_id: reservation.id,
    visitor_phone,
    original_amount: deposit_amount,
    paid_amount: deposit_amount,
    paid_at: nowDateTime(),
    remaining_amount: deposit_amount,
    status: 'HELD'
  });

  res.json({ code: 0, data: { ...reservation, lock_details_parsed: lockResult.lockedDetails } });
});

// 退款试算(取消前预览)
router.post('/:id/refund-preview', (req, res) => {
  const id = Number(req.params.id);
  const { reason, extraWeightCharge, damageCharge, damageReason } = req.body;
  const result = tryCalcRefund(id, reason || 'USER_CANCEL', {
    extraWeightCharge: Number(extraWeightCharge) || 0,
    damageCharge: Number(damageCharge) || 0,
    damageReason: damageReason || ''
  });
  res.json({ code: result.success ? 0 : 400, message: result.message, data: result });
});

// 取消预约
router.post('/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const { cancel_reason, operator } = req.body;
  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });
  if (reservation.status !== 'CONFIRMED') {
    return res.json({ code: 400, message: `当前状态${reservation.status}不允许取消` });
  }

  const refundCalc = tryCalcRefund(id, cancel_reason || 'USER_CANCEL');
  if (!refundCalc.success) return res.json({ code: 400, message: refundCalc.message });

  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const slot = store.getById('time_slot', reservation.slot_id);

  if (reservation.lock_details) {
    try {
      const lockDetails = JSON.parse(reservation.lock_details);
      fullyReleaseLockedWeight(reservation.slot_id, lockDetails);
    } catch (e) {}
  }
  if (slot) {
    store.update('time_slot', slot.id, {
      reserved_count: Math.max(0, (slot.reserved_count || 0) - reservation.group_size)
    });
  }

  const updated = store.update('reservation', id, {
    status: 'CANCELLED',
    cancel_reason: cancel_reason || '用户取消',
    cancelled_at: nowDateTime(),
    refund_amount: refundCalc.total_refund
  });

  store.updateWhere('deposit_record', d => d.reservation_id === id && d.status === 'HELD', {
    status: refundCalc.deposit_refund > 0 ? 'REFUNDED' : 'DEDUCTED',
    remaining_amount: Math.max(0, (deposit => deposit - refundCalc.total_deduction)(reservation.deposit_amount)),
    refunded_amount: refundCalc.deposit_refund
  });

  const refund = store.insert('refund_record', {
    refund_no: genNo('RF'),
    reservation_id: id,
    visitor_phone: reservation.visitor_phone,
    original_ticket_amount: refundCalc.original_ticket_amount,
    original_deposit_amount: refundCalc.original_deposit_amount,
    ticket_refund: refundCalc.ticket_refund,
    deposit_refund: refundCalc.deposit_refund,
    total_refund: refundCalc.total_refund,
    total_deduction: refundCalc.total_deduction,
    refund_reason: refundCalc.refund_reason,
    refund_rate: refundCalc.refund_rate,
    picking_progress: refundCalc.picking_progress,
    deduction_detail: JSON.stringify(refundCalc.deduction_detail),
    refund_status: 'PROCESSED',
    processed_at: nowDateTime(),
    operator: operator || 'system'
  });

  res.json({ code: 0, data: { reservation: updated, refund } });
});

// 闭园批量处理(处理闭园日已有的预约)
router.post('/closure-process', (req, res) => {
  const { slot_date, alert_id, operator } = req.body;
  if (!slot_date) return res.json({ code: 400, message: '日期必填' });

  const slots = store.find('time_slot', s => s.slot_date === slot_date);
  const slotIds = slots.map(s => s.id);
  const reservations = store.find('reservation', r => slotIds.includes(r.slot_id) && r.status === 'CONFIRMED');

  const processed = [];
  for (const r of reservations) {
    const refundCalc = tryCalcRefund(r.id, 'CLOSURE');
    if (!refundCalc.success) continue;

    if (r.lock_details) {
      try { fullyReleaseLockedWeight(r.slot_id, JSON.parse(r.lock_details)); } catch (e) {}
    }
    const slot = store.getById('time_slot', r.slot_id);
    if (slot) {
      store.update('time_slot', slot.id, {
        reserved_count: Math.max(0, (slot.reserved_count || 0) - r.group_size)
      });
    }

    store.update('reservation', r.id, {
      status: 'CANCELLED',
      cancel_reason: `闭园取消：${slots[0]?.limit_reason || '暴雨'}`,
      cancelled_at: nowDateTime(),
      refund_amount: refundCalc.total_refund
    });

    store.updateWhere('deposit_record', d => d.reservation_id === r.id && d.status === 'HELD', {
      status: 'REFUNDED',
      remaining_amount: 0,
      refunded_amount: refundCalc.deposit_refund
    });

    store.insert('refund_record', {
      refund_no: `RF-CL-${r.reservation_no}`,
      reservation_id: r.id,
      visitor_phone: r.visitor_phone,
      original_ticket_amount: refundCalc.original_ticket_amount,
      original_deposit_amount: refundCalc.original_deposit_amount,
      ticket_refund: refundCalc.ticket_refund,
      deposit_refund: refundCalc.deposit_refund,
      total_refund: refundCalc.total_refund,
      total_deduction: refundCalc.total_deduction,
      refund_reason: refundCalc.refund_reason,
      refund_rate: refundCalc.refund_rate,
      picking_progress: 0,
      deduction_detail: JSON.stringify(refundCalc.deduction_detail),
      refund_status: 'PROCESSED',
      processed_at: nowDateTime(),
      operator: operator || 'system'
    });

    store.insert('closure_record', {
      closure_no: genNo('CR'),
      alert_id: alert_id || null,
      reservation_id: r.id,
      visitor_phone: r.visitor_phone,
      original_ticket: refundCalc.original_ticket_amount,
      original_deposit: refundCalc.original_deposit_amount,
      refund_amount: refundCalc.total_refund,
      refund_status: 'PROCESSED',
      operator: operator || 'system',
      executed_at: nowDateTime()
    });

    processed.push(r.id);
  }

  res.json({ code: 0, data: { count: processed.length, reservation_ids: processed, slot_date } });
});

module.exports = router;
