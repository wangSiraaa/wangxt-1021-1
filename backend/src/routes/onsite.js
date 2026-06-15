const express = require('express');
const router = express.Router();
const store = require('../store');
const {
  nowDateTime, tryCalcRefund, releaseLockedWeight, fullyReleaseLockedWeight,
  calcSlotAvailableWeight, tryLockWeight, syncStateToAll
} = require('../utils');

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

// 家庭成员单独签到
router.post('/family/checkin', (req, res) => {
  const { reservation_id, member_ids, member_name, member_idcard, operator } = req.body;
  if (!reservation_id) return res.json({ code: 400, message: '预约ID必填' });

  const reservation = store.getById('reservation', Number(reservation_id));
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });
  if (reservation.status !== 'CONFIRMED') {
    return res.json({ code: 400, message: `预约状态${reservation.status}，无法签到` });
  }

  const now = nowDateTime();
  let checkedIn = [];

  if (member_ids && Array.isArray(member_ids) && member_ids.length > 0) {
    for (const mid of member_ids) {
      const m = store.getById('family_member', Number(mid));
      if (m && m.reservation_id === Number(reservation_id) && m.checkin_status === 'PENDING') {
        store.update('family_member', Number(mid), {
          checkin_status: 'CHECKED_IN',
          checkin_time: now,
          checkin_operator: operator || 'onsite'
        });
        checkedIn.push(m.id);
      }
    }
  } else if (member_name || member_idcard) {
    const list = store.find('family_member', f => f.reservation_id === Number(reservation_id));
    let matched = list.find(f =>
      (member_idcard && f.member_idcard === member_idcard) ||
      (member_name && f.member_name === member_name)
    );
    if (!matched) {
      matched = store.insert('family_member', {
        reservation_id: Number(reservation_id),
        visitor_phone: reservation.visitor_phone,
        member_name: member_name || '临时成员',
        member_idcard: member_idcard || '',
        relation: 'TEMP',
        age_group: 'ADULT',
        checkin_status: 'CHECKED_IN',
        checkin_time: now,
        checkin_operator: operator || 'onsite',
        created_at: now
      });
    } else if (matched.checkin_status === 'PENDING') {
      store.update('family_member', matched.id, {
        checkin_status: 'CHECKED_IN',
        checkin_time: now,
        checkin_operator: operator || 'onsite'
      });
    }
    checkedIn.push(matched.id);
  } else {
    return res.json({ code: 400, message: 'member_ids或member_name/member_idcard必填其一' });
  }

  const all = store.find('family_member', f => f.reservation_id === Number(reservation_id));
  const totalCheckedIn = all.filter(f => f.checkin_status === 'CHECKED_IN').length;
  const arrivalRate = all.length > 0 ? totalCheckedIn / all.length : null;

  syncStateToAll(Number(reservation_id), 'FAMILY_CHECKIN', operator || 'onsite');

  res.json({ code: 0, data: {
    checked_in_ids: checkedIn,
    checked_count: checkedIn.length,
    total_checked_in: totalCheckedIn,
    total_members: all.length,
    arrival_rate: arrivalRate
  }});
});

