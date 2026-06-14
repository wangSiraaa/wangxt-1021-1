const express = require('express');
const router = express.Router();
const store = require('../store');
const { nowDateTime, tryCalcRefund, releaseLockedWeight, fullyReleaseLockedWeight, calcSlotAvailableWeight, tryLockWeight } = require('../utils');

function genNo(prefix) {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${ts}-${rand}`;
}

// 入园核销记录列表
router.get('/entry-records', (req, res) => {
  const { slot_id, entry_status } = req.query;
  let list = store.getAll('entry_record');
  if (slot_id) list = list.filter(e => e.slot_id === Number(slot_id));
  if (entry_status) list = list.filter(e => e.entry_status === entry_status);
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ code: 0, data: list });
});

// 入园核销
router.post('/entry', (req, res) => {
  const { reservation_id, reservation_no, visitor_phone, checked_by, operator } = req.body;

  let reservation;
  if (reservation_id) {
    reservation = store.getById('reservation', Number(reservation_id));
  } else if (reservation_no) {
    reservation = store.findOne('reservation', r => r.reservation_no === reservation_no);
  } else if (visitor_phone) {
    reservation = store.findOne('reservation', r =>
      r.visitor_phone === visitor_phone && r.status === 'CONFIRMED'
    );
  }

  if (!reservation) {
    return res.json({ code: 404, message: '预约记录不存在' });
  }
  if (reservation.status !== 'CONFIRMED') {
    return res.json({ code: 400, message: `预约状态为${reservation.status}，无法入园` });
  }

  const existing = store.findOne('entry_record', e =>
    e.reservation_id === reservation.id && e.entry_status !== 'LEFT'
  );
  if (existing) {
    return res.json({ code: 400, message: '该预约已在园内' });
  }

  const slot = store.getById('time_slot', reservation.slot_id);
  const ticket = store.getById('picking_ticket', reservation.ticket_id);

  const entry = store.insert('entry_record', {
    entry_no: genNo('EN'),
    reservation_id: reservation.id,
    visitor_phone: reservation.visitor_phone,
    group_size: reservation.group_size,
    slot_id: reservation.slot_id,
    slot_date: slot?.slot_date,
    slot_start: slot?.slot_start,
    slot_end: slot?.slot_end,
    ticket_id: reservation.ticket_id,
    included_weight: reservation.included_weight,
    extra_weight_limit: reservation.extra_weight_limit,
    entry_time: nowDateTime(),
    entry_status: 'IN_GARDEN',
    actual_picked_weight: 0,
    picking_progress: 0,
    checked_by: checked_by || operator || '现场人员',
    operator: operator || '现场人员'
  });

  store.update('time_slot', reservation.slot_id, {
    entered_count: (slot?.entered_count || 0) + reservation.group_size
  });

  res.json({ code: 0, data: { entry, reservation, ticket, slot } });
});

// 更新采摘进度和采摘重量(现场录入)
router.put('/entry/:id/progress', (req, res) => {
  const id = Number(req.params.id);
  const { actual_picked_weight, picking_progress, operator } = req.body;
  const entry = store.getById('entry_record', id);
  if (!entry) return res.json({ code: 404, message: '入园记录不存在' });
  const updates = {};
  if (actual_picked_weight != null) updates.actual_picked_weight = Number(actual_picked_weight) || 0;
  if (picking_progress != null) updates.picking_progress = Number(picking_progress) || 0;
  if (operator) updates.operator = operator;
  const updated = store.update('entry_record', id, updates);
  res.json({ code: 0, data: updated });
});

// 补采(额外增加采摘重量锁量)
router.post('/entry/:id/supplement', (req, res) => {
  const id = Number(req.params.id);
  const { extra_weight, operator, reason } = req.body;
  const entry = store.getById('entry_record', id);
  if (!entry) return res.json({ code: 404, message: '入园记录不存在' });
  if (entry.entry_status === 'LEFT') {
    return res.json({ code: 400, message: '已离园，无法补采' });
  }
  const ew = Number(extra_weight) || 0;
  if (ew <= 0) return res.json({ code: 400, message: '补采重量需大于0' });

  const reservation = store.getById('reservation', entry.reservation_id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  const available = calcSlotAvailableWeight(entry.slot_id);
  if (available < ew) {
    return res.json({ code: 4105, message: `可用成熟果量不足，当前剩余${available.toFixed(1)}斤` });
  }

  const lockResult = tryLockWeight(entry.slot_id, ew, reservation.id);
  if (!lockResult.success) {
    return res.json({ code: 4105, message: lockResult.message });
  }

  const updates = {
    actual_picked_weight: (entry.actual_picked_weight || 0),
    picking_progress: Math.min(100, (entry.picking_progress || 0) + Math.round(ew / (reservation.estimated_weight || 1) * 100))
  };
  const updated = store.update('entry_record', id, updates);

  store.update('reservation', reservation.id, {
    estimated_weight: (reservation.estimated_weight || 0) + ew,
    extra_weight_limit: (reservation.extra_weight_limit || 0) + ew
  });

  res.json({ code: 0, data: { entry: updated, lockResult, supplement_weight: ew, reason: reason || '' } });
});

// 离园结算(扣费处理 + 锁量释放)
router.post('/entry/:id/leave', (req, res) => {
  const id = Number(req.params.id);
  const {
    actual_picked_weight, picking_progress,
    extra_weight_charge, damage_charge, damage_reason,
    operator
  } = req.body;

  const entry = store.getById('entry_record', id);
  if (!entry) return res.json({ code: 404, message: '入园记录不存在' });
  if (entry.entry_status === 'LEFT') {
    return res.json({ code: 400, message: '已离园' });
  }

  const reservation = store.getById('reservation', entry.reservation_id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  const apw = actual_picked_weight != null ? Number(actual_picked_weight) : (entry.actual_picked_weight || 0);
  const pp = picking_progress != null ? Number(picking_progress) : (entry.picking_progress || 0);
  const ewc = Number(extra_weight_charge) || 0;
  const dc = Number(damage_charge) || 0;

  store.update('entry_record', id, {
    actual_picked_weight: apw,
    picking_progress: pp,
    entry_status: 'LEFT',
    leave_time: nowDateTime(),
    operator: operator || entry.operator
  });

  const refundCalc = tryCalcRefund(reservation.id, 'EARLY_LEAVE', {
    extraWeightCharge: ewc,
    damageCharge: dc,
    damageReason: damage_reason || ''
  });
  if (!refundCalc.success) {
    return res.json({ code: 400, message: refundCalc.message });
  }

  if (reservation.lock_details) {
    try {
      const lockDetails = JSON.parse(reservation.lock_details);
      const releaseResult = releaseLockedWeight(reservation.slot_id, reservation.id, apw || reservation.included_weight || 0);
      if (!releaseResult.success) {
        fullyReleaseLockedWeight(reservation.slot_id, lockDetails);
      }
    } catch (e) {
      console.warn('释放锁量异常:', e.message);
    }
  }

  store.update('reservation', reservation.id, {
    status: 'COMPLETED',
    completed_at: nowDateTime(),
    refund_amount: refundCalc.total_refund
  });

  const slot = store.getById('time_slot', reservation.slot_id);
  if (slot) {
    store.update('time_slot', slot.id, {
      entered_count: Math.max(0, (slot.entered_count || 0) - reservation.group_size)
    });
  }

  store.updateWhere('deposit_record', d => d.reservation_id === reservation.id && d.status === 'HELD', {
    status: refundCalc.deposit_refund > 0 ? 'REFUNDED' : (refundCalc.total_deduction > 0 ? 'DEDUCTED' : 'RETURNED'),
    remaining_amount: Math.max(0, refundCalc.deposit_refund),
    refunded_amount: refundCalc.deposit_refund,
    deducted_amount: refundCalc.total_deduction
  });

  const refund = store.insert('refund_record', {
    refund_no: genNo('RF'),
    reservation_id: reservation.id,
    visitor_phone: reservation.visitor_phone,
    original_ticket_amount: refundCalc.original_ticket_amount,
    original_deposit_amount: refundCalc.original_deposit_amount,
    ticket_refund: refundCalc.ticket_refund,
    deposit_refund: refundCalc.deposit_refund,
    total_refund: refundCalc.total_refund,
    total_deduction: refundCalc.total_deduction,
    refund_reason: refundCalc.refund_reason,
    refund_rate: refundCalc.refund_rate,
    picking_progress: pp,
    deduction_detail: JSON.stringify(refundCalc.deduction_detail),
    refund_status: 'PROCESSED',
    processed_at: nowDateTime(),
    operator: operator || 'system'
  });

  res.json({ code: 0, data: {
    entry_id: id,
    actual_picked_weight: apw,
    picking_progress: pp,
    refund,
    deduction_detail: refundCalc.deduction_detail,
    total_refund: refundCalc.total_refund,
    total_deduction: refundCalc.total_deduction
  }});
});

// 异常记录列表
router.get('/exceptions', (req, res) => {
  const { handle_status, reservation_id } = req.query;
  let list = store.getAll('exception_record');
  if (handle_status) list = list.filter(e => e.handle_status === handle_status);
  if (reservation_id) list = list.filter(e => e.reservation_id === Number(reservation_id));
  list = list.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ code: 0, data: list });
});

// 提交异常记录
router.post('/exceptions', (req, res) => {
  const {
    reservation_id, visitor_phone, exception_type, severity,
    description, impact_weight, compensation_amount, operator,
    handle_remark
  } = req.body;

  if (!reservation_id || !exception_type) {
    return res.json({ code: 400, message: '必要字段缺失' });
  }

  const exc = store.insert('exception_record', {
    exception_no: genNo('EX'),
    reservation_id: Number(reservation_id),
    visitor_phone: visitor_phone || '',
    exception_type,
    severity: severity || 'NORMAL',
    description: description || '',
    impact_weight: Number(impact_weight) || 0,
    compensation_amount: Number(compensation_amount) || 0,
    handle_status: handle_remark ? 'HANDLED' : 'PENDING',
    handle_remark: handle_remark || '',
    operator: operator || '现场人员',
    handled_at: handle_remark ? nowDateTime() : null
  });

  if (handle_remark && exc.compensation_amount > 0) {
    store.insert('refund_record', {
      refund_no: genNo('RF-EXC'),
      reservation_id: Number(reservation_id),
      visitor_phone: visitor_phone || '',
      original_ticket_amount: 0,
      original_deposit_amount: 0,
      ticket_refund: 0,
      deposit_refund: 0,
      compensation_refund: exc.compensation_amount,
      total_refund: exc.compensation_amount,
      total_deduction: 0,
      refund_reason: `异常补偿-${exception_type}`,
      refund_rate: 0,
      picking_progress: 0,
      deduction_detail: JSON.stringify([{ type: '异常补偿', amount: exc.compensation_amount, reason: handle_remark }]),
      refund_status: 'PROCESSED',
      processed_at: nowDateTime(),
      operator: operator || 'manager',
      source_type: 'EXCEPTION',
      source_id: exc.id
    });
  }

  res.json({ code: 0, data: exc });
});

// 处理异常
router.put('/exceptions/:id/handle', (req, res) => {
  const id = Number(req.params.id);
  const { handle_remark, compensation_amount, operator } = req.body;
  if (!handle_remark) return res.json({ code: 400, message: '处理意见必填' });
  const ca = Number(compensation_amount) || 0;
  const exc = store.update('exception_record', id, {
    handle_status: 'HANDLED',
    handle_remark,
    compensation_amount: ca,
    operator: operator || 'manager',
    handled_at: nowDateTime()
  });
  if (!exc) return res.json({ code: 404, message: '异常记录不存在' });

  if (ca > 0) {
    const exists = store.findOne('refund_record', r =>
      r.source_type === 'EXCEPTION' && r.source_id === id
    );
    if (!exists) {
      store.insert('refund_record', {
        refund_no: `RF-EXC-${id}`,
        reservation_id: exc.reservation_id,
        visitor_phone: exc.visitor_phone,
        original_ticket_amount: 0,
        original_deposit_amount: 0,
        ticket_refund: 0,
        deposit_refund: 0,
        compensation_refund: ca,
        total_refund: ca,
        total_deduction: 0,
        refund_reason: `异常补偿-${exc.exception_type}`,
        refund_rate: 0,
        picking_progress: 0,
        deduction_detail: JSON.stringify([{ type: '异常补偿', amount: ca, reason: handle_remark }]),
        refund_status: 'PROCESSED',
        processed_at: nowDateTime(),
        operator: operator || 'manager',
        source_type: 'EXCEPTION',
        source_id: id
      });
    }
  }
  res.json({ code: 0, data: exc });
});

// 强制释放锁量(管理员使用)
router.post('/release-lock', (req, res) => {
  const { reservation_id, operator, reason } = req.body;
  if (!reservation_id) return res.json({ code: 400, message: '预约ID必填' });
  const reservation = store.getById('reservation', Number(reservation_id));
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });
  let released = 0;
  if (reservation.lock_details) {
    try {
      const lockDetails = JSON.parse(reservation.lock_details);
      const result = fullyReleaseLockedWeight(reservation.slot_id, lockDetails);
      released = result.count || 0;
      store.update('reservation', reservation.id, {
        lock_details: '[]',
        locked_weight: 0,
        lock_release_reason: reason || '管理员强制释放',
        lock_release_at: nowDateTime(),
        lock_release_operator: operator || '管理员'
      });
    } catch (e) {
      return res.json({ code: 500, message: '释放失败: ' + e.message });
    }
  }
  res.json({ code: 0, data: { reservation_id, released_weight: released, reason: reason || '' } });
});

module.exports = router;