// 分批入园核销(团体客)
router.post('/batch-entry', (req, res) => {
  const {
    reservation_id, batch_name, batch_count, remark,
    checked_by, operator
  } = req.body;

  if (!reservation_id) return res.json({ code: 400, message: '预约ID必填' });
  const bc = Number(batch_count);
  if (!bc || bc <= 0) return res.json({ code: 400, message: '批次人数必须>0' });

  const reservation = store.getById('reservation', Number(reservation_id));
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });
  if (reservation.status !== 'CONFIRMED') {
    return res.json({ code: 400, message: `预约状态${reservation.status}，无法分批入园` });
  }

  const slot = store.getById('time_slot', reservation.slot_id);
  if (!slot) return res.json({ code: 404, message: '时段不存在' });
  if (slot.status === 'CLOSURE') {
    return res.json({ code: 4102, message: '该时段已闭园' });
  }

  const batches = store.find('batch_entry', b =>
    b.reservation_id === Number(reservation_id)
  );
  const alreadyIn = batches.reduce((s, b) => s + (b.entry_status !== 'LEFT' ? b.batch_count : 0), 0);
  const leftCapacity = reservation.group_size - alreadyIn;

  if (bc > leftCapacity) {
    return res.json({ code: 400, message: `剩余可分配人数${leftCapacity}，当前批次${bc}人超限` });
  }

  const existing = store.findOne('entry_record', e =>
    e.reservation_id === Number(reservation_id) && e.entry_status !== 'LEFT'
  );

  let entry = existing;
  if (!existing) {
    const ticket = store.getById('picking_ticket', reservation.ticket_id);
    entry = store.insert('entry_record', {
      entry_no: genNo('EN'),
      reservation_id: Number(reservation_id),
      visitor_phone: reservation.visitor_phone,
      group_size: reservation.group_size,
      slot_id: reservation.slot_id,
      slot_date: slot.slot_date,
      slot_start: slot.slot_start,
      slot_end: slot.slot_end,
      ticket_id: reservation.ticket_id,
      included_weight: reservation.included_weight,
      extra_weight_limit: reservation.extra_weight_limit,
      entry_time: nowDateTime(),
      entry_status: 'IN_GARDEN',
      actual_picked_weight: 0,
      picking_progress: 0,
      checked_by: checked_by || operator || '现场人员',
      operator: operator || '现场人员',
      is_batch_entry: 1
    });
    store.update('time_slot', reservation.slot_id, {
      entered_count: (slot.entered_count || 0) + bc
    });
  } else {
    store.update('time_slot', reservation.slot_id, {
      entered_count: (slot.entered_count || 0) + bc
    });
  }

  const batchEntry = store.insert('batch_entry', {
    batch_no: genNo('BE'),
    reservation_id: Number(reservation_id),
    entry_record_id: entry.id,
    batch_name: batch_name || `第${batches.length + 1}批`,
    batch_count: bc,
    entry_status: 'IN_GARDEN',
    entry_time: nowDateTime(),
    leave_time: null,
    remark: remark || '',
    checked_by: checked_by || operator || '现场人员',
    operator: operator || '现场人员'
  });

  syncStateToAll(Number(reservation_id), 'BATCH_ENTRY', operator || 'onsite');

  res.json({ code: 0, data: {
    batch_entry: batchEntry,
    entry_record: entry,
    already_in_count: alreadyIn + bc,
    remaining_count: leftCapacity - bc,
    total_capacity: reservation.group_size
  }});
});

// 分批离园
router.post('/batch-entry/:id/leave', (req, res) => {
  const id = Number(req.params.id);
  const { actual_picked_weight, picking_progress, operator } = req.body;
  const batch = store.getById('batch_entry', id);
  if (!batch) return res.json({ code: 404, message: '批次不存在' });
  if (batch.entry_status === 'LEFT') {
    return res.json({ code: 400, message: '该批次已离园' });
  }

  const now = nowDateTime();
  store.update('batch_entry', id, {
    entry_status: 'LEFT',
    leave_time: now,
    operator: operator || batch.operator
  });

  const slot = store.getById('time_slot', store.getById('batch_entry', id).slot_id ||
    store.getById('entry_record', batch.entry_record_id)?.slot_id || 0);
  if (slot) {
    store.update('time_slot', slot.id, {
      entered_count: Math.max(0, (slot.entered_count || 0) - batch.batch_count)
    });
  }

  const batches = store.find('batch_entry', b =>
    b.reservation_id === batch.reservation_id
  );
  const allLeft = batches.every(b => b.entry_status === 'LEFT');

  if (allLeft && actual_picked_weight != null) {
    const entry = store.getById('entry_record', batch.entry_record_id);
    if (entry && entry.entry_status !== 'LEFT') {
      store.update('entry_record', entry.id, {
        actual_picked_weight: Number(actual_picked_weight) || 0,
        picking_progress: Number(picking_progress) || 0,
        entry_status: 'LEFT',
        leave_time: now,
        operator: operator || entry.operator
      });
    }
  }

  syncStateToAll(batch.reservation_id, 'BATCH_LEAVE', operator || 'onsite');

  res.json({ code: 0, data: {
    batch_id: id,
    all_batches_left: allLeft,
    remaining_batches: batches.filter(b => b.entry_status !== 'LEFT').length
  }});
});

// 离园精细化结算(含部分采摘/超额/加购/成员到场率)
router.post('/entry/:id/final-settle', (req, res) => {
  const id = Number(req.params.id);
  const {
    actual_picked_weight,
    extra_weight_price,
    damage_charge,
    damage_reason,
    operator,
    auto_refund
  } = req.body;

  const entry = store.getById('entry_record', id);
  if (!entry) return res.json({ code: 404, message: '入园记录不存在' });
  if (entry.entry_status === 'LEFT' && entry.final_settled) {
    return res.json({ code: 400, message: '已完成最终结算' });
  }

  const reservation = store.getById('reservation', entry.reservation_id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  const slot = store.getById('time_slot', reservation.slot_id);
  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const now = nowDateTime();

  const apw = actual_picked_weight != null ? Number(actual_picked_weight) : (entry.actual_picked_weight || 0);
  const included = reservation.included_weight || 0;
  const extraLimit = reservation.extra_weight_limit || 0;

  let extraWeightCharge = 0;
  if (apw > included) {
    const overWeight = apw - included;
    if (overWeight > extraLimit + 0.01) {
      return res.json({ code: 400, message: `超量${overWeight.toFixed(1)}斤，超过允许超限${extraLimit.toFixed(1)}斤` });
    }
    const pricePerKg = Number(extra_weight_price) || (ticket?.extra_price_per_kg || 20);
    extraWeightCharge = Math.round(overWeight * pricePerKg * 100) / 100;
  }

  const family = store.find('family_member', f => f.reservation_id === reservation.id);
  const memberArrivalRate = family.length > 0
    ? family.filter(f => f.checkin_status === 'CHECKED_IN').length / family.length
    : null;

  const onSiteExtra = store.findOne('on_site_extra', o => o.reservation_id === reservation.id);
  const addonCost = onSiteExtra?.addon_cost || 0;
  const damageCharge = Number(damage_charge) || (onSiteExtra?.damage_charge || 0);

  if (extraWeightCharge > 0 || damageCharge > 0) {
    if (onSiteExtra) {
      store.update('on_site_extra', onSiteExtra.id, {
        extra_weight_charge: extraWeightCharge,
        damage_charge: damageCharge,
        damage_reason: damage_reason || '',
        updated_at: now
      });
    } else {
      store.insert('on_site_extra', {
        reservation_id: reservation.id,
        visitor_phone: reservation.visitor_phone,
        addon_cost: addonCost,
        extra_weight_charge: extraWeightCharge,
        damage_charge: damageCharge,
        damage_reason: damage_reason || '',
        created_at: now,
        updated_at: now
      });
    }
  }

  const refundCalc = tryCalcRefund(reservation.id, 'EARLY_LEAVE', {
    actualPickedWeight: apw,
    memberArrivalRate,
    extraWeightCharge,
    damageCharge,
    damageReason: damage_reason || ''
  });
  if (!refundCalc.success) {
    return res.json({ code: 400, message: refundCalc.message, data: refundCalc });
  }

  if (auto_refund !== false) {
    store.update('entry_record', id, {
      actual_picked_weight: apw,
      picking_progress: Math.round(apw / Math.max(0.01, reservation.estimated_weight || 1) * 100),
      entry_status: 'LEFT',
      leave_time: now,
      final_settled: 1,
      operator: operator || entry.operator
    });

    if (reservation.lock_details) {
      try {
        const releaseResult = releaseLockedWeight(reservation.slot_id, reservation.id, apw);
        if (!releaseResult.success) {
          fullyReleaseLockedWeight(reservation.slot_id, JSON.parse(reservation.lock_details));
        }
      } catch (e) {
        console.warn('锁量释放异常:', e.message);
      }
    }

    store.update('reservation', reservation.id, {
      status: 'COMPLETED',
      completed_at: now,
      refund_amount: refundCalc.total_refund,
      actual_picked_weight: apw
    });

    if (slot) {
      store.update('time_slot', slot.id, {
        entered_count: Math.max(0, (slot.entered_count || 0) - reservation.group_size)
      });
    }

    store.updateWhere('deposit_record', d => d.reservation_id === reservation.id && d.status === 'HELD', {
      status: refundCalc.deposit_refund > 0.01 ? 'REFUNDED' :
              (refundCalc.total_deduction > 0.01 ? 'DEDUCTED' : 'RETURNED'),
      remaining_amount: Math.max(0, refundCalc.deposit_refund),
      refunded_amount: refundCalc.deposit_refund,
      deducted_amount: refundCalc.total_deduction,
      settled_at: now
    });

    store.insert('refund_record', {
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
      picking_progress: refundCalc.picking_progress,
      deduction_detail: JSON.stringify(refundCalc.deduction_detail),
      refund_status: 'PROCESSED',
      processed_at: now,
      operator: operator || 'system',
      supplement_info: JSON.stringify(refundCalc.supplement_info || null),
      member_adjust_rate: refundCalc.member_adjust_rate || null
    });

    syncStateToAll(reservation.id, 'FINAL_SETTLE', operator || 'onsite');
  }

  res.json({ code: 0, data: {
    reservation_id: reservation.id,
    entry_id: id,
    actual_picked_weight: apw,
    included_weight: included,
    extra_weight: Math.max(0, apw - included),
    extra_weight_charge: extraWeightCharge,
    addon_cost: addonCost,
    damage_charge: damageCharge,
    member_arrival_rate: memberArrivalRate,
    member_adjust_rate: refundCalc.member_adjust_rate || null,
    refund_calc: refundCalc,
    auto_applied: auto_refund !== false,
    supplement_needed: !!(refundCalc.supplement_info),
    settlement_rule_hit: refundCalc.rule_hit || null
  }});
});

// 三端状态拉取(现场核销简化版)
router.get('/reservation/:id/onsite-state', (req, res) => {
  const id = Number(req.params.id);
  const reservation = store.getById('reservation', id);
  if (!reservation) return res.json({ code: 404, message: '预约不存在' });

  const ticket = store.getById('picking_ticket', reservation.ticket_id);
  const slot = store.getById('time_slot', reservation.slot_id);
  const entry = store.findOne('entry_record', e => e.reservation_id === id && e.entry_status !== 'LEFT');
  const batches = store.find('batch_entry', b => b.reservation_id === id);
  const family = store.find('family_member', f => f.reservation_id === id);
  const extra = store.findOne('on_site_extra', o => o.reservation_id === id);
  const addons = store.find('addon_order', a => a.reservation_id === id);

  const checkedIn = family.filter(f => f.checkin_status === 'CHECKED_IN').length;
  const inGarden = batches.filter(b => b.entry_status === 'IN_GARDEN');

  res.json({ code: 0, data: {
    reservation: {
      id: reservation.id,
      reservation_no: reservation.reservation_no,
      status: reservation.status,
      visitor_name: reservation.visitor_name,
      visitor_phone: reservation.visitor_phone,
      group_size: reservation.group_size,
      estimated_weight: reservation.estimated_weight,
      included_weight: reservation.included_weight,
      extra_weight_limit: reservation.extra_weight_limit,
      deposit_amount: reservation.deposit_amount
    },
    ticket: ticket ? {
      ticket_code: ticket.ticket_code,
      ticket_name: ticket.ticket_name,
      ticket_type: ticket.ticket_type,
      extra_price_per_kg: ticket.extra_price_per_kg
    } : null,
    slot: slot ? {
      slot_date: slot.slot_date,
      slot_label: slot.slot_label,
      status: slot.status,
      limit_reason: slot.limit_reason
    } : null,
    entry: entry ? {
      entry_no: entry.entry_no,
      entry_status: entry.entry_status,
      entry_time: entry.entry_time,
      actual_picked_weight: entry.actual_picked_weight,
      picking_progress: entry.picking_progress,
      is_batch_entry: entry.is_batch_entry
    } : null,
    batch: {
      total_batches: batches.length,
      in_garden_batches: inGarden.length,
      in_garden_count: inGarden.reduce((s, b) => s + b.batch_count, 0),
      batches
    },
    family: {
      total: family.length,
      checked_in: checkedIn,
      arrival_rate: family.length > 0 ? checkedIn / family.length : null,
      list: family
    },
    extras: extra ? {
      addon_cost: extra.addon_cost,
      extra_weight_charge: extra.extra_weight_charge,
      damage_charge: extra.damage_charge,
      total: Math.round((extra.addon_cost + extra.extra_weight_charge + extra.damage_charge) * 100) / 100
    } : null,
    addons: addons.map(a => ({
      addon_order_no: a.addon_order_no,
      items: JSON.parse(a.items || '[]'),
      total_amount: a.total_amount,
      payment_status: a.payment_status,
      source: a.source
    }))
  }});
});

module.exports = router;
